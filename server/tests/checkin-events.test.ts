import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, diffDays } from '@shared/time'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { rebuildProjection } from '../events/rebuild.js'
import {
  CHECKIN_ARRIVED_TYPE,
  CHECKIN_LEFT_TYPE,
  checkinPayloadSchema,
} from '../events/definitions/checkin.js'
import { ANCHOR_TYPE, REVOKE_TYPE } from '../events/definitions/system.js'
import type { Event, EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'

/**
 * 打卡事件与投影（ADR-012 §1/§2/§5）。
 *
 * 这一组只看**事件层**：载荷契约、折叠语义、`days` 表与重放的一致性、
 * 以及与两条边界（覆盖面锚点 ADR-004 / 撤销 ADR-006）的相互作用。
 * 路由契约与配对规则在 `checkin-api.test.ts` / `checkin-service.test.ts`。
 *
 * 每个用例用**全新账号**，互不干扰。
 */

let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-checkin-events-'))
  db = openMigratedDatabase(path.join(dir, 'app.db'))
})

afterAll(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function freshAccount(): string {
  seq += 1
  const id = `u-${seq}`
  insertUser(db, {
    id,
    username: `user${seq}`,
    displayName: `用户${seq}`,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-22T10:00:00+08:00',
  })
  return id
}

/** 递增的合法 UUIDv7 字面量：边界测试需要「谁在谁之前」是确定的 */
function nextId(): string {
  seq += 1
  return `${seq.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`
}

function nextBatchId(): string {
  return nextId()
}

function inTx<T>(fn: () => T): T {
  return db.transaction(fn)()
}

function append(accountId: string, drafts: EventDraft[]): Event[] {
  return inTx(() => appendEvents(db, accountId, drafts))
}

/** 一次到达：`dayKey` 由调用方给出（路由层用 `toDayKey` 折算，见 service） */
function arrivedDraft(dayKey: string, occurredAt: string, extra: Partial<EventDraft> = {}): EventDraft {
  return {
    type: CHECKIN_ARRIVED_TYPE,
    occurredAt,
    payload: {},
    dayKey,
    dayStartHour: 4,
    ...extra,
  }
}

function leftDraft(dayKey: string, occurredAt: string, extra: Partial<EventDraft> = {}): EventDraft {
  return {
    type: CHECKIN_LEFT_TYPE,
    occurredAt,
    payload: {},
    dayKey,
    dayStartHour: 4,
    ...extra,
  }
}

function days(accountId: string) {
  return readProjection(db, accountId).days
}

describe('事件定义（ADR-012 §1）', () => {
  it('载荷是空对象：`{}` 通过，多一个字段即拒绝', () => {
    expect(checkinPayloadSchema.safeParse({}).success).toBe(true)
    expect(checkinPayloadSchema.safeParse({ time: '2026-09-22T09:00:00+08:00' }).success).toBe(false)
    expect(checkinPayloadSchema.safeParse(null).success).toBe(false)
    expect(checkinPayloadSchema.safeParse(undefined).success).toBe(false)
  })

  it('多给字段的草稿一个字都不写（整批校验先行，ADR-010 §3）', () => {
    const account = freshAccount()
    expect(() =>
      append(account, [
        {
          type: CHECKIN_ARRIVED_TYPE,
          occurredAt: '2026-09-22T09:00:00+08:00',
          // 载荷里放时刻 = 第二个真相（行上已有 occurred_at），必须被拒
          payload: { occurredAt: '2026-09-22T09:00:00+08:00' },
        },
      ]),
    ).toThrow(/载荷不合法/)
    expect(readAccountEvents(db, account)).toHaveLength(0)
    expect(days(account)).toHaveLength(0)
  })

  it('两类事件都不写 target 两列（打卡不针对特定对象，ADR-010 §1）', () => {
    const account = freshAccount()
    append(account, [arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00')])
    const [event] = readAccountEvents(db, account)
    expect(event!.targetKind).toBeNull()
    expect(event!.targetId).toBeNull()
  })
})

describe('折叠语义（ADR-012 §2/§5）', () => {
  it('到达建行：arrived_at 取事件时刻，left_at 为空（无离开 = 时长未知）', () => {
    const account = freshAccount()
    append(account, [arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00')])

    expect(days(account)).toEqual([
      {
        accountId: account,
        dayKey: '2026-09-22',
        arrivedAt: '2026-09-22T09:00:00+08:00',
        leftAt: null,
      },
    ])
  })

  it('离开闭合它记在的那一行——**行由事件的 day_key 决定，与 occurred_at 无关**', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T23:00:00+08:00'),
      // 次日凌晨的离开，但归属日仍是 D（ADR-012 §5：记在所闭合到达的那一天）
      leftDraft('2026-09-22', '2026-09-23T05:00:00+08:00'),
    ])

    const rows = days(account)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dayKey).toBe('2026-09-22')
    expect(rows[0]!.leftAt).toBe('2026-09-23T05:00:00+08:00')
    // 23:00 → 05:00 是一次 6 小时的到访，不是「D 日无离开 + D+1 日无到达」
    expect(diffDays('2026-09-22', '2026-09-23')).toBe(1)
    expect(Date.parse(rows[0]!.leftAt!) - Date.parse(rows[0]!.arrivedAt)).toBe(6 * 60 * 60 * 1000)
  })

  it('没有到达的日子**不会**因为一条离开而建行（§2 的结构约束）', () => {
    const account = freshAccount()
    append(account, [leftDraft('2026-09-22', '2026-09-22T18:00:00+08:00')])

    // 「有离开、无到达」的行**表达不出来**（arrived_at NOT NULL，且 left 不建行），
    // 于是「无行 ⇔ 无到达」恒成立——FR1 的「无到达记录 = 休息日」由此直接成立。
    expect(days(account)).toHaveLength(0)
  })

  it('同一归属日两条到达：按 id 序后者胜，且 left_at 被清空（新的到达 = 新的到访）', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00', { id: nextId() }),
      leftDraft('2026-09-22', '2026-09-22T12:00:00+08:00', { id: nextId() }),
      arrivedDraft('2026-09-22', '2026-09-22T20:00:00+08:00', { id: nextId() }),
    ])

    const rows = days(account)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.arrivedAt).toBe('2026-09-22T20:00:00+08:00')
    // 留着上一条离开会得到 left_at < arrived_at 这种不可能的行
    expect(rows[0]!.leftAt).toBeNull()
  })

  it('多账号隔离：同一天各自一行，互不可见', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    append(alice, [arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00')])
    append(bob, [arrivedDraft('2026-09-22', '2026-09-22T10:00:00+08:00')])

    expect(days(alice).map((row) => [row.accountId, row.arrivedAt])).toEqual([
      [alice, '2026-09-22T09:00:00+08:00'],
    ])
    expect(days(bob).map((row) => [row.accountId, row.arrivedAt])).toEqual([
      [bob, '2026-09-22T10:00:00+08:00'],
    ])
    // 各账号只出现在自己的行里（project() 的单账号不变量同理）
    expect(readProjection(db, alice).days.every((row) => row.accountId === alice)).toBe(true)
  })
})

describe('与两条边界的关系（ADR-004 覆盖面 / ADR-006 撤销）', () => {
  it('覆盖面锚点之前的到达不参与折叠 → 没有行（打卡同样受覆盖面约束）', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00', { id: '00000001-0000-7000-8000-000000000000' }),
    ])
    expect(days(account)).toHaveLength(1)

    append(account, [
      {
        type: ANCHOR_TYPE,
        occurredAt: '2026-09-23T09:00:00+08:00',
        id: '00000002-0000-7000-8000-000000000000',
        payload: { sourceFile: 'export.json', overwrittenCount: 1, previousHeadId: null },
      },
    ])

    // 锚点把自己与它之前的一切划到线外（ADR-004）：事件物理保留，投影里不再有这一天
    expect(readAccountEvents(db, account)).toHaveLength(2)
    expect(days(account)).toHaveLength(0)
    rebuildProjection(db, account)
    expect(days(account)).toHaveLength(0)
  })

  it('被撤销批次里的到达与离开都不参与折叠 → 没有行', () => {
    const account = freshAccount()
    const batch = nextBatchId()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00', { id: nextId(), batchId: batch }),
      leftDraft('2026-09-22', '2026-09-22T12:00:00+08:00', { id: nextId(), batchId: batch }),
    ])
    expect(days(account)).toHaveLength(1)

    // 撤销**是边界事件**，增量路径必须退化为全量重建（append.ts 的 classifyMaintenance）
    append(account, [
      {
        type: REVOKE_TYPE,
        occurredAt: '2026-09-23T09:00:00+08:00',
        payload: { targetBatchId: batch, reason: '记错了' },
      },
    ])

    expect(readAccountEvents(db, account)).toHaveLength(3)
    expect(days(account)).toHaveLength(0)
  })

  it('撤销的是「当天的那次到达」时，同一天的另一条到达仍然成立', () => {
    const account = freshAccount()
    const revoked = nextBatchId()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00', { id: nextId(), batchId: revoked }),
    ])
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T10:00:00+08:00', { id: nextId() }),
    ])
    expect(days(account)[0]!.arrivedAt).toBe('2026-09-22T10:00:00+08:00')

    append(account, [
      {
        type: REVOKE_TYPE,
        occurredAt: '2026-09-23T09:00:00+08:00',
        payload: { targetBatchId: revoked },
      },
    ])

    // 被撤销的那条消失，剩下那条成为当天唯一（且仍是「有到达的行」）
    expect(days(account).map((row) => row.arrivedAt)).toEqual(['2026-09-22T10:00:00+08:00'])
  })
})

describe('表 = 重放（ADR-002 §2 / ADR-010 §5）', () => {
  it('增量维护后的 days 与 project() 的结果逐字段一致', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00'),
      leftDraft('2026-09-22', '2026-09-22T12:00:00+08:00'),
      arrivedDraft('2026-09-23', '2026-09-23T08:00:00+08:00'),
    ])

    expect(readProjection(db, account).days).toEqual(project(readAccountEvents(db, account)).days)
    expect(days(account).map((row) => row.dayKey)).toEqual(['2026-09-22', '2026-09-23'])
  })

  it('★ 增量结果 == 全量重建结果（days 也在 ADR-010 §5 的断言范围内）', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-23', '2026-09-23T08:00:00+08:00'),
      arrivedDraft('2026-09-21', '2026-09-21T08:00:00+08:00'),
      leftDraft('2026-09-21', '2026-09-21T18:00:00+08:00'),
      arrivedDraft('2026-09-22', '2026-09-22T08:00:00+08:00'),
    ])

    const incremental = readProjection(db, account)
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
    // 升序是规范化的一部分：折叠顺序是事件 id 序，与 dayKey 序并不相同
    expect(incremental.days.map((row) => row.dayKey)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
    ])
    expect(incremental.days.map((row) => row.dayKey)).toEqual(
      [...incremental.days.map((row) => row.dayKey)].sort(),
    )
  })

  it('days 可丢弃、可重建：删掉表内容后 rebuild 从事件建回来', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00'),
      leftDraft('2026-09-22', '2026-09-22T12:00:00+08:00'),
    ])
    const before = days(account)

    db.prepare('DELETE FROM days WHERE account_id = ?').run(account)
    expect(days(account)).toHaveLength(0)

    rebuildProjection(db, account)
    expect(days(account)).toEqual(before)
  })

  it('重建后不再存在的行不会被留在表里（表内容 = 投影对象的函数）', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00', { id: nextId() }),
    ])
    // 手工往投影表里塞一行「没有到达依据」的历史遗留（模拟旧版本留下的脏行）
    db.prepare(
      "INSERT INTO days (account_id, day_key, arrived_at, left_at) VALUES (?, '2026-01-01', '2026-01-01T09:00:00+08:00', NULL)",
    ).run(account)
    expect(days(account)).toHaveLength(2)

    rebuildProjection(db, account)

    expect(days(account).map((row) => row.dayKey)).toEqual(['2026-09-22'])
  })

  it('倒序补写（id 小于流水末端）走的是全量重建，结果仍与重放一致', () => {
    const account = freshAccount()
    append(account, [
      arrivedDraft('2026-09-23', '2026-09-23T09:00:00+08:00', { id: '00000009-0000-7000-8000-000000000000' }),
    ])
    // 合并导入的形态：更早的事件（更小的 id）落在流水末尾
    append(account, [
      arrivedDraft('2026-09-22', '2026-09-22T09:00:00+08:00', { id: '00000003-0000-7000-8000-000000000000' }),
    ])

    expect(days(account).map((row) => row.dayKey)).toEqual(['2026-09-22', '2026-09-23'])
    expect(readProjection(db, account).days).toEqual(project(readAccountEvents(db, account)).days)
  })

  it('addDays 的日期运算没有被本模块重新发明（升序断言用同一把尺）', () => {
    // 一条不变量式的自检：dayKey 升序 == 日历升序（用 shared/time 的 addDays 生成相邻日）
    const account = freshAccount()
    const base = '2026-02-27'
    append(account, [
      arrivedDraft(addDays(base, 0), `${addDays(base, 0)}T09:00:00+08:00`),
      arrivedDraft(addDays(base, 1), `${addDays(base, 1)}T09:00:00+08:00`),
      arrivedDraft(addDays(base, 2), `${addDays(base, 2)}T09:00:00+08:00`),
    ])
    expect(days(account).map((row) => row.dayKey)).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ])
  })
})
