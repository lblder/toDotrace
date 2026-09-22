import type { Db } from '../db/connection.js'
import type { DayKey } from '@shared/time'
import { REVOKE_TYPE } from './definitions/system.js'
import type { Event } from './types.js'

/**
 * `events` 表的读写（ADR-010 §1）。
 *
 * 本文件**只碰事件表**，不碰任何投影表——投影表由 `projection-store.ts` 独占，
 * 那条纪律由 `server/tests/events-discipline.test.ts` 静态核对。
 *
 * 排序：读取一律 `ORDER BY id`（**不用 rowid、不用插入顺序**）。该顺序只是便于阅读，
 * 权威排序在 `project()` 内部（ADR-010 §4 第 2 步）——两者用同一把键，故结果一致。
 */

interface EventRow {
  id: string
  account_id: string
  type: string
  occurred_at: string
  timezone: string
  day_key: string
  day_start_hour: number
  target_kind: string | null
  target_id: string | null
  batch_id: string
  payload: string
  appended_at: string
}

const COLUMNS = `
  id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
  target_kind, target_id, batch_id, payload, appended_at
`

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    occurredAt: row.occurred_at,
    timezone: row.timezone,
    dayKey: row.day_key as DayKey,
    dayStartHour: row.day_start_hour,
    targetKind: row.target_kind,
    targetId: row.target_id,
    batchId: row.batch_id,
    // 载荷在写入时已由 EventDefinition.schema 校验；此处解析失败即数据被外力损坏，
    // 抛错优于让一条畸形事件静默参与折叠。
    payload: JSON.parse(row.payload) as unknown,
    appendedAt: row.appended_at,
  }
}

/** 某账号的全部事件（按 id 升序）。全量重放的入口。 */
export function readAccountEvents(db: Db, accountId: string): Event[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM events WHERE account_id = ? ORDER BY id`)
    .all(accountId) as EventRow[]
  return rows.map(rowToEvent)
}

/** 按 id 取一条事件；不存在返回 undefined。 */
export function findEvent(db: Db, accountId: string, id: string): Event | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM events WHERE account_id = ? AND id = ?`)
    .get(accountId, id) as EventRow | undefined
  return row === undefined ? undefined : rowToEvent(row)
}

/**
 * 该账号当前的最大事件 id（空流水返回 null）。
 * 增量投影路径用它判断「这次追加是不是尾部追加」——不是尾部就必须全量重建，
 * 理由见 `append.ts`。
 */
export function readMaxEventId(db: Db, accountId: string): string | null {
  const row = db
    .prepare(`SELECT id FROM events WHERE account_id = ? ORDER BY id DESC LIMIT 1`)
    .get(accountId) as { id: string } | undefined
  return row?.id ?? null
}

/** 该账号全部 `system/revoke` 事件的载荷目标批次集合。 */
export function readRevokedBatchIds(db: Db, accountId: string): Set<string> {
  const rows = db
    .prepare(`SELECT payload FROM events WHERE account_id = ? AND type = ?`)
    .all(accountId, REVOKE_TYPE) as { payload: string }[]
  const revoked = new Set<string>()
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { targetBatchId?: unknown }
    if (typeof payload?.targetBatchId === 'string') revoked.add(payload.targetBatchId)
  }
  return revoked
}

function eventParams(event: Event): unknown[] {
  return [
    event.id,
    event.accountId,
    event.type,
    event.occurredAt,
    event.timezone,
    event.dayKey,
    event.dayStartHour,
    event.targetKind,
    event.targetId,
    event.batchId,
    JSON.stringify(event.payload),
    event.appendedAt,
  ]
}

const INSERT_SQL = `
  INSERT INTO events (
    id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
    target_kind, target_id, batch_id, payload, appended_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

/**
 * 批量写入事件。**调用方保证全部 id 在账号内不存在**（重复判定在 `append.ts`），
 * 因此这里是纯 INSERT —— 主键冲突会当场抛出，不会被 `OR IGNORE` 吞掉。
 */
export function insertEvents(db: Db, events: readonly Event[]): void {
  const statement = db.prepare(INSERT_SQL)
  for (const event of events) {
    statement.run(...eventParams(event))
  }
}
