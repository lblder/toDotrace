import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMigratedDatabase, type Db } from '../db/index.js'
import {
  appendEvents,
  readAccountEvents,
  rebuildProjection,
  taskOccurrenceCompletedPayloadSchema,
} from '../events/index.js'
import { EVENT_DEFINITIONS } from '../events/definitions/index.js'
import { readRevokedBatchIds } from '../events/event-store.js'
import { countProjectedTasks, readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { TASK_TARGET_KIND } from '../events/definitions/tasks.js'
import type { Event, EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'

/**
 * 13 类任务事件（ADR-013 §4）——阶段 4 的登记项。
 *
 * 本文件管**定义字段与实例之外**的那些事件：创建 / 更新 / 顺延 / 状态 / 排序 / 删除 / 步骤五类。
 * 完成与取消完成（§4.6 / §4.7）连同重复语义在 `events-recurrence.test.ts`——
 * 那里锁的是锚点与规则的语义，这里锁的是**每个字段只有一个写入者**。
 *
 * 三条贯穿：
 *
 * 1. **`task/updated` 是整行快照**，且**不携带** `status` / `steps` / 三个日期锚点 /
 *    `manualOrder` / `deletedAt`（§4.2）——每个字段只有一个写入者；
 * 2. **软删除**：`task/deleted` 的载荷只有 `taskId`，行**还在**（与 ADR-011 §6 的
 *    `template-deleted` 相反，那里是物理删除所以必须带快照）；
 * 3. **步骤的定义属于任务、勾选属于某一轮**（§4.12）：`steps_json` 里只有定义，
 *    `task/step-toggled` 的 `apply` 是空操作。
 */

let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-tasks-'))
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

function append(account: string, drafts: EventDraft[]): Event[] {
  return inTx(() => appendEvents(db, account, drafts))
}

/** 九个定义字段（ADR-013 §4.1）——载荷是整行快照，故每个用例都写全。 */
function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '写周报',
    notes: '',
    importance: 'normal',
    plannedDate: null,
    plannedWeek: null,
    dueDate: null,
    tags: [],
    projectId: null,
    recurrence: null,
    ...overrides,
  }
}

function created(taskId: string, overrides: Partial<EventDraft> = {}, fieldsOverride: Record<string, unknown> = {}): EventDraft {
  return {
    type: 'task/created',
    occurredAt: '2026-09-22T10:00:00+08:00',
    targetKind: TASK_TARGET_KIND,
    targetId: taskId,
    batchId: nextId(),
    // `steps` 只有 `task/created` 携带（§4.9），且是**必填**字段（整行快照，没有差量）
    payload: { taskId, steps: [], ...fields(fieldsOverride) },
    ...overrides,
  }
}

/**
 * `task/updated` 的载荷**没有三个日期锚点**（§4.2 的「本事件不携带」清单 + ADR-017 §4
 * 的「给出来即 400」）。测试的构造器因此与 `fields()` 分开写——两者形状不同这件事
 * 必须在这里可见，否则下一个人会照着 `fields()` 填出一个被 `.strict()` 拒的载荷。
 */
function updated(taskId: string, fieldsOverride: Record<string, unknown> = {}, overrides: Partial<EventDraft> = {}): EventDraft {
  // 三个日期锚点在这里被**摘掉**（下方解构即为那句「不携带」的可执行形态）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { plannedDate, plannedWeek, dueDate, ...rest } = fields(fieldsOverride)
  return {
    type: 'task/updated',
    occurredAt: '2026-09-23T10:00:00+08:00',
    targetKind: TASK_TARGET_KIND,
    targetId: taskId,
    batchId: nextId(),
    payload: { taskId, ...rest },
    ...overrides,
  }
}

const ANCHORS_NULL = {
  fromPlannedDate: null,
  toPlannedDate: null,
  fromPlannedWeek: null,
  toPlannedWeek: null,
  fromDueDate: null,
  toDueDate: null,
}

function rescheduled(taskId: string, payload: Record<string, unknown>, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'task/rescheduled',
    occurredAt: '2026-09-24T10:00:00+08:00',
    targetKind: TASK_TARGET_KIND,
    targetId: taskId,
    batchId: nextId(),
    payload: { taskId, ...ANCHORS_NULL, ...payload },
    ...overrides,
  }
}

/** 该账号当前投影是否等于其全部事件的重放结果（ADR-010 §5 的核心不变式）。 */
function expectProjectionMatchesReplay(accountId: string): void {
  expect(readProjection(db, accountId)).toEqual(project(readAccountEvents(db, accountId)))
}

describe('登记（ADR-010 §2：未登记即拒写）', () => {
  const TASK_EVENT_TYPES = [
    'task/created',
    'task/updated',
    'task/rescheduled',
    'task/status-changed',
    'task/reordered',
    'task/occurrence-completed',
    'task/occurrence-uncompleted',
    'task/deleted',
    'task/step-added',
    'task/step-removed',
    'task/step-renamed',
    'task/step-toggled',
    'task/steps-reordered',
    'task/focus-added',
    'task/focus-removed',
    'task/timer-configured',
    'task/timer-started',
    'task/timer-stopped',
  ]

  it('任务事件类型一个不多、一个不少，全部登记在册', () => {
    for (const type of TASK_EVENT_TYPES) {
      expect(EVENT_DEFINITIONS.map((definition) => definition.type)).toContain(type)
    }
    const taskTypes = EVENT_DEFINITIONS.map((definition) => definition.type).filter((type) =>
      type.startsWith('task/'),
    )
    expect(taskTypes.sort()).toEqual([...TASK_EVENT_TYPES].sort())
  })

  it('任务事件的落点一律是 task（kind 常量 + 从载荷取 taskId）', () => {
    for (const definition of EVENT_DEFINITIONS) {
      if (!definition.type.startsWith('task/')) continue
      expect(definition.target?.kind, definition.type).toBe('task')
      // 声明的落点必须**真的能从载荷取到值**——`fromPayload` 返回空串时
      // `appendEvents` 会当成定义自身的缺陷抛内部错误（ADR-010 §2）
      expect(definition.target!.fromPayload({ taskId: 'x' }), definition.type).toBe('x')
    }
  })
})

describe('task/created（插入行）', () => {
  it('投影行逐字段等于载荷 + 事件里的账号与时刻，indexDate 取自事件的 day_key', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [
      created(taskId, { occurredAt: '2026-09-22T10:00:00+08:00', dayKey: '2026-09-20', dayStartHour: 4 }, {
        title: '交周报',
        notes: '记得附上链接',
        importance: 'high',
        plannedDate: '2026-09-25',
        dueDate: '2026-09-26',
        tags: ['工作', '周报'],
      }),
    ])
    // 刻意给了一个与 occurredAt 不同的 dayKey（导入事件的样子）：`indexDate` 必须取自
    // **事件的列**，而不是从 occurredAt 折算（ADR-013 §1：同一事实只应有一个来源）。
    // 注意 dayKey 与 dayStartHour 必须成对给出（append.ts 的守卫）。
    const task = readProjection(db, account).tasks[0]!
    expect(task).toMatchObject({
      id: taskId,
      accountId: account,
      title: '交周报',
      notes: '记得附上链接',
      importance: 'high',
      plannedDate: '2026-09-25',
      plannedWeek: null,
      dueDate: '2026-09-26',
      tags: ['工作', '周报'],
      projectId: null,
      status: 'not_started',
      manualOrder: null,
      steps: [],
      indexDate: '2026-09-20',
      recurrence: null,
      deletedAt: null,
      createdAt: '2026-09-22T10:00:00+08:00',
      updatedAt: '2026-09-22T10:00:00+08:00',
    })
  })

  it('初始 steps 原样落库（**只有本事件携带 steps**，§4.9）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [
      created(taskId, {}, { steps: [{ id: 's1', title: '写日志' }, { id: 's2', title: '看论文' }] }),
    ])
    expect(readProjection(db, account).tasks[0]!.steps).toEqual([
      { id: 's1', title: '写日志' },
      { id: 's2', title: '看论文' },
    ])
  })

  it('同一任务 id 的第二次 created 覆盖而不是抛错（合并导入 / 撤销后重导入）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { title: '先' })])
    append(account, [created(taskId, { batchId: nextId() }, { title: '后' })])
    const tasks = readProjection(db, account).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('后')
  })
})

/**
 * **整行快照**（§4.2）。
 *
 * 差量只有在「创建事件一定先于更新事件」时才拼得出完整行，而事件集合可能因撤销、
 * 合并导入而缺前半截；整行载荷让每一条更新事件**自身就足以决定状态**。
 */
describe('task/updated（改定义字段，且只改定义字段）', () => {
  it('覆盖全部定义字段、保留 createdAt、把 updatedAt 推到事件时刻', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { title: '原名', plannedDate: '2026-09-22', notes: '旧备注' })])
    append(account, [
      updated(taskId, {
        title: '改名',
        notes: '新备注',
        importance: 'low',
        tags: ['a'],
        projectId: 'p1',
      }),
    ])

    const task = readProjection(db, account).tasks[0]!
    expect(task).toMatchObject({
      title: '改名',
      notes: '新备注',
      importance: 'low',
      tags: ['a'],
      projectId: 'p1',
      createdAt: '2026-09-22T10:00:00+08:00',
      updatedAt: '2026-09-23T10:00:00+08:00',
      indexDate: '2026-09-22',
      // 日期锚点**不在本事件的载荷里**，故逐字不动（§4.2 / ADR-017 §4）
      plannedDate: '2026-09-22',
      dueDate: null,
    })
  })

  it('载荷里带上日期锚点即 400（`.strict()`：静默忽略会让调用方以为自己改成功了）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId)])
    for (const anchor of [{ plannedDate: '2026-09-30' }, { plannedWeek: '2026-09-28' }, { dueDate: '2026-09-30' }]) {
      expect(() =>
        append(account, [
          {
            type: 'task/updated',
            occurredAt: '2026-09-23T10:00:00+08:00',
            payload: { taskId, ...fields({ title: '改名' }), ...anchor },
          },
        ]),
      ).toThrow(/载荷不合法/)
    }
  })

  /**
   * §4.2 的「**本事件不携带**」清单——**每个字段只有一个写入者**。
   *
   * 若 `task/updated` 顺带清完成态或改锚点，同一份数据就有了两个写入者；
   * **撤销其中一条批次后两者会分叉，且没有判据**（ADR-013 §2 的「为什么不做状态事件
   * 顺带清完成态」是同一论证）。
   */
  it('不携带 status / steps / 三个日期锚点 / manualOrder / deletedAt——改定义字段时它们逐字不变', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22', dueDate: '2026-09-23', steps: [{ id: 's1', title: '步骤' }] })])
    append(account, [{ type: 'task/status-changed', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, to: 'in_progress' } }])
    append(account, [{ type: 'task/reordered', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, manualOrder: 1.5 } }])

    const before = readProjection(db, account).tasks[0]!
    append(account, [updated(taskId, { title: '只改标题' })])
    const after = readProjection(db, account).tasks[0]!

    expect(after.title).toBe('只改标题')
    expect(after.status).toBe(before.status)
    expect(after.steps).toEqual(before.steps)
    expect(after.plannedDate).toBe(before.plannedDate)
    expect(after.plannedWeek).toBe(before.plannedWeek)
    expect(after.dueDate).toBe(before.dueDate)
    expect(after.manualOrder).toBe(before.manualOrder)
    expect(after.deletedAt).toBe(before.deletedAt)
    expect(after.indexDate).toBe(before.indexDate)
  })

  it('没有对应任务时是无操作：不伪造出一个没有创建事实的半行', () => {
    const account = freshAccount()
    append(account, [updated(tid(account, 'ghost'), { title: '无中生有' })])
    expect(readProjection(db, account).tasks).toHaveLength(0)
  })

  it('创建所在批次被撤销后，更新事件不会让任务复活', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const createdEvent = append(account, [created(taskId, {}, { title: 'A' })])[0]!
    append(account, [updated(taskId, { title: 'A2' })])
    append(account, [
      { type: 'system/revoke', occurredAt: '2026-09-25T10:00:00+08:00', payload: { targetBatchId: createdEvent.batchId } },
    ])
    expect(readProjection(db, account).tasks).toHaveLength(0)
    expect(project(readAccountEvents(db, account)).tasks).toHaveLength(0)
  })
})

describe('task/rescheduled（顺延：三对前后值）', () => {
  it('落库的是 to* 三列；from* 只留在载荷里（投影只装当前态）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22' })])
    const [event] = append(account, [
      rescheduled(taskId, {
        fromPlannedDate: '2026-09-22',
        toPlannedDate: '2026-09-28',
        fromDueDate: '2026-09-23',
        toDueDate: '2026-09-29',
      }),
    ])
    expect(event!.payload).toMatchObject({
      fromPlannedDate: '2026-09-22',
      toPlannedDate: '2026-09-28',
      fromPlannedWeek: null,
      toPlannedWeek: null,
      fromDueDate: '2026-09-23',
      toDueDate: '2026-09-29',
    })
    const task = readProjection(db, account).tasks[0]!
    expect(task.plannedDate).toBe('2026-09-28')
    expect(task.dueDate).toBe('2026-09-29')
    expect(Object.keys(task)).not.toContain('fromPlannedDate')
  })

  /**
   * **`carryCount` 是派生的**（ADR-002 §2 / ADR-013 §4.3）：
   * 它是 `task/rescheduled` 事件的**条数**，且**可撤销**——撤销一次顺延批次，
   * 计数自然减一。若落了库，撤销就得额外维护那个列，多一个会与事件分叉的地方。
   */
  it('顺延次数 = 事件条数；撤销其中一批次后计数减一（不落库的回归测试）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22' })])
    append(account, [rescheduled(taskId, { fromPlannedDate: '2026-09-22', toPlannedDate: '2026-09-23' })])
    const second = append(account, [
      rescheduled(
        taskId,
        { fromPlannedDate: '2026-09-23', toPlannedDate: '2026-09-27' },
        { occurredAt: '2026-09-25T10:00:00+08:00' },
      ),
    ])[0]!

    // 「事件条数」的准确含义是**参与折叠的条数**：被撤销批次里的事件不参与折叠
    // （ADR-006 / ADR-010 §4 第 3 步），故撤销一次顺延，计数就该减一。
    // 若只在 `events` 表里数行数，撤销前后都是 2——那正说明它不是「当前态的一部分」。
    const carryCount = (): number => {
      const revoked = readRevokedBatchIds(db, account)
      return readAccountEvents(db, account).filter(
        (event) => event.type === 'task/rescheduled' && !revoked.has(event.batchId),
      ).length
    }
    expect(carryCount()).toBe(2)

    append(account, [{ type: 'system/revoke', occurredAt: '2026-09-26T10:00:00+08:00', payload: { targetBatchId: second.batchId } }])
    expect(carryCount()).toBe(1)
    // 撤销之后投影里的日期回到第一次顺延的结果
    expect(readProjection(db, account).tasks[0]!.plannedDate).toBe('2026-09-23')
    expectProjectionMatchesReplay(account)
  })
})

describe('task/status-changed（意图态，只有三态）', () => {
  it('只带 to、幂等；重复写同一条 to 不改变结果', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId)])
    append(account, [{ type: 'task/status-changed', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, to: 'in_progress' } }])
    append(account, [{ type: 'task/status-changed', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, to: 'abandoned' } }])
    append(account, [{ type: 'task/status-changed', occurredAt: '2026-09-22T13:00:00+08:00', batchId: nextId(), payload: { taskId, to: 'not_started' } }])
    expect(readProjection(db, account).tasks[0]!.status).toBe('not_started')
    expectProjectionMatchesReplay(account)
  })

  it('「已完成」不是这个状态集的取值（完成是实例属性，§2）', () => {
    const account = freshAccount()
    expect(() =>
      append(account, [
        { type: 'task/status-changed', occurredAt: '2026-09-22T11:00:00+08:00', payload: { taskId: 't1', to: 'completed' } },
      ]),
    ).toThrow(/载荷不合法/)
  })

  /**
   * **`已完成 → 已放弃` 是合法的，且是**一条事件**（ADR-013 §2 的第五轮裁决）。
   *
   * 走完后断言：① `status === 'abandoned'`；② **只写出一条事件**、
   * **没有** `task/occurrence-uncompleted`；③ **完成记录仍在**——
   * 「不抹除历史」的回归测试：若实现去清空完成记录，它会红。
   *
   * 01 FR2.1 那句「已放弃的任务 `completedAt` 必须为空」写在 `completedAt` 是**任务级字段**
   * 的原始模型里，本模型的完成态按实例、由事件固化——**那个字段在这里不存在**。
   * 它的目的（放弃的任务不得被统计当作完成）落在**统计口径**上，不在完成记录上。
   */
  it('已完成 → 已放弃：一条事件，历史保留（Logseq 教训的另一面）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22' })])
    append(account, [
      {
        type: 'task/occurrence-completed',
        occurredAt: '2026-09-22T20:00:00+08:00',
        batchId: nextId(),
        payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: null },
      },
    ])
    const before = readAccountEvents(db, account).length

    append(account, [
      {
        type: 'task/status-changed',
        occurredAt: '2026-09-22T21:00:00+08:00',
        batchId: nextId(),
        payload: { taskId, to: 'abandoned' },
      },
    ])

    expect(readProjection(db, account).tasks[0]!.status).toBe('abandoned')
    const written = readAccountEvents(db, account).slice(before)
    expect(written).toHaveLength(1) // 只写出一条事件
    expect(written[0]!.type).toBe('task/status-changed')
    expect(readAccountEvents(db, account).some((event) => event.type === 'task/occurrence-uncompleted')).toBe(false)
    // 完成记录仍在（历史区照常显示「X 日完成过一轮」）
    expect(readAccountEvents(db, account).filter((event) => event.type === 'task/occurrence-completed')).toHaveLength(1)
  })
})

describe('task/reordered（手动排序）', () => {
  it('manualOrder 落库；null = 未手动排过', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId)])
    expect(readProjection(db, account).tasks[0]!.manualOrder).toBeNull()
    append(account, [{ type: 'task/reordered', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, manualOrder: 2.5 } }])
    expect(readProjection(db, account).tasks[0]!.manualOrder).toBe(2.5)
  })

  it('非有限数被拒（NaN 经 JSON 序列化会变成 null，等于换了一个值）', () => {
    const account = freshAccount()
    expect(() =>
      append(account, [
        { type: 'task/reordered', occurredAt: '2026-09-22T11:00:00+08:00', payload: { taskId: 't1', manualOrder: Number.NaN } },
      ]),
    ).toThrow(/载荷不合法/)
  })
})

describe('task/deleted（软删除）', () => {
  it('载荷只有 taskId；行**还在**、只置 deleted_at', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { title: '将被删' })])
    const [event] = append(account, [
      { type: 'task/deleted', occurredAt: '2026-09-25T10:00:00+08:00', batchId: nextId(), payload: { taskId } },
    ])
    // 载荷**不携带快照**：行还在，多存一份定义就是第二个真相（§4.8）
    expect(event!.payload).toEqual({ taskId })
    const tasks = readProjection(db, account).tasks
    expect(tasks).toHaveLength(1) // 行保留
    expect(tasks[0]!.deletedAt).toBe('2026-09-25T10:00:00+08:00')
    expect(tasks[0]!.title).toBe('将被删') // 定义照常读得到
  })

  it('撤销删除批次后逐字段还原（不设 task/restored，恢复靠撤销）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { title: '删了又回来', steps: [{ id: 's1', title: '一步' }] })])
    const before = readProjection(db, account).tasks[0]!
    const deleted = append(account, [
      { type: 'task/deleted', occurredAt: '2026-09-25T10:00:00+08:00', payload: { taskId } },
    ])[0]!
    expect(readProjection(db, account).tasks[0]!.deletedAt).not.toBeNull()

    append(account, [{ type: 'system/revoke', occurredAt: '2026-09-26T10:00:00+08:00', payload: { targetBatchId: deleted.batchId } }])
    expect(readProjection(db, account).tasks[0]!).toEqual(before)
    expectProjectionMatchesReplay(account)
  })

  it('删除不存在的任务是无操作（事件流可能被撤销成半截）', () => {
    const account = freshAccount()
    append(account, [{ type: 'task/deleted', occurredAt: '2026-09-25T10:00:00+08:00', payload: { taskId: tid(account, 'ghost') } }])
    expect(readProjection(db, account).tasks).toHaveLength(0)
  })
})

describe('步骤（一等子实体，严格单层）', () => {
  it('step-added 追加到末尾；step-renamed 只改标题；step-removed 原位删除', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { steps: [{ id: 's1', title: '一' }, { id: 's2', title: '二' }] })])
    append(account, [{ type: 'task/step-added', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, step: { id: 's3', title: '三' } } }])
    expect(readProjection(db, account).tasks[0]!.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3'])

    append(account, [{ type: 'task/step-renamed', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's2', title: '二改' } }])
    expect(readProjection(db, account).tasks[0]!.steps.map((s) => s.title)).toEqual(['一', '二改', '三'])

    append(account, [{ type: 'task/step-removed', occurredAt: '2026-09-22T13:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's1' } }])
    expect(readProjection(db, account).tasks[0]!.steps.map((s) => s.id)).toEqual(['s2', 's3'])
    expectProjectionMatchesReplay(account)
  })

  it('重复 step-added 同一 id 是幂等（不追加第二条、也不改名）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId)])
    append(account, [
      { type: 'task/step-added', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, step: { id: 's1', title: '原名' } } },
      { type: 'task/step-added', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, step: { id: 's1', title: '改名' } } },
    ])
    expect(readProjection(db, account).tasks[0]!.steps).toEqual([{ id: 's1', title: '原名' }])
  })

  it('steps-reordered 整体替换顺序；**未列出的步骤按原相对顺序接在后面**（确定性兜底）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [
      created(taskId, {}, { steps: [{ id: 's1', title: '一' }, { id: 's2', title: '二' }, { id: 's3', title: '三' }] }),
    ])
    append(account, [
      { type: 'task/steps-reordered', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, order: ['s3', 's1', 's2'] } },
    ])
    expect(readProjection(db, account).tasks[0]!.steps.map((s) => s.id)).toEqual(['s3', 's1', 's2'])

    // **部分列表**：路由层会拒（ADR-017 §3 的「集合相等」），但事件层必须**有定义**——
    // 重放对任何一条合法流水都不能崩，且未列出的步骤位置不能取决于实现者的选择。
    append(account, [
      { type: 'task/steps-reordered', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, order: ['s2'] } },
    ])
    expect(readProjection(db, account).tasks[0]!.steps.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
    expectProjectionMatchesReplay(account)
  })

  it('order 里有重复 stepId 被拒（顺序是一个排列，不是多重集）', () => {
    const account = freshAccount()
    expect(() =>
      append(account, [
        { type: 'task/steps-reordered', occurredAt: '2026-09-22T11:00:00+08:00', payload: { taskId: 't1', order: ['s1', 's1'] } },
      ]),
    ).toThrow(/载荷不合法/)
  })

  /**
   * **勾选属于某一轮，不属于任务**（§4.12）。
   *
   * 初稿把 `checkedAt` 放在 `Step` 上——那对重复任务是错的：一个「每日复盘」的重复任务
   * 有两步，若勾选属于任务，**昨天的勾选今天还亮着**，`3/5` 从第二轮起永远显示 5/5。
   * 故：定义进投影、勾选**不进**。
   */
  it('step-toggled 不写投影表：勾选由事件固化，投影里的 steps 只有定义', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { steps: [{ id: 's1', title: '写日志' }] })])
    append(account, [
      { type: 'task/step-toggled', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's1', originalPlannedDate: '2026-09-22', checkedAt: '2026-09-22T11:00:00+08:00' } },
    ])
    const steps = readProjection(db, account).tasks[0]!.steps
    expect(steps).toEqual([{ id: 's1', title: '写日志' }])
    expect(Object.keys(steps[0]!).sort()).toEqual(['id', 'title'])
    expectProjectionMatchesReplay(account)
  })

  it('checkedAt 的两态（null = 取消勾选）都写得进去', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { steps: [{ id: 's1', title: '写日志' }] })])
    append(account, [
      { type: 'task/step-toggled', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's1', originalPlannedDate: '2026-09-22', checkedAt: '2026-09-22T11:00:00+08:00' } },
      { type: 'task/step-toggled', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's1', originalPlannedDate: '2026-09-22', checkedAt: null } },
    ])
    const stored = readAccountEvents(db, account).filter((event) => event.type === 'task/step-toggled')
    expect(stored.map((event) => (event.payload as { checkedAt: string | null }).checkedAt)).toEqual([
      '2026-09-22T11:00:00+08:00',
      null,
    ])
  })

  it('删除步骤只移除定义（勾选留在流水里，撤销后原样回来）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { steps: [{ id: 's1', title: '一' }] })])
    append(account, [
      { type: 'task/step-toggled', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's1', originalPlannedDate: '2026-09-22', checkedAt: '2026-09-22T11:00:00+08:00' } },
    ])
    const removed = append(account, [
      { type: 'task/step-removed', occurredAt: '2026-09-22T12:00:00+08:00', payload: { taskId, stepId: 's1' } },
    ])[0]!
    expect(readProjection(db, account).tasks[0]!.steps).toEqual([])
    append(account, [{ type: 'system/revoke', occurredAt: '2026-09-22T13:00:00+08:00', payload: { targetBatchId: removed.batchId } }])
    expect(readProjection(db, account).tasks[0]!.steps).toEqual([{ id: 's1', title: '一' }])
    // 勾选事件一条都没少（「物理删掉它们等于让一次误删不可撤销」，§4.10）
    expect(readAccountEvents(db, account).filter((event) => event.type === 'task/step-toggled')).toHaveLength(1)
  })
})

describe('多账号隔离（ADR-010 §1 的复合主键）', () => {
  it('同一个任务 id 在两个账号下各有一份副本，互不覆盖', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    const sharedTaskId = 'aaaaaaaa-0000-7000-8000-000000000001'
    const sharedEventId = nextId()
    const sharedBatchId = nextId()
    const imported = created(sharedTaskId, { id: sharedEventId, batchId: sharedBatchId }, { title: '导入的任务' })

    append(alice, [imported])
    expect(inTx(() => appendEvents(db, bob, [imported]))).toHaveLength(1)

    expect(readProjection(db, alice).tasks.map((task) => [task.accountId, task.id, task.title])).toEqual([
      [alice, sharedTaskId, '导入的任务'],
    ])
    expect(readProjection(db, bob).tasks.map((task) => [task.accountId, task.id, task.title])).toEqual([
      [bob, sharedTaskId, '导入的任务'],
    ])
    expect(countProjectedTasks(db, alice)).toBe(1)
    expect(countProjectedTasks(db, bob)).toBe(1)

    rebuildProjection(db, alice)
    rebuildProjection(db, bob)
    expectProjectionMatchesReplay(alice)
    expectProjectionMatchesReplay(bob)
  })
})

/**
 * **载荷那一道**锚点守卫（ADR-013 §3.1 / §3.3、ADR-016 §1）。
 *
 * 表侧的 CHECK 在下一组单独测——**两道都要单独测**：只测一道的话，
 * 另一道失效不会被发现，而「失去的那一道失效不会有任何症状」。
 */
describe('锚点守卫（载荷侧 zod .superRefine）', () => {
  function rejects(fieldsOverride: Record<string, unknown>, pattern: RegExp): void {
    const account = freshAccount()
    expect(() => append(account, [created(tid(account, 't1'), {}, fieldsOverride)])).toThrow(pattern)
    expect(countProjectedTasks(db, account)).toBe(0)
  }

  it('日级与周级锚点同时非空被拒（一次只排一层，ADR-016 §1）', () => {
    rejects({ plannedDate: '2026-09-22', plannedWeek: '2026-09-21' }, /不得同时非空/)
  })

  it('非周一的周级锚点被拒（规范化存该周周一）', () => {
    rejects({ plannedWeek: '2026-09-23' }, /周一/)
  })

  it('周一本身合法', () => {
    const account = freshAccount()
    append(account, [created(tid(account, 't1'), {}, { plannedWeek: '2026-09-21' })])
    expect(readProjection(db, account).tasks[0]!.plannedWeek).toBe('2026-09-21')
  })

  it('重复任务的三个日期锚点任意一个非空都被拒（§3.1）', () => {
    const recurrence = { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-21' }
    for (const anchor of ['plannedDate', 'plannedWeek', 'dueDate']) {
      rejects({ recurrence, [anchor]: anchor === 'plannedWeek' ? '2026-09-21' : '2026-09-22' }, /恒为 null/)
    }
  })

  it('重复任务的三个锚点皆空则合法', () => {
    const account = freshAccount()
    append(account, [
      created(tid(account, 't1'), {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-21' } }),
    ])
    const task = readProjection(db, account).tasks[0]!
    expect(task.recurrence).not.toBeNull()
    expect([task.plannedDate, task.plannedWeek, task.dueDate]).toEqual([null, null, null])
  })

  it('畸形日期串一律被拒（「形状像日期」不等于「真实存在的日历日」）', () => {
    for (const bad of ['garbage', '2026-13-45', '', '2026-9-2', '2026-02-31']) {
      rejects({ plannedDate: bad }, /载荷不合法|plannedDate/)
    }
  })

  it('额外字段即拒（.strict()：多余字段就是契约漂移）', () => {
    rejects({ status: 'in_progress' }, /载荷不合法/)
  })
})

/**
 * **表那一道**锚点守卫（`tasks` 的 CHECK，ADR-013 §5 / ADR-016 §9）。
 *
 * 这里**绕过路由与事件层直接写表**——那正是 CHECK 存在的理由：
 * 导入、测试构造、或某个模块顺手写一行，都不会经过载荷 schema。
 * 「加一条 CHECK」不等于「非法值不可表达」：SQLite 的 CHECK **只在表达式求值为 `false`
 * 时拒绝，求值为 `NULL` 时一律放行**（ADR-013 §3.1 的实测），故下面专门测了
 * `strftime` / `date` 那两处的加固写法。
 */
describe('锚点守卫（表侧 CHECK，绕过事件层直接写库）', () => {
  function insertTask(row: Record<string, unknown>): void {
    const full: Record<string, unknown> = {
      id: nextId(),
      account_id: null,
      title: 'X',
      notes: '',
      importance: 'normal',
      planned_date: null,
      planned_week: null,
      due_date: null,
      tags_json: '[]',
      project_id: null,
      status: 'not_started',
      manual_order: null,
      steps_json: '[]',
      index_date: '2026-09-22',
      recurrence_json: null,
      next_anchor_mode: null,
      starts_on: null,
      deleted_at: null,
      created_at: '2026-09-22T10:00:00+08:00',
      updated_at: '2026-09-22T10:00:00+08:00',
      ...row,
    }
    const columns = Object.keys(full)
    db.prepare(
      `INSERT INTO tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...columns.map((column) => full[column] as never))
  }

  it('非周一的 planned_week 被拒（含 strftime 加固写法要挡的三类畸形串）', () => {
    const account = freshAccount()
    // 周三：合法日历日，但不是周一
    expect(() => insertTask({ account_id: account, planned_week: '2026-09-23' })).toThrow(/CHECK/i)
    // 三类畸形串：`strftime` 解析不了返回 NULL，`NULL = '1'` 求值为 NULL，
    // 而 SQLite 的 CHECK 只在求值为 **false** 时拒绝 ⇒ 少了 `date(x) IS NOT NULL` 前半句就全放行
    for (const bad of ['garbage', '2026-13-45', '']) {
      expect(() => insertTask({ account_id: account, planned_week: bad }), bad).toThrow(/CHECK/i)
    }
    // 周一合法
    expect(() => insertTask({ account_id: account, planned_week: '2026-09-21' })).not.toThrow()
  })

  it('日 / 周锚点并存被 CHECK 拒', () => {
    const account = freshAccount()
    expect(() =>
      insertTask({ account_id: account, planned_date: '2026-09-22', planned_week: '2026-09-21' }),
    ).toThrow(/CHECK/i)
  })

  it('重复任务带日期锚点被 CHECK 拒（载荷守卫被绕过时的兜底）', () => {
    const account = freshAccount()
    const recurrence = JSON.stringify({ freq: 'daily', interval: 1 })
    expect(() =>
      insertTask({
        account_id: account,
        recurrence_json: recurrence,
        next_anchor_mode: 'catch_up',
        starts_on: '2026-09-21',
        planned_date: '2026-09-22',
      }),
    ).toThrow(/CHECK/i)
    // 三个锚点皆空则合法（这一条不能红，否则上面那条测的是「有规则就拒」）
    expect(() =>
      insertTask({
        account_id: account,
        recurrence_json: recurrence,
        next_anchor_mode: 'catch_up',
        starts_on: '2026-09-21',
      }),
    ).not.toThrow()
  })

  it('「三列同生共死」：有规则必有锚点模式与起点，反之亦然', () => {
    const account = freshAccount()
    const recurrence = JSON.stringify({ freq: 'daily', interval: 1 })
    expect(() => insertTask({ account_id: account, recurrence_json: recurrence })).toThrow(/CHECK/i)
    expect(() => insertTask({ account_id: account, next_anchor_mode: 'catch_up' })).toThrow(/CHECK/i)
    expect(() => insertTask({ account_id: account, starts_on: '2026-09-21' })).toThrow(/CHECK/i)
  })

  it('每个 dayKey 列都必须是规范形态的**真实日历日**（加固写法的实测）', () => {
    const account = freshAccount()
    // 形状像日期但日历上不存在：`date('2026-02-31')` 归一化成 '2026-03-02'，与原文不等 ⇒ 拒
    expect(() => insertTask({ account_id: account, planned_date: '2026-02-31' })).toThrow(/CHECK/i)
    expect(() => insertTask({ account_id: account, due_date: '2026-13-45' })).toThrow(/CHECK/i)
    expect(() => insertTask({ account_id: account, index_date: 'garbage' })).toThrow(/CHECK/i)
    expect(() => insertTask({ account_id: account, index_date: '' })).toThrow(/CHECK/i)
    expect(() =>
      insertTask({ account_id: account, recurrence_json: '{"freq":"daily","interval":1}', next_anchor_mode: 'catch_up', starts_on: '2026-9-2' }),
    ).toThrow(/CHECK/i)
  })
})

describe('增量与全量（ADR-010 §5）：13 类事件一起走一遍', () => {
  it('每类事件都至少参与一次「增量维护 == 全量重建」', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22', steps: [{ id: 's1', title: '一' }, { id: 's2', title: '二' }] })])
    append(account, [updated(taskId, { title: '改过', plannedDate: '2026-09-22' })])
    append(account, [rescheduled(taskId, { fromPlannedDate: '2026-09-22', toPlannedDate: '2026-09-23' })])
    append(account, [{ type: 'task/status-changed', occurredAt: '2026-09-22T11:00:00+08:00', batchId: nextId(), payload: { taskId, to: 'in_progress' } }])
    append(account, [{ type: 'task/reordered', occurredAt: '2026-09-22T12:00:00+08:00', batchId: nextId(), payload: { taskId, manualOrder: 1.25 } }])
    append(account, [{ type: 'task/step-added', occurredAt: '2026-09-22T13:00:00+08:00', batchId: nextId(), payload: { taskId, step: { id: 's3', title: '三' } } }])
    append(account, [{ type: 'task/steps-reordered', occurredAt: '2026-09-22T14:00:00+08:00', batchId: nextId(), payload: { taskId, order: ['s3', 's1', 's2'] } }])
    append(account, [{ type: 'task/step-renamed', occurredAt: '2026-09-22T15:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's3', title: '三改' } }])
    append(account, [{ type: 'task/step-toggled', occurredAt: '2026-09-22T16:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's3', originalPlannedDate: '2026-09-23', checkedAt: '2026-09-22T16:00:00+08:00' } }])
    append(account, [
      { type: 'task/occurrence-completed', occurredAt: '2026-09-22T17:00:00+08:00', batchId: nextId(), payload: { taskId, originalPlannedDate: '2026-09-23', completedDayKey: '2026-09-22', next: null } },
    ])
    append(account, [
      { type: 'task/occurrence-uncompleted', occurredAt: '2026-09-22T18:00:00+08:00', batchId: nextId(), payload: { taskId, originalPlannedDate: '2026-09-23' } },
    ])
    append(account, [{ type: 'task/step-removed', occurredAt: '2026-09-22T19:00:00+08:00', batchId: nextId(), payload: { taskId, stepId: 's1' } }])

    const incremental = readProjection(db, account)
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
    expect(incremental.tasks[0]).toMatchObject({
      title: '改过',
      status: 'in_progress',
      manualOrder: 1.25,
      plannedDate: '2026-09-23',
      steps: [{ id: 's3', title: '三改' }, { id: 's2', title: '二' }],
    })

    append(account, [
      { type: 'task/deleted', occurredAt: '2026-09-22T20:00:00+08:00', batchId: nextId(), payload: { taskId } },
    ])
    expectProjectionMatchesReplay(account)
    rebuildProjection(db, account)
    expect(readProjection(db, account).tasks[0]!.deletedAt).toBe('2026-09-22T20:00:00+08:00')
  })
})

describe('完成载荷 schema（供服务端复用）', () => {
  it('parse 后 next 是嵌套可空对象，不是「两个独立可空字段」', () => {
    const parsed = taskOccurrenceCompletedPayloadSchema.parse({
      taskId: 't1',
      originalPlannedDate: '2026-09-22',
      completedDayKey: '2026-09-22',
      next: null,
    })
    expect(parsed.next).toBeNull()
    const withNext = taskOccurrenceCompletedPayloadSchema.parse({
      taskId: 't1',
      originalPlannedDate: '2026-09-22',
      completedDayKey: '2026-09-22',
      next: { date: '2026-09-23', mode: 'extend' },
    })
    expect(withNext.next).toEqual({ date: '2026-09-23', mode: 'extend' })
  })
})
