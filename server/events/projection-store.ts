import type { Db } from '../db/connection.js'
import type { DayKey } from '@shared/time'
import { assertInTransaction } from './transaction.js'
import type { AccountSettings, NextAnchorMode, ProjectedDay, Projection, RecurrenceRule } from './types.js'

/**
 * 投影表的读写——**本文件是全仓唯一写投影表的地方**（ADR-010「约束」）。
 *
 * 「任何模块不得直接写投影表——只能经由事件追加（`rebuild` 除外）」这条纪律
 * 由 `server/tests/events-discipline.test.ts` 静态核对：它扫描 `server/` 下
 * 除本文件以外的所有源码，出现 `INSERT/UPDATE/DELETE ... recurrence_templates`
 * 或 `... settings` 即失败。
 *
 * 三张投影表都在这里：`recurrence_templates`（ADR-011 §1）、`settings`（ADR-010 §6）
 * 与 `days`（ADR-012 §2）。后两者的**唯一**来源是 `settings/updated` 与
 * `checkin/arrived` / `checkin/left` 事件——ADR-010 §7 明文把「违反约束直接 UPDATE」
 * 列为错误路径，ADR-012 §4 又把这条纪律原样施加给打卡（「投影更新必须由事件层执行，
 * 路由不得绕过它直接写投影表」）。
 *
 * 写入策略是**整账号替换**（DELETE 后按投影对象重新 INSERT）。理由：
 * `EventDefinition.apply(projection, event): void` 不返回「改了什么」，
 * 核心无从知道该更新哪一行——而 §5 禁止的只是「每次写入都全量**重放**」，
 * 不是「重写行」。整账号替换让「表内容 = 投影对象的函数」成为恒等式，
 * 顺带使「增量结果 == 全量重建结果」这条断言在表级也成立。
 */

interface SettingsRow {
  account_id: string
  time_zone: string
  day_start_hour: number
  updated_at: string
}

interface DayRow {
  account_id: string
  day_key: string
  arrived_at: string
  left_at: string | null
}

interface TemplateRow {
  id: string
  account_id: string
  title: string
  rule_json: string
  next_anchor_mode: string
  starts_on: string
  created_at: string
  updated_at: string
}

/** 投影表 → 内存投影。行序按 `id` 升序，与 `project()` 的规范化顺序一致。 */
export function readProjection(db: Db, accountId: string): Projection {
  const rows = db
    .prepare(
      `SELECT id, account_id, title, rule_json, next_anchor_mode, starts_on, created_at, updated_at
         FROM recurrence_templates WHERE account_id = ? ORDER BY id`,
    )
    .all(accountId) as TemplateRow[]

  return {
    templates: rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      rule: JSON.parse(row.rule_json) as RecurrenceRule,
      nextAnchorMode: row.next_anchor_mode as NextAnchorMode,
      startsOn: row.starts_on as DayKey,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    settings: readSettingsRow(db, accountId),
    days: readDayRows(db, accountId),
  }
}

/**
 * 读某账号的全部打卡日，**按 `day_key` 升序**（与 `canonicalizeProjection` 的规范化顺序一致）。
 *
 * 行序由 SQL 保证，但投影的顺序以 `canonicalizeProjection` 为准——
 * 两条路径（读表 / 重放）必须给出同一个数组顺序，否则 ADR-010 §5 的
 * 「增量 == 全量」无法逐字段断言。
 */
export function readDayRows(db: Db, accountId: string): ProjectedDay[] {
  const rows = db
    .prepare(
      'SELECT account_id, day_key, arrived_at, left_at FROM days WHERE account_id = ? ORDER BY day_key',
    )
    .all(accountId) as DayRow[]

  return rows.map((row) => ({
    accountId: row.account_id,
    dayKey: row.day_key as DayKey,
    arrivedAt: row.arrived_at,
    leftAt: row.left_at,
  }))
}

/**
 * 读 `settings` 行；**缺行返回 `null` 而不是默认值**——「库里说了什么」与
 * 「缺省时用什么」是两件事，后者是 `settings.ts` 的回落策略。
 * 此前这里不存在，是因为没有任何事件能写出这一行；`settings/updated` 登记后它有了来源。
 */
export function readSettingsRow(db: Db, accountId: string): AccountSettings | null {
  const row = db
    .prepare('SELECT account_id, time_zone, day_start_hour, updated_at FROM settings WHERE account_id = ?')
    .get(accountId) as SettingsRow | undefined
  if (row === undefined) return null
  return {
    accountId: row.account_id,
    timeZone: row.time_zone,
    dayStartHour: row.day_start_hour,
    updatedAt: row.updated_at,
  }
}

/**
 * 内存投影 → 投影表（整账号替换）。
 *
 * `settings` 与模板走**同一条**「表内容 = 投影对象的函数」的恒等式，不再有例外：
 * 自 `settings/updated` 登记起，设置与模板一样可由事件重放得出（ADR-010 §6/§7），
 * 于是「清空重写」对它也成立——`null` 即「流水里没有这条设置事实」，写库即删行。
 * （此前 `settings` 被排除在外，是因为当时没有任何事件类型能重建它，
 * 清掉等于永久静默丢失时区；那个理由随本条事件的登记而消失。）
 */
export function writeProjection(db: Db, accountId: string, projection: Projection): void {
  assertInTransaction(db, '投影写入')
  clearProjection(db, accountId)

  const insert = db.prepare(
    `INSERT INTO recurrence_templates
       (id, account_id, title, rule_json, next_anchor_mode, starts_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const template of projection.templates) {
    if (template.accountId !== accountId) {
      throw new Error(
        `投影中的模板 '${template.id}' 属于账号 '${template.accountId}'，` +
          `不能写进账号 '${accountId}' 的投影表（跨账号写入）。`,
      )
    }
    insert.run(
      template.id,
      accountId,
      template.title,
      JSON.stringify(template.rule),
      template.nextAnchorMode,
      template.startsOn,
      template.createdAt,
      template.updatedAt,
    )
  }

  const settings = projection.settings
  if (settings !== null) {
    if (settings.accountId !== accountId) {
      throw new Error(
        `投影中的设置属于账号 '${settings.accountId}'，不能写进账号 '${accountId}' 的投影表（跨账号写入）。`,
      )
    }
    db.prepare(
      `INSERT INTO settings (account_id, time_zone, day_start_hour, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         time_zone = excluded.time_zone,
         day_start_hour = excluded.day_start_hour,
         updated_at = excluded.updated_at`,
    ).run(accountId, settings.timeZone, settings.dayStartHour, settings.updatedAt)
  }
  // settings 为 null 时无需动作：已由 clearProjection 删净（整账号替换）。

  const insertDay = db.prepare(
    'INSERT INTO days (account_id, day_key, arrived_at, left_at) VALUES (?, ?, ?, ?)',
  )
  for (const day of projection.days) {
    if (day.accountId !== accountId) {
      throw new Error(
        `投影中的打卡日 '${day.dayKey}' 属于账号 '${day.accountId}'，` +
          `不能写进账号 '${accountId}' 的投影表（跨账号写入）。`,
      )
    }
    if (typeof day.arrivedAt !== 'string' || day.arrivedAt.length === 0) {
      // `arrived_at` 的 NOT NULL 只挡得住 NULL，挡不住空串——而空串在语义上
      // 同样是「没有到达」，会当场推翻 ADR-012 §2 的「无行 ⇔ 无到达」
      // （那正是 §2 说的「用结构保证不变式」要堵死的形态）。
      // 这道断言与跨账号守卫同级：写在唯一的写入方，别处就没有绕过的机会。
      throw new Error(
        `打卡日 '${day.dayKey}'（账号 '${accountId}'）没有到达时刻，` +
          '不能写进投影表：每一行必有到达是 ADR-012 §2 的结构约束。',
      )
    }
    insertDay.run(accountId, day.dayKey, day.arrivedAt, day.leftAt)
  }
}

/** 清空某账号的投影行（`rebuildProjection` 的第一步；模板、设置、打卡日一并清）。 */
export function clearProjection(db: Db, accountId: string): void {
  db.prepare('DELETE FROM recurrence_templates WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM settings WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM days WHERE account_id = ?').run(accountId)
}

/** 模板行数（测试与自检用；不参与重放） */
export function countProjectedTemplates(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM recurrence_templates WHERE account_id = ?')
    .get(accountId) as { n: number }
  return row.n
}
