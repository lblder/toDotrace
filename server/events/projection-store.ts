import type { Db } from '../db/connection.js'
import type { DayKey } from '@shared/time'
import type { NextAnchorMode, RecurrenceRule } from '@shared/recurrence'
import type { Step } from '@shared/tasks/types'
import { assertInTransaction } from './transaction.js'
import type {
  AccountSettings,
  ProjectedDay,
  ProjectedDayNote,
  ProjectedProject,
  ProjectedTask,
  Projection,
} from './types.js'

/**
 * 投影表的读写——**本文件是全仓唯一写投影表的地方**（ADR-010「约束」）。
 *
 * 「任何模块不得直接写投影表——只能经由事件追加（`rebuild` 除外）」这条纪律
 * 由 `server/tests/events-discipline.test.ts` 静态核对：它**从 `schema.ts` 的 DDL 里
 * 自动发现表名**（不再是一份硬编码清单——那正是它此前漏掉 `tasks` / `projects` /
 * `day_notes` 的原因），再扫描 `shared/` / `server/` / `src/` 下出现
 * `INSERT/UPDATE/DELETE ... <表名>` 的文件。
 *
 * 五张投影表都在这里：`tasks`（ADR-013 §5，**取代 `recurrence_templates`**）、
 * `projects`（ADR-016 §6）、`day_notes`（ADR-017 §6）、`settings`（ADR-010 §6）
 * 与 `days`（ADR-012 §2）。它们的**唯一**来源各自是事件（`task/*`、`project/*`、
 * `note/updated`、`settings/updated`、`checkin/*`）——ADR-010 §7 明文把
 * 「违反约束直接 UPDATE」列为错误路径。
 *
 * 写入策略是**整账号替换**（DELETE 后按投影对象重新 INSERT）。理由：
 * `EventDefinition.apply(projection, event): void` 不返回「改了什么」，
 * 核心无从知道该更新哪一行——而 ADR-010 §5 禁止的只是「每次写入都全量**重放**」，
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
  breaks_json: string
}

interface TaskRow {
  id: string
  account_id: string
  title: string
  notes: string
  importance: string
  planned_date: string | null
  planned_week: string | null
  due_date: string | null
  tags_json: string
  project_id: string | null
  status: string
  manual_order: number | null
  steps_json: string
  index_date: string
  recurrence_json: string | null
  next_anchor_mode: string | null
  starts_on: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

interface ProjectRow {
  id: string
  account_id: string
  name: string
  starts_on: string
  ends_on: string
  is_current: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

interface DayNoteRow {
  account_id: string
  day_key: string
  text: string
  updated_at: string
}

/**
 * 投影表 → 内存投影。**每个数组的行序都与 `canonicalizeProjection` 的规范化顺序一致**
 * （`tasks` / `projects` 按 `id` 升序、`days` / `dayNotes` 按 `day_key` 升序）：
 * 行序由 SQL 保证，但投影的顺序以 `canonicalizeProjection` 为准——
 * 两条路径（读表 / 重放）必须给出同一个数组顺序，否则 ADR-010 §5 的
 * 「增量 == 全量」无法逐字段断言。
 */
export function readProjection(db: Db, accountId: string): Projection {
  return {
    tasks: readTaskRows(db, accountId),
    projects: readProjectRows(db, accountId),
    settings: readSettingsRow(db, accountId),
    days: readDayRows(db, accountId),
    dayNotes: readDayNoteRows(db, accountId),
  }
}

/** 读某账号的全部任务，按 `id` 升序。 */
export function readTaskRows(db: Db, accountId: string): ProjectedTask[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, title, notes, importance, planned_date, planned_week, due_date,
              tags_json, project_id, status, manual_order, steps_json, index_date,
              recurrence_json, next_anchor_mode, starts_on, deleted_at, created_at, updated_at
         FROM tasks WHERE account_id = ? ORDER BY id`,
    )
    .all(accountId) as TaskRow[]

  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    notes: row.notes,
    importance: row.importance as ProjectedTask['importance'],
    plannedDate: row.planned_date as DayKey | null,
    plannedWeek: row.planned_week as DayKey | null,
    dueDate: row.due_date as DayKey | null,
    tags: JSON.parse(row.tags_json) as string[],
    projectId: row.project_id,
    status: row.status as ProjectedTask['status'],
    manualOrder: row.manual_order,
    // `recurrence_json` 与 `next_anchor_mode` / `starts_on` **三列同生共死**
    // （表侧有两条 CHECK 兜底）。故非重复任务读回来就是一个干净的 `null`，
    // 不存在「有规则没锚点」这种半截形态。
    recurrence:
      row.recurrence_json === null
        ? null
        : {
            rule: JSON.parse(row.recurrence_json) as RecurrenceRule,
            nextAnchorMode: row.next_anchor_mode as NextAnchorMode,
            startsOn: row.starts_on as DayKey,
          },
    deletedAt: row.deleted_at,
    indexDate: row.index_date as DayKey,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // `steps_json` **只装步骤定义**（`Step { id, title }`）：勾选属于某一轮实例，
    // 由 `task/step-toggled` 事件固化、从事件折叠得出，不进表（ADR-013 §4.12）。
    steps: JSON.parse(row.steps_json) as Step[],
  }))
}

/** 读某账号的全部项目（**含已软删除的**），按 `id` 升序。 */
export function readProjectRows(db: Db, accountId: string): ProjectedProject[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, name, starts_on, ends_on, is_current, deleted_at, created_at, updated_at
         FROM projects WHERE account_id = ? ORDER BY id`,
    )
    .all(accountId) as ProjectRow[]

  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    startsOn: row.starts_on as DayKey,
    endsOn: row.ends_on as DayKey,
    isCurrent: row.is_current === 1,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

/** 读某账号的全部每日备注，按 `day_key` 升序。空串不出现在这里（空串即清除）。 */
export function readDayNoteRows(db: Db, accountId: string): ProjectedDayNote[] {
  const rows = db
    .prepare(
      'SELECT account_id, day_key, text, updated_at FROM day_notes WHERE account_id = ? ORDER BY day_key',
    )
    .all(accountId) as DayNoteRow[]

  return rows.map((row) => ({
    accountId: row.account_id,
    dayKey: row.day_key as DayKey,
    text: row.text,
    updatedAt: row.updated_at,
  }))
}

/**
 * 读某账号的全部打卡日，**按 `day_key` 升序**（与 `canonicalizeProjection` 的规范化顺序一致）。
 *
 * 顺带满足 ADR-012 §6 对 `dayKeys` 的前置条件（「已升序、已去重」）：
 * `shared/checkin` 的三个函数吃的就是这个数组映射出的 `dayKey` 列表。
 */
export function readDayRows(db: Db, accountId: string): ProjectedDay[] {
  const rows = db
    .prepare(
      'SELECT account_id, day_key, arrived_at, left_at, breaks_json FROM days WHERE account_id = ? ORDER BY day_key',
    )
    .all(accountId) as DayRow[]

  return rows.map((row) => ({
    accountId: row.account_id,
    dayKey: row.day_key as DayKey,
    arrivedAt: row.arrived_at,
    leftAt: row.left_at,
    ...(row.breaks_json === '[]' ? {} : { breaks: JSON.parse(row.breaks_json) as NonNullable<ProjectedDay['breaks']> }),
  }))
}

/**
 * 读 `settings` 行；**缺行返回 `null` 而不是默认值**——「库里说了什么」与
 * 「缺省时用什么」是两件事，后者是 `settings.ts` 的回落策略。
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
 * `settings` 与其余投影走**同一条**「表内容 = 投影对象的函数」的恒等式，没有例外：
 * 它们全都可由事件重放得出，于是「清空重写」对它们都成立——`settings` 为 `null`、
 * `dayNotes` 里没有某一天，写库即删行。
 */
export function writeProjection(db: Db, accountId: string, projection: Projection): void {
  assertInTransaction(db, '投影写入')
  clearProjection(db, accountId)

  writeTaskRows(db, accountId, projection.tasks)
  writeProjectRows(db, accountId, projection.projects)

  const settings = projection.settings
  if (settings !== null) {
    if (settings.accountId !== accountId) throw crossAccount('设置', accountId, settings.accountId)
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

  writeDayRows(db, accountId, projection.days)
  writeDayNoteRows(db, accountId, projection.dayNotes)
}

function writeTaskRows(db: Db, accountId: string, tasks: readonly ProjectedTask[]): void {
  const insert = db.prepare(
    `INSERT INTO tasks
       (id, account_id, title, notes, importance, planned_date, planned_week, due_date,
        tags_json, project_id, status, manual_order, steps_json, index_date,
        recurrence_json, next_anchor_mode, starts_on, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const task of tasks) {
    if (task.accountId !== accountId) throw crossAccount(`任务 '${task.id}'`, accountId, task.accountId)
    if (task.recurrence !== null && planAnchorsOf(task).length > 0) {
      // 表侧有 CHECK 兜底，但那条 CHECK 的报错只说明「某一列不合法」；
      // 这里先说清**是哪条任务的哪个锚点**，让绕过了载荷守卫的写入当场可见。
      throw new Error(
        `任务 '${task.id}'（账号 '${accountId}'）是重复任务，却带着日期锚点 ` +
          `（${planAnchorsOf(task).join(' / ')}）：重复任务的日期由规则唯一决定，` +
          '任务行上再存一个必然与当前轮次分叉（ADR-013 §3.1）。',
      )
    }
    insert.run(
      task.id,
      accountId,
      task.title,
      task.notes,
      task.importance,
      task.plannedDate,
      task.plannedWeek,
      task.dueDate,
      JSON.stringify(task.tags),
      task.projectId,
      task.status,
      task.manualOrder,
      JSON.stringify(task.steps),
      task.indexDate,
      task.recurrence === null ? null : JSON.stringify(task.recurrence.rule),
      task.recurrence === null ? null : task.recurrence.nextAnchorMode,
      task.recurrence === null ? null : task.recurrence.startsOn,
      task.deletedAt,
      task.createdAt,
      task.updatedAt,
    )
  }
}

/** 非空的日期锚点（用于上面那条「重复任务不得带锚点」的断言，报错信息里列出字段名）。 */
function planAnchorsOf(task: ProjectedTask): string[] {
  const anchors: string[] = []
  if (task.plannedDate !== null) anchors.push('plannedDate')
  if (task.plannedWeek !== null) anchors.push('plannedWeek')
  if (task.dueDate !== null) anchors.push('dueDate')
  return anchors
}

function writeProjectRows(db: Db, accountId: string, projects: readonly ProjectedProject[]): void {
  const insert = db.prepare(
    `INSERT INTO projects
       (id, account_id, name, starts_on, ends_on, is_current, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const project of projects) {
    if (project.accountId !== accountId) {
      throw crossAccount(`项目 '${project.id}'`, accountId, project.accountId)
    }
    insert.run(
      project.id,
      accountId,
      project.name,
      project.startsOn,
      project.endsOn,
      project.isCurrent ? 1 : 0,
      project.deletedAt,
      project.createdAt,
      project.updatedAt,
    )
  }
}

function writeDayRows(db: Db, accountId: string, days: readonly ProjectedDay[]): void {
  const insertDay = db.prepare(
    'INSERT INTO days (account_id, day_key, arrived_at, left_at, breaks_json) VALUES (?, ?, ?, ?, ?)',
  )
  for (const day of days) {
    if (day.accountId !== accountId) {
      throw crossAccount(`打卡日 '${day.dayKey}'`, accountId, day.accountId)
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
    insertDay.run(accountId, day.dayKey, day.arrivedAt, day.leftAt, JSON.stringify(day.breaks ?? []))
  }
}

function writeDayNoteRows(db: Db, accountId: string, notes: readonly ProjectedDayNote[]): void {
  const insertNote = db.prepare(
    'INSERT INTO day_notes (account_id, day_key, text, updated_at) VALUES (?, ?, ?, ?)',
  )
  for (const note of notes) {
    if (note.accountId !== accountId) {
      throw crossAccount(`每日备注 '${note.dayKey}'`, accountId, note.accountId)
    }
    if (note.text === '') {
      // 与 `days.arrived_at` 上那条断言同级：空串在语义上就是「没有备注」，
      // 而 `day_notes` 里存一行空串会让「有没有备注」出现两种表示
      // （无行 / 空串行），读的人得两处都判。ADR-017 §6 已把空串定为**清除**。
      throw new Error(
        `每日备注 '${note.dayKey}'（账号 '${accountId}'）是空串：` +
          '空串即清除，投影里不该有这一行（ADR-017 §6）。',
      )
    }
    insertNote.run(accountId, note.dayKey, note.text, note.updatedAt)
  }
}

function crossAccount(what: string, accountId: string, owner: string): Error {
  return new Error(
    `投影中的${what}属于账号 '${owner}'，不能写进账号 '${accountId}' 的投影表（跨账号写入）。`,
  )
}

/** 清空某账号的投影行（`rebuildProjection` 的第一步；五张表一并清）。 */
export function clearProjection(db: Db, accountId: string): void {
  db.prepare('DELETE FROM tasks WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM projects WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM settings WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM days WHERE account_id = ?').run(accountId)
  db.prepare('DELETE FROM day_notes WHERE account_id = ?').run(accountId)
}

/** 任务行数（测试与自检用；不参与重放） */
export function countProjectedTasks(db: Db, accountId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE account_id = ?').get(accountId) as {
    n: number
  }
  return row.n
}

/** 项目行数（测试与自检用；不参与重放） */
export function countProjectedProjects(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE account_id = ?')
    .get(accountId) as { n: number }
  return row.n
}

/** 每日备注行数（测试与自检用；不参与重放） */
export function countProjectedDayNotes(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM day_notes WHERE account_id = ?')
    .get(accountId) as { n: number }
  return row.n
}
