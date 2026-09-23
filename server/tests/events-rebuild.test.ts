import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DAY_START_HOUR } from '@shared/time'
import { openMigratedDatabase, type Db } from '../db/index.js'
import {
  appendEvents,
  loadAccountSettings,
  readAccountEvents,
  rebuildProjection,
  timeContextOf,
} from '../events/index.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { REVOKE_TYPE } from '../events/definitions/system.js'
import type { EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'

/**
 * 全量重建（ADR-010 §5）——「投影可丢弃、可重建」这条安全网的落点（ADR-002 §2）。
 *
 * 本文件的断言分两类：
 * 1. **表级相等**：重建后的库内容 == 增量维护后的库内容（ADR-010 §5 的核心不变式，
 *    也是「增量维护 == 全量重放」那条最有价值测试的库侧一半）；
 * 2. **投影表里没有不可重放的东西**：不是靠读代码判断，而是「把表清空再重建，
 *    内容必须一模一样」——任何无法由事件重放得出的字段都会在这里露馅。
 */

let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-rebuild-'))
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

function nextId(): string {
  seq += 1
  return `${seq.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`
}

function tid(account: string, name: string): string {
  return `${account}:${name}`
}

function inTx<T>(fn: () => T): T {
  return db.transaction(fn)()
}

/** 任务行的原始库内容——绕过内存对象直接比对，避免「对象相等但落库不同」。 */
function rawTasks(accountId: string): unknown[] {
  return db
    .prepare(
      `SELECT id, account_id, title, notes, importance, planned_date, planned_week, due_date,
              tags_json, project_id, status, manual_order, steps_json, index_date,
              recurrence_json, next_anchor_mode, starts_on, deleted_at, created_at, updated_at
         FROM tasks WHERE account_id = ? ORDER BY id`,
    )
    .all(accountId)
}

function createdDraft(taskId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'task/created',
    occurredAt: '2026-09-22T10:00:00+08:00',
    targetKind: 'task',
    targetId: taskId,
    batchId: nextId(),
    payload: {
      taskId,
      title,
      notes: '',
      importance: 'normal',
      plannedDate: null,
      plannedWeek: null,
      dueDate: null,
      tags: [],
      projectId: null,
      recurrence: null,
      steps: [],
    },
    ...overrides,
  }
}

function updatedDraft(taskId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'task/updated',
    occurredAt: '2026-09-23T10:00:00+08:00',
    targetKind: 'task',
    targetId: taskId,
    batchId: nextId(),
    payload: {
      taskId,
      title,
      notes: '',
      importance: 'normal',
      tags: [],
      projectId: null,
      recurrence: null,
    },
    ...overrides,
  }
}

function deletedDraft(taskId: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'task/deleted',
    occurredAt: '2026-09-24T10:00:00+08:00',
    targetKind: 'task',
    targetId: taskId,
    batchId: nextId(),
    payload: { taskId },
    ...overrides,
  }
}

function revokeDraft(targetBatchId: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: REVOKE_TYPE,
    occurredAt: '2026-09-25T10:00:00+08:00',
    payload: { targetBatchId },
    ...overrides,
  }
}

describe('重建是安全网，不是理论存在（ADR-002 §2 / ADR-010 §5）', () => {
  it('清空后重建，表内容与重建前逐字段一致（含增量维护出来的状态）', () => {
    const account = freshAccount()
    inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '喝水'),
        createdDraft(tid(account, 't2'), '复盘'),
      ]),
    )
    inTx(() => appendEvents(db, account, [updatedDraft(tid(account, 't1'), '喝水（改）')]))
    inTx(() => appendEvents(db, account, [deletedDraft(tid(account, 't2'))]))
    const before = rawTasks(account)
    // **软删除的行仍在**（ADR-013 §4.8）：删除不是「从表里消失」，而是一个列被置位。
    // 故这里是 2 行，且重建之后逐字段一致（包括那一列的取值）。
    expect(before).toHaveLength(2)

    rebuildProjection(db, account)
    expect(rawTasks(account)).toEqual(before)
  })

  it('重建结果 == project() 的结果（表与纯函数两条路径同源）', () => {
    const account = freshAccount()
    inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), 'A'),
        createdDraft(tid(account, 't2'), 'B'),
      ]),
    )
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(project(readAccountEvents(db, account)))
  })

  it('空流水重建 = 空投影（不是错误）', () => {
    const account = freshAccount()
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual({
      tasks: [],
      projects: [],
      settings: null,
      days: [],
      dayNotes: [],
    })
  })

  it('连跑两次结果不变（重建是幂等的）', () => {
    const account = freshAccount()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A')]))
    rebuildProjection(db, account)
    const first = rawTasks(account)
    rebuildProjection(db, account)
    expect(rawTasks(account)).toEqual(first)
  })

  it('可以在已开启的事务内调用（增量兜底就是这种用法）', () => {
    const account = freshAccount()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A')]))
    inTx(() => {
      rebuildProjection(db, account)
      expect(readProjection(db, account).tasks).toHaveLength(1)
    })
  })
})

describe('投影表里没有不可重放的东西（ADR-002 §2 硬约束）', () => {
  it('手工塞进去的、无法由事件重放得出的行，会被重建抹掉', () => {
    const account = freshAccount()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), '真实存在')]))
    // 模拟「某个模块绕过事件追加，自己往投影表里插了一行」
    db.prepare(
      `INSERT INTO tasks
         (id, account_id, title, notes, importance, planned_date, planned_week, due_date,
          tags_json, project_id, status, manual_order, steps_json, index_date,
          recurrence_json, next_anchor_mode, starts_on, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, '', 'normal', NULL, NULL, NULL,
               '[]', NULL, 'not_started', NULL, '[]', '2026-09-22',
               NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      tid(account, 'ghost'),
      account,
      '没有创建事件的行',
      '2026-09-22T10:00:00+08:00',
      '2026-09-22T10:00:00+08:00',
    )
    expect(rawTasks(account)).toHaveLength(2)

    rebuildProjection(db, account)
    // 只剩重放得出的那一行：表内容 = 事件的函数
    expect(rawTasks(account).map((row) => (row as { id: string }).id)).toEqual([
      tid(account, 't1'),
    ])
  })

  it('表的列集合就是「事件能重放出的那几项」，没有多余列', () => {
    const columns = (
      db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]
    ).map((column) => column.name)
    expect(columns.sort()).toEqual(
      [
        'account_id',
        'created_at',
        'deleted_at',
        'due_date',
        'id',
        'importance',
        'index_date',
        'manual_order',
        'next_anchor_mode',
        'notes',
        'planned_date',
        'planned_week',
        'project_id',
        'recurrence_json',
        'starts_on',
        'status',
        'steps_json',
        'tags_json',
        'title',
        'updated_at',
      ].sort(),
    )
    // **没有 carry_count 列**：顺延次数是派生量（`task/rescheduled` 事件的条数），
    // 落库就得在撤销时额外维护它，多一个会与事件分叉的地方（ADR-002 §2 / ADR-013 §4.3）。
    // 这条断言是「不落库」的结构性回归——谁把它加回去，这里第一个红。
    expect(columns).not.toContain('carry_count')
  })

  it('重建不碰 events 表：事件是不可变的（ADR-001 地基）', () => {
    const account = freshAccount()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A')]))
    const before = readAccountEvents(db, account)
    rebuildProjection(db, account)
    expect(readAccountEvents(db, account)).toEqual(before)
  })
})

/**
 * 边界事件之后的重建（ADR-004 / ADR-006 的库侧验证）。
 *
 * ⚠️ 本组里「撤销事件本身不可被撤销」是**刻意的**，不是缺口（ADR-006 §3 末）：
 * 覆盖面与撤销**共用「先扫描出待跳过集合、再 fold」的实现**，但**不得互相替代**。
 * 两者都只跳过、不删除；要恢复被撤销的批次，走「再执行一次该动作」或覆盖导入，
 * 而不是追加一条 revoke 去撤销那条 revoke——那条路通向无穷递归（ADR-006「约束」）。
 */
describe('边界事件之后的重建（ADR-004 / ADR-006 的库侧验证）', () => {
  it('被撤销批次的任务在重建后消失，其余保留', () => {
    const account = freshAccount()
    const doomed = inTx(() =>
      appendEvents(db, account, [createdDraft(tid(account, 't1'), '将被撤销')]),
    )[0]!
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't2'), '保留')]))
    inTx(() => appendEvents(db, account, [revokeDraft(doomed.batchId)]))

    rebuildProjection(db, account)
    expect(readProjection(db, account).tasks.map((t) => t.title)).toEqual(['保留'])
    // 被撤销的事件仍在事件表里（撤销是「不参与折叠」，不是删除）
    expect(readAccountEvents(db, account)).toHaveLength(3)
  })

  it('撤销事件本身不可被撤销：重建后依然如此', () => {
    const account = freshAccount()
    const doomed = inTx(() =>
      appendEvents(db, account, [createdDraft(tid(account, 't1'), '将被撤销')]),
    )[0]!
    const revokeEvent = inTx(() =>
      appendEvents(db, account, [revokeDraft(doomed.batchId)]),
    )[0]!
    inTx(() => appendEvents(db, account, [revokeDraft(revokeEvent.batchId)]))

    rebuildProjection(db, account)
    expect(readProjection(db, account).tasks).toHaveLength(0)
  })

  it('覆盖锚点之前的事件不参与折叠，但物理保留', () => {
    const account = freshAccount()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), '锚点前')]))
    inTx(() =>
      appendEvents(db, account, [
        {
          type: 'system/overwrite-anchor',
          occurredAt: '2026-09-22T12:00:00+08:00',
          payload: { sourceFile: 'backup.json', overwrittenCount: 1, previousHeadId: null },
        },
      ]),
    )

    rebuildProjection(db, account)
    expect(readProjection(db, account).tasks).toHaveLength(0)
    expect(readAccountEvents(db, account)).toHaveLength(2)
  })
})

describe('重建的事务性与作用域', () => {
  it('重放中途抛错时投影表原样保留（事务回滚，不会留下「清空后未写回」的空表）', () => {
    const account = freshAccount()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), '好数据')]))
    const before = rawTasks(account)

    // 塞一条未登记类型的事件：它无法重放，project() 会抛错
    db.prepare(
      `INSERT INTO events
         (id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
          target_kind, target_id, batch_id, payload, appended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      nextId(),
      account,
      'task/archived',
      '2026-09-23T10:00:00+08:00',
      'Asia/Shanghai',
      '2026-09-23',
      4,
      nextId(),
      JSON.stringify({ title: '来自未来的阶段' }),
      '2026-09-23T10:00:00+08:00',
    )

    expect(() => rebuildProjection(db, account)).toThrow(/未登记的事件类型/)
    // 关键：不是「空表」，而是**一点没动**——clearProjection 也一并回滚了
    expect(rawTasks(account)).toEqual(before)
  })

  it('只重建指定账号，另一个账号的投影行分毫不动', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    inTx(() =>
      appendEvents(db, alice, [
        createdDraft(tid(alice, 't1'), 'A 的'),
        createdDraft(tid(alice, 't2'), 'A 的第二条'),
      ]),
    )
    inTx(() => appendEvents(db, bob, [createdDraft(tid(bob, 't1'), 'B 的')]))
    const bobBefore = rawTasks(bob)

    rebuildProjection(db, alice)
    expect(rawTasks(bob)).toEqual(bobBefore)
    expect(readProjection(db, alice).tasks).toHaveLength(2)
  })

  it('删掉创建事件所在批次后重建，别账号的同名任务不受影响', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    const aliceBatch = inTx(() =>
      appendEvents(db, alice, [createdDraft(tid(alice, 't1'), 'A 的')]),
    )[0]!
    inTx(() => appendEvents(db, bob, [createdDraft(tid(bob, 't1'), 'B 的')]))
    inTx(() => appendEvents(db, alice, [revokeDraft(aliceBatch.batchId)]))

    rebuildProjection(db, alice)
    expect(readProjection(db, alice).tasks).toHaveLength(0)
    expect(readProjection(db, bob).tasks.map((t) => t.title)).toEqual(['B 的'])
  })
})

/**
 * `settings` 与任务同为投影：**可丢弃、可重建**（ADR-010 §6/§7）。
 *
 * 本组原先有两条「重建不清空 settings」的用例，理由是「阶段 2 没有任何事件能把它
 * 建回来」。`settings/updated` 登记后那个理由消失，两条用例随之**反过来**：
 * 现在清空重建必须得到同一行——与任务走同一条不变式。
 */
describe('settings 也是投影：重建会从事件把它建回来（ADR-010 §6/§7）', () => {
  function rawSettings(accountId: string): unknown {
    return db
      .prepare('SELECT account_id, time_zone, day_start_hour, updated_at FROM settings WHERE account_id = ?')
      .get(accountId)
  }

  /** 改设置：**经由产品代码**（追加 settings/updated），不走任何测试后门 */
  function setSettings(accountId: string, timeZone: string, dayStartHour: number, occurredAt: string): void {
    inTx(() =>
      appendEvents(db, accountId, [
        { type: 'settings/updated', occurredAt, payload: { timeZone, dayStartHour } },
      ]),
    )
  }

  it('重建后 settings 行逐字段不变（它现在是重放得出的）', () => {
    const account = freshAccount()
    setSettings(account, 'Asia/Shanghai', 4, '2026-09-22T09:00:00+08:00')
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A')]))
    const before = rawSettings(account)
    expect(before).toBeDefined()

    rebuildProjection(db, account)
    expect(rawSettings(account)).toEqual(before)
  })

  it('手工塞进去、没有事件依据的 settings 行会被重建抹掉（与任务同一条纪律）', () => {
    const account = freshAccount()
    // 模拟「某个模块绕过事件追加，自己往设置表里插了一行」（ADR-010 §7 的违规路径）
    db.prepare(
      `INSERT INTO settings (account_id, time_zone, day_start_hour, updated_at)
       VALUES (?, 'Asia/Shanghai', 4, '2026-09-22T10:00:00+08:00')`,
    ).run(account)
    expect(rawSettings(account)).toBeDefined()

    rebuildProjection(db, account)
    expect(rawSettings(account)).toBeUndefined()
    // 读取路径随之回落默认值——可解释的取值，不是静默失真
    expect(timeContextOf(loadAccountSettings(db, account)).dayStartHour).toBe(DEFAULT_DAY_START_HOUR)
  })

  it('重建不改动账号设置驱动的字段：事件的 day_key / day_start_hour 已固化（ADR-001 §4）', () => {
    const account = freshAccount()
    setSettings(account, 'Asia/Shanghai', 4, '2026-09-22T09:00:00+08:00')
    inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '凌晨三点', { occurredAt: '2026-09-22T03:00:00+08:00' }),
      ]),
    )
    // 之后把设置改掉（同样是经由事件），再重建：历史事件的固化值不得被重算
    setSettings(account, 'Asia/Shanghai', 0, '2026-09-23T09:00:00+08:00')

    rebuildProjection(db, account)
    const event = readAccountEvents(db, account).find(
      (candidate) => candidate.type === 'task/created',
    )!
    expect(event.dayKey).toBe('2026-09-21')
    expect(event.dayStartHour).toBe(4)
    // 而设置行本身是新的值——「只影响此后写入的事件」
    expect(rawSettings(account)).toMatchObject({ time_zone: 'Asia/Shanghai', day_start_hour: 0 })
  })
})
