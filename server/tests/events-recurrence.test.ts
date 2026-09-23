import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMigratedDatabase, type Db } from '../db/index.js'
import {
  appendEvents,
  eventToCompletion,
  listRegisteredTypes,
  readAccountEvents,
  rebuildProjection,
} from '../events/index.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { TASK_TARGET_KIND, taskOccurrenceCompletedPayloadSchema } from '../events/definitions/tasks.js'
import type { Event, EventDraft } from '../events/types.js'
import { eventToCompletion as sharedEventToCompletion, roundsOf, resolveInstance } from '@shared/tasks/rounds'
import type { OccurrenceCompletedPayload, OccurrenceEvent, OccurrenceUncompletedPayload } from '@shared/tasks/types'
import { insertUser } from '../repo/users.js'

/**
 * 重复语义 × 任务事件（ADR-013 §2 / §3 / §4.6 / §4.7）——**本文件由
 * `events-recurrence.test.ts`（阶段 2 的四类 `recurrence/*`）重写而来**。
 *
 * 它锁的是**锚点与规则的语义**，那些语义在阶段 4 **一条都没变**（ADR-011 §2–§5 原样有效，
 * ADR-013 只改了命名与归属）：
 *
 * 1. `task/created` 的 `recurrence` 是**整块快照**，`startsOn` 原样落库、
 *    **绝不由 `plannedDate` 推导**（§3 的陷阱，有专门的回归测试）；
 * 2. 完成事件固化的 `next` 是**嵌套可空对象**，「没有下一轮」只有一个表示（§4.6）；
 * 3. `eventToCompletion` **唯一实现在 `@shared/tasks/rounds`**（§3 的跨越点），
 *    本层不再自己拼一份 `RoundCompletion`；
 * 4. 实例键 =（taskId, originalPlannedDate），**顺延不改实例键**，故已完成态不丢（§2）；
 * 5. 取消完成是**追加一条事件**，不是删除上一条（§4.7）；
 * 6. 事件层**不判「该不该完成」**——重复完成、越界完成、倒指锚点全都照收，
 *    判据在服务层（409）与读取层（`AnchorInvariantError`，ADR-017 §2）。
 */
let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-recur-'))
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

/** 任务的**定义字段**（ADR-013 §4.1 的那九个）——测试里显式写全，因为载荷是整行快照。 */
function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '每天喝水',
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

function completed(taskId: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'task/occurrence-completed',
    occurredAt: '2026-09-23T10:00:00+08:00',
    targetKind: TASK_TARGET_KIND,
    targetId: taskId,
    batchId: nextId(),
    payload: {
      taskId,
      originalPlannedDate: '2026-09-22',
      completedDayKey: '2026-09-23',
      next: { date: '2026-09-24', mode: 'catch_up' },
    },
    ...overrides,
  }
}

/** 库里该账号的完成/取消事件 → `@shared/tasks` 的结构化形态（ADR-015 §2 的入参）。 */
function occurrenceEvents(account: string): OccurrenceEvent[] {
  const out: OccurrenceEvent[] = []
  for (const event of readAccountEvents(db, account)) {
    if (event.type === 'task/occurrence-completed') {
      out.push({
        type: 'task/occurrence-completed',
        eventId: event.id,
        accountId: event.accountId,
        occurredAt: event.occurredAt,
        payload: event.payload as OccurrenceCompletedPayload,
      })
    } else if (event.type === 'task/occurrence-uncompleted') {
      out.push({
        type: 'task/occurrence-uncompleted',
        eventId: event.id,
        accountId: event.accountId,
        occurredAt: event.occurredAt,
        payload: event.payload as OccurrenceUncompletedPayload,
      })
    }
  }
  return out
}

describe('登记（ADR-010 §2：未登记即拒写）', () => {
  it('完成 / 取消完成两类都登记在册', () => {
    expect(listRegisteredTypes()).toContain('task/occurrence-completed')
    expect(listRegisteredTypes()).toContain('task/occurrence-uncompleted')
  })

  it('`eventToCompletion` 是 `@shared/tasks/rounds` 那一个函数本身（再导出，不是第二份实现）', () => {
    // ADR-013 §3：任务层与 `shared/recurrence` 之间**只有两个跨越点**，
    // 且「除这两个以外，任何模块不得自行拼装 RecurrenceTemplate 或 RoundCompletion」。
    // 这条断言是那句话的可执行形态：有人在本层重写一份，这里立刻红。
    expect(eventToCompletion).toBe(sharedEventToCompletion)
  })

  it('两类的 apply 都能在 project() 里跑通，且**一行投影都不多**（完成态不落库）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const events = append(account, [
      created(taskId, {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      completed(taskId),
    ])
    expect(() => project(events)).not.toThrow()
    // `tasks` 只有一条（创建出来的那一条）；完成事件不改投影
    expect(readProjection(db, account).tasks).toHaveLength(1)
    expect(project(readAccountEvents(db, account)).tasks).toHaveLength(1)
  })
})

describe('task/created 的 recurrence 快照（ADR-013 §3）', () => {
  it('规则 / 锚点模式 / 起点逐字段落库，且 indexDate 取自事件的 day_key', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const recurrence = {
      rule: { freq: 'weekly', interval: 2, byDayOfWeek: [0, 4] },
      nextAnchorMode: 'extend',
      startsOn: '2026-09-01',
    }
    append(account, [created(taskId, { occurredAt: '2026-09-22T03:00:00+08:00' }, { recurrence })])
    // 账号默认 dayStartHour = 4：本地 03:00 归**前一天**（ADR-001 §4）
    expect(readProjection(db, account).tasks[0]).toMatchObject({
      id: taskId,
      accountId: account,
      indexDate: '2026-09-21',
      plannedDate: null,
      plannedWeek: null,
      dueDate: null,
      recurrence,
      status: 'not_started',
      manualOrder: null,
      deletedAt: null,
      createdAt: '2026-09-22T03:00:00+08:00',
      updatedAt: '2026-09-22T03:00:00+08:00',
    })
  })

  it('非重复任务的 recurrence 是 null（不是「规则字段各自为空」）', () => {
    const account = freshAccount()
    append(account, [created(tid(account, 't1'))])
    expect(readProjection(db, account).tasks[0]!.recurrence).toBeNull()
  })

  /**
   * §3 的陷阱（ADR-013 明文要求有回归测试）：
   *
   * > `startsOn` 是命中集合的**相位原点**，而 `plannedDate` 是「打算哪天做」——**两者会分叉**。
   * > `task/updated` 的载荷**原样携带 `startsOn`**（它是快照的一部分）。
   * > **服务端不得从 `plannedDate` 反推 `startsOn`**：读进来的值原样落库。
   *
   * ⚠️ **测试不能照 §3 那个例子写**（「每周一」起于 9/7、顺延到 9/23）：
   * §3.1 与 §3.2 已经定「**重复任务的三个日期锚点恒为 `null`**」且「**顺延对重复任务一律 `409`**」，
   * 故「一条既有 `plannedDate` 又有规则、然后被顺延」的任务**在结构上不可达**
   * （载荷 `superRefine` + 表 CHECK 两道都挡）。§3 那段是**论证相位为什么不能推导**，
   * 不是一个可构造的场景。
   *
   * 可构造、且同样能抓到「推导式实现」的路径是**从非重复转为重复**（§3.3 / ADR-016 §7）：
   * 转换必须**显式地换轴**——先把任务行的日期锚点清空（`task/rescheduled`，
   * 它是创建之后日期锚点的唯一写入者），再加规则。两步都显式，转换因此**不静默**。
   *
   * 而 `startsOn` 由 `task/updated` 的载荷给定：一个「从 `plannedDate ?? indexDate` 反推」
   * 的实现会填出 `2026-09-22`（indexDate，此刻 `plannedDate` 已是 null），
   * 而正确答案是载荷里那个与两者都不同的 `2026-09-01`。
   */
  it('startsOn 原样取自载荷，绝不由 plannedDate / indexDate 推导（§3 陷阱的回归测试）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    // 先是一条普通的日级任务（起止都在 9/7 与创建日，两者都不等于下面的 startsOn）
    append(account, [created(taskId, { occurredAt: '2026-09-22T10:00:00+08:00' }, { plannedDate: '2026-09-07' })])
    expect(readProjection(db, account).tasks[0]!.indexDate).toBe('2026-09-22')

    // 换轴第一步：显式清掉日期锚点
    append(account, [
      {
        type: 'task/rescheduled',
        occurredAt: '2026-09-22T10:30:00+08:00',
        batchId: nextId(),
        payload: {
          taskId,
          fromPlannedDate: '2026-09-07',
          toPlannedDate: null,
          fromPlannedWeek: null,
          toPlannedWeek: null,
          fromDueDate: null,
          toDueDate: null,
        },
      },
    ])

    // 换轴第二步：加规则，`startsOn` 交给载荷决定
    append(account, [
      {
        type: 'task/updated',
        occurredAt: '2026-09-22T11:00:00+08:00',
        batchId: nextId(),
        payload: {
          taskId,
          title: '每天喝水',
          notes: '',
          importance: 'normal',
          tags: [],
          projectId: null,
          recurrence: {
            rule: { freq: 'weekly', interval: 1, byDayOfWeek: [0] },
            nextAnchorMode: 'catch_up',
            startsOn: '2026-09-01',
          },
        },
      },
    ])

    const task = readProjection(db, account).tasks[0]!
    expect(task.plannedDate).toBeNull() // 换轴第一步清掉的
    expect(task.recurrence!.startsOn).toBe('2026-09-01') // 载荷说了算，不是 9/7 也不是 indexDate
    expect(task.indexDate).toBe('2026-09-22') // indexDate 仍是创建日，**不因换轴而变**
    // 重放路径同样如此（投影不是「碰巧对」）
    expect(project(readAccountEvents(db, account)).tasks[0]!.recurrence!.startsOn).toBe('2026-09-01')
  })

  /**
   * 换轴**不能省掉第一步**：忘了清锚点就加规则，会得到一条「重复任务带日期锚点」的行——
   * 载荷层判不了（锚点不在 `task/updated` 的载荷里），于是**表侧守卫当场炸**。
   * 这不是缺陷：ADR-013 §3.1 要的就是「这个组合不可表达」，两条路径都得挡住。
   */
  it('直接给一条带日期锚点的任务加规则：投影写入被拒（行上的锚点必须由服务层显式清掉）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-07' })])
    expect(() =>
      append(account, [
        {
          type: 'task/updated',
          occurredAt: '2026-09-22T11:00:00+08:00',
          payload: {
            taskId,
            title: '每天喝水',
            notes: '',
            importance: 'normal',
            tags: [],
            projectId: null,
            recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-01' },
          },
        },
      ]),
    ).toThrow(/重复任务/)
    // 整批次回滚，行保持原样
    expect(readProjection(db, account).tasks[0]!.recurrence).toBeNull()
    expect(readProjection(db, account).tasks[0]!.plannedDate).toBe('2026-09-07')
  })

  /**
   * §3.2：**顺延只适用于非重复任务**。
   *
   * 服务层对 `recurrence !== null` 的任务拒绝 `task/rescheduled`（`409 conflict/date-driven-by-rule`）。
   * 事件层**不拦**——它没有 `recurrence` 字段可判，而「行上有没有规则」是跨行信息。
   * 兜底落在**表侧 CHECK**（`recurrence_json IS NULL OR 三个锚点皆空`）：
   * 真写进去时当场炸，而不是静默留下一条「重复任务带日期锚点」的行。
   */
  it('顺延一条重复任务：载荷层放行，但写入表时被 CHECK / 投影守卫当场拒绝', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [
      created(taskId, {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
    ])
    expect(() =>
      append(account, [
        {
          type: 'task/rescheduled',
          occurredAt: '2026-09-25T10:00:00+08:00',
          batchId: nextId(),
          payload: {
            taskId,
            fromPlannedDate: null,
            toPlannedDate: '2026-09-30',
            fromPlannedWeek: null,
            toPlannedWeek: null,
            fromDueDate: null,
            toDueDate: null,
          },
        },
      ]),
    ).toThrow(/重复任务/)
    // 整批次回滚：事件一个字都没落库（ADR-002 §1）
    expect(readAccountEvents(db, account).filter((event) => event.type === 'task/rescheduled')).toHaveLength(0)
    expect(readProjection(db, account).tasks[0]!.plannedDate).toBeNull()
  })
})

describe('完成事件：next 的两态（ADR-013 §4.6）', () => {
  it('next = { date, mode } 原样落库，并映射成 RoundCompletion 的两个字段', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const [appended] = append(account, [completed(taskId)])
    const stored = readAccountEvents(db, account)[0]!

    const completion = sharedEventToCompletion({
      eventId: stored.id,
      accountId: stored.accountId,
      payload: taskOccurrenceCompletedPayloadSchema.parse(stored.payload),
    })
    // 字段集合恰好是 RoundCompletion 的那七个：多一个少一个都在这里红
    expect(Object.keys(completion).sort()).toEqual([
      'accountId',
      'completedDayKey',
      'eventId',
      'nextAnchorDate',
      'nextAnchorMode',
      'originalPlannedDate',
      'templateId',
    ])
    expect(completion.accountId).toBe(account)
    expect(completion.eventId).toBe(appended!.id)
    // taskId → templateId：ADR-013 §4.6 的搬运（跨越点之一）
    expect(completion.templateId).toBe(taskId)
    expect(completion.originalPlannedDate).toBe('2026-09-22')
    expect(completion.completedDayKey).toBe('2026-09-23')
    expect(completion.nextAnchorDate).toBe('2026-09-24')
    expect(completion.nextAnchorMode).toBe('catch_up')
  })

  /**
   * **`next: null` 的含义是「没有下一轮」**，它覆盖两种情形：非重复任务（本来就没有下一轮）
   * 与重复规则已终止（达到 `count` 或越过 `until`）。两者在读取方需要知道的**全部信息**上
   * 完全等价，合并成一个取值是准确的（§4.6）。
   *
   * 映射的结果是 `nextAnchorDate = null` **且** `nextAnchorMode = null`——
   * `RoundCompletion.nextAnchorMode` 为此刻意放宽为可空（ADR-013 §4.6 的授权，
   * 全仓对 `shared/recurrence` 的唯一一处改动）。**不伪造一个 mode**：
   * 「没有下一轮」时随便填一个 `catch_up`，读的人会以为系统选了它。
   */
  it('next = null ⇒ 两个锚点字段都为 null（不伪造 mode）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [
      completed(taskId, {
        payload: {
          taskId,
          originalPlannedDate: '2026-09-22',
          completedDayKey: '2026-09-22',
          next: null,
        },
      }),
    ])
    const stored = readAccountEvents(db, account)[0]!
    const payload = taskOccurrenceCompletedPayloadSchema.parse(stored.payload)
    expect(payload.next).toBeNull()

    const completion = sharedEventToCompletion({
      eventId: stored.id,
      accountId: stored.accountId,
      payload,
    })
    expect(completion.nextAnchorDate).toBeNull()
    expect(completion.nextAnchorMode).toBeNull()
  })

  it('完成事件不写投影表，但确实落了库、带标识落点（它只作为推导的输入存在）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const [event] = append(account, [completed(taskId)])
    expect(event!.type).toBe('task/occurrence-completed')
    expect(event!.targetKind).toBe(TASK_TARGET_KIND)
    expect(event!.targetId).toBe(taskId)
    expect(readAccountEvents(db, account)).toHaveLength(1)
  })
})

/**
 * **实例键稳定性**（ADR-013 §2 的迁移矩阵里点名的一条）：
 *
 * 非重复任务的实例键恒为其 `indexDate`（= `task/created` 的 `day_key`），
 * **与当前 `plannedDate` 无关**。顺延改的是 `plannedDate`，故已完成态**不丢**——
 * 而若实例键取自 `plannedDate`，一次顺延就会让「9/22 完成过」这件事凭空消失。
 */
describe('实例键稳定性（顺延不改实例键）', () => {
  it('顺延 plannedDate 后，非重复任务的实例键不变、已完成态不丢', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, { occurredAt: '2026-09-22T10:00:00+08:00' }, { plannedDate: '2026-09-22' })])
    append(account, [completed(taskId, { payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: null } })])
    append(account, [
      {
        type: 'task/rescheduled',
        occurredAt: '2026-09-25T10:00:00+08:00',
        batchId: nextId(),
        payload: {
          taskId,
          fromPlannedDate: '2026-09-22',
          toPlannedDate: '2026-09-30',
          fromPlannedWeek: null,
          toPlannedWeek: null,
          fromDueDate: null,
          toDueDate: null,
        },
      },
    ])

    const task = readProjection(db, account).tasks[0]!
    expect(task.indexDate).toBe('2026-09-22') // 取自 task/created 的 day_key，不可变
    expect(task.plannedDate).toBe('2026-09-30')

    const instance = resolveInstance(task, occurrenceEvents(account), '2026-09-25')
    expect(instance.occurrenceKey).toBe('2026-09-22') // 仍是创建日那一轮
    expect(instance.completion).not.toBeNull() // 已完成态没丢
    expect(instance.completion!.payload.completedDayKey).toBe('2026-09-22')
  })
})

/**
 * **完成不是任务级状态**（ADR-013 §2 的核心决定，Logseq 2022 年那次事故的回归测试）：
 * 重复任务连续完成两轮，**第一轮的完成记录仍在**。
 *
 * 若「完成」是任务级状态，第二天必须把它改回「未开始」才能再完成——
 * 于是每一轮完成都会抹掉上一轮的完成记录。
 */
describe('完成不是任务级状态（Logseq 教训的回归）', () => {
  it('重复任务连续完成两轮：两条完成记录都在，status 仍是 not_started', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [
      created(taskId, {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
    ])
    append(account, [
      completed(taskId, { payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: { date: '2026-09-23', mode: 'catch_up' } } }),
    ])
    append(account, [
      completed(taskId, {
        occurredAt: '2026-09-24T10:00:00+08:00',
        payload: { taskId, originalPlannedDate: '2026-09-23', completedDayKey: '2026-09-24', next: { date: '2026-09-25', mode: 'catch_up' } },
      }),
    ])

    const task = readProjection(db, account).tasks[0]!
    expect(task.status).toBe('not_started') // 完成**不是**任务级迁移
    const rounds = roundsOf(task, occurrenceEvents(account), '2026-09-24')
    expect(rounds.filter((round) => round.status === 'completed').map((round) => round.originalPlannedDate)).toEqual([
      '2026-09-22',
      '2026-09-23',
    ])
  })
})

/**
 * 取消完成**是追加一条事件**，不是删除上一条（FR2.1 原文，ADR-013 §4.7）。
 * 「最后一条决定当前态」的折叠在 `@shared/tasks/rounds`（ADR-015 §2）——
 * 这里锁的是**事件层不抹除历史**这一点。
 */
describe('取消完成：追加而非删除（ADR-013 §4.7）', () => {
  it('两条事件都在库里；读模型按最后一条判成未完成', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22' })])
    append(account, [completed(taskId, { payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: null } })])
    append(account, [
      {
        type: 'task/occurrence-uncompleted',
        occurredAt: '2026-09-25T10:00:00+08:00',
        batchId: nextId(),
        payload: { taskId, originalPlannedDate: '2026-09-22' },
      },
    ])

    const events = occurrenceEvents(account)
    expect(events).toHaveLength(2) // 完成那条**没有被删掉**
    const task = readProjection(db, account).tasks[0]!
    const instance = resolveInstance(task, events, '2026-09-25')
    expect(instance.occurrenceKey).toBe('2026-09-22')
    expect(instance.completion).toBeNull() // 最后一条是「取消」⇒ 当前未完成
  })

  it('取消后再完成：最后一条决定，回到已完成', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    append(account, [created(taskId, {}, { plannedDate: '2026-09-22' })])
    append(account, [completed(taskId, { payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: null } })])
    append(account, [
      {
        type: 'task/occurrence-uncompleted',
        occurredAt: '2026-09-25T10:00:00+08:00',
        batchId: nextId(),
        payload: { taskId, originalPlannedDate: '2026-09-22' },
      },
    ])
    append(account, [
      completed(taskId, {
        occurredAt: '2026-09-26T10:00:00+08:00',
        payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-26', next: null },
      }),
    ])

    const task = readProjection(db, account).tasks[0]!
    const instance = resolveInstance(task, occurrenceEvents(account), '2026-09-26')
    expect(instance.completion!.payload.completedDayKey).toBe('2026-09-26')
  })
})

describe('载荷校验（结构由 zod，语义委托 @shared/recurrence）', () => {
  function rejects(draft: EventDraft, pattern: RegExp): void {
    const account = freshAccount()
    expect(() => append(account, [draft])).toThrow(pattern)
    expect(readAccountEvents(db, account)).toHaveLength(0)
    expect(readProjection(db, account).tasks).toHaveLength(0)
  }

  it('count 与 until 并存被拒（RFC 5545 MUST NOT，ADR-011 §2）', () => {
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 1, count: 3, until: '2026-12-31' }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      /count-until-exclusive|不得并存/,
    )
  })

  it('byDayOfWeek 用在 daily 上被拒（静默忽略会导出成错误的 RRULE）', () => {
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 1, byDayOfWeek: [1] }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      /仅 weekly 使用/,
    )
  })

  it('interval < 1、until 早于 startsOn 都被拒', () => {
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 0 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      /interval/,
    )
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 1, until: '2026-09-01' }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      /不得早于/,
    )
  })

  it('规则不许夹带额外字段（.strict()：多余字段即契约漂移）', () => {
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 1, byHour: 9 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      /载荷不合法/,
    )
  })

  it('锚点模式不得越界；startsOn 必须是真实日历日', () => {
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'yolo', startsOn: '2026-09-22' } }),
      /载荷不合法/,
    )
    rejects(
      created('t1', {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-02-31' } }),
      /startsOn/,
    )
  })

  it('完成事件里的日期必须是真实存在的日历日（「2026-02-31」这类不许入库）', () => {
    rejects(
      completed('t1', {
        payload: { taskId: 't1', originalPlannedDate: '2026-02-31', completedDayKey: '2026-02-28', next: { date: '2026-03-01', mode: 'extend' } },
      }),
      /originalPlannedDate/,
    )
  })

  it('next 只接受「两者俱全」或「整体为 null」——没有「有日期没模式」这种半截形态', () => {
    rejects(
      completed('t1', { payload: { taskId: 't1', originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: { date: '2026-09-23' } } }),
      /载荷不合法/,
    )
    rejects(
      completed('t1', { payload: { taskId: 't1', originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: { mode: 'extend' } } }),
      /载荷不合法/,
    )
  })
})

/**
 * **事件层不判「该不该完成」**（阶段 2 起就有的契约，本 ADR 未改变它）：
 * 判据在服务层（409，ADR-017 §2）与读取层（`AnchorInvariantError`，500）。
 *
 * 这几条**不是缺口登记**，而是把边界的责任划清楚——若哪天有人往事件层加校验，
 * 这里会红，而那正是应该停下来读 ADR-017 §2 的时刻。
 */
describe('契约缺口：事件层不判「该不该完成」（ADR-017 §2 承接）', () => {
  it('同一轮次完成两次：两条事件都入库，事件层不判重', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const twice = [
      completed(taskId),
      completed(taskId, { occurredAt: '2026-09-23T11:00:00+08:00' }),
    ]
    expect(append(account, twice)).toHaveLength(2)
    expect(readAccountEvents(db, account)).toHaveLength(2)
    // 实例键的去重不在这里：服务层对「重复完成同一实例」返回
    // 409 conflict/occurrence-already-completed（ADR-017 §2）。
  })

  it('超出 count / until 的轮次完成事件同样被接受', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const [event] = append(account, [
      completed(taskId, {
        payload: { taskId, originalPlannedDate: '2027-01-01', completedDayKey: '2027-01-01', next: null },
      }),
    ])
    expect(event!.id).toBeTruthy()
  })

  it('提前完成的锚点若「倒指」，事件层也照收——不变式由 deriveRounds 守（ADR-011 §5）', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    // next.date ≤ originalPlannedDate：ADR-011 §5 判定为固化值被写坏（500），
    // 但事件层只校验「是不是一个日历日」，不校验锚点不变式。
    const [event] = append(account, [
      completed(taskId, {
        payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: { date: '2026-09-22', mode: 'extend' } },
      }),
    ])
    expect((event!.payload as { next: { date: string } }).next.date).toBe('2026-09-22')
  })
})

describe('标识落点与重放的关系（ADR-013 §4）', () => {
  it('落点由载荷派生：调用方省掉 target 两列也一样对', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    const [event] = append(account, [created(taskId, { targetKind: undefined, targetId: undefined })])
    expect(event!.targetKind).toBe(TASK_TARGET_KIND)
    expect(event!.targetId).toBe((event!.payload as { taskId: string }).taskId)
  })

  it('显式给出且与载荷不符时拒绝写入，而不是静默取其一（ADR-010 §2）', () => {
    const account = freshAccount()
    const truth = tid(account, 'truth')
    const lie = tid(account, 'lie')
    expect(() => append(account, [created(lie, { targetId: truth })])).toThrow(/target_id/)
    expect(() => append(account, [created(lie, { targetKind: 'something_else' })])).toThrow(/target_kind/)
    expect(readAccountEvents(db, account)).toHaveLength(0)
  })
})

describe('增量与全量在重复事件上一致（ADR-010 §5）', () => {
  it('建—完成—取消完成—顺延走一遍，增量结果 == 重建结果', () => {
    const account = freshAccount()
    const taskId = tid(account, 't1')
    // 重复任务（锚点皆空）与另一条非重复任务（顺延改的是它）各一条
    append(account, [
      created(taskId, {}, { recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-22' } }),
      created(tid(account, 't2'), {}, { title: '非重复的那条', plannedDate: '2026-09-22' }),
    ])
    append(account, [
      completed(taskId, {
        payload: { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-23', next: { date: '2026-09-24', mode: 'catch_up' } },
      }),
    ])
    append(account, [
      {
        type: 'task/occurrence-uncompleted',
        occurredAt: '2026-09-25T10:00:00+08:00',
        batchId: nextId(),
        payload: { taskId, originalPlannedDate: '2026-09-24' },
      },
    ])

    // 顺延走的是**非重复**的那一条（重复任务顺延会被表侧守卫拒，§3.2）
    append(account, [
      {
        type: 'task/rescheduled',
        occurredAt: '2026-09-26T10:00:00+08:00',
        batchId: nextId(),
        payload: {
          taskId: tid(account, 't2'),
          fromPlannedDate: '2026-09-22',
          toPlannedDate: '2026-09-29',
          fromPlannedWeek: null,
          toPlannedWeek: null,
          fromDueDate: null,
          toDueDate: null,
        },
      },
    ])

    const incremental = readProjection(db, account)
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
    expect(incremental.tasks.map((task) => task.title)).toEqual(['每天喝水', '非重复的那条'])
    expect(incremental.tasks.find((task) => task.id === tid(account, 't2'))!.plannedDate).toBe('2026-09-29')
  })
})
