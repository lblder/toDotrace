import type { Db } from '../db/connection.js'
import type { DayKey } from '@shared/time'
import { assertInTransaction } from './transaction.js'
import type { AccountSettings, NextAnchorMode, Projection, RecurrenceRule } from './types.js'

/**
 * 投影表的读写——**本文件是全仓唯一写投影表的地方**（ADR-010「约束」）。
 *
 * 「任何模块不得直接写投影表——只能经由事件追加（`rebuild` 除外）」这条纪律
 * 由 `server/tests/events-discipline.test.ts` 静态核对：它扫描 `server/` 下
 * 除本文件以外的所有源码，出现 `INSERT/UPDATE/DELETE ... recurrence_templates`
 * 或 `... settings` 即失败。
 *
 * 两张投影表都在这里：`recurrence_templates`（ADR-011 §1）与 `settings`（ADR-010 §6）。
 * 后者的**唯一**来源是 `settings/updated` 事件——§7 明文把「违反约束直接 UPDATE」列为错误路径。
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
  }
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
  if (settings === null) return // 已由 clearProjection 删净
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

/** 清空某账号的投影行（`rebuildProjection` 的第一步；模板与设置一并清）。 */
export function clearProjection(db: Db, accountId: string): void {
  db.prepare('DELETE FROM recurrence_templates WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM settings WHERE account_id = ?').run(accountId)
}

/** 模板行数（测试与自检用；不参与重放） */
export function countProjectedTemplates(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM recurrence_templates WHERE account_id = ?')
    .get(accountId) as { n: number }
  return row.n
}
