import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { appendEvents, eventToCompletion, listRegisteredTypes, readAccountEvents, rebuildProjection } from '../events/index.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import {
  RECURRENCE_TEMPLATE_TARGET_KIND,
  roundCompletedPayloadSchema,
} from '../events/definitions/recurrence.js'
import type { Event, EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'

/**
 * 重复任务四类事件（ADR-011 §6）——阶段 2 的登记项。
 *
 * 关注点不是「字段能不能存进去」，而是四条接口契约：
 * 1. 四类**都**登记在册（否则 §2 的闸门会拒绝写入，或 §4 的重放会抛错）；
 * 2. `apply` 的语义：created 建行、updated 改行、deleted 删行、round-completed **不落库**；
 * 3. 载荷校验把语义部分**委托**给 `@shared/recurrence`（唯一一份规则校验，ADR-011 §2）；
 * 4. 标识落点：`target_kind = 'recurrence_template'`、`target_id = 模板标识`（§6 明文冻结），
 *    且两列**由载荷派生**（ADR-010 §2）——四类载荷都带 `templateId`，落点规则就是「取它」。
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

function created(templateId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/template-created',
    occurredAt: '2026-09-22T10:00:00+08:00',
    targetKind: RECURRENCE_TEMPLATE_TARGET_KIND,
    targetId: templateId,
    batchId: nextId(),
    payload: {
      templateId,
      title,
      rule: { freq: 'daily', interval: 1 },
      nextAnchorMode: 'catch_up',
      startsOn: '2026-09-22',
    },
    ...overrides,
  }
}

function updated(templateId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/template-updated',
    occurredAt: '2026-09-23T10:00:00+08:00',
    targetKind: RECURRENCE_TEMPLATE_TARGET_KIND,
    targetId: templateId,
    batchId: nextId(),
    payload: {
      templateId,
      title,
      rule: { freq: 'weekly', interval: 2, byDayOfWeek: [0, 4] },
      nextAnchorMode: 'extend',
      startsOn: '2026-09-01',
    },
    ...overrides,
  }
}

function deleted(templateId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/template-deleted',
    occurredAt: '2026-09-24T10:00:00+08:00',
    targetKind: RECURRENCE_TEMPLATE_TARGET_KIND,
    targetId: templateId,
    batchId: nextId(),
    payload: {
      templateId,
      title,
      rule: { freq: 'daily', interval: 1 },
      nextAnchorMode: 'catch_up',
      startsOn: '2026-09-22',
    },
    ...overrides,
  }
}

function completed(templateId: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/round-completed',
    occurredAt: '2026-09-23T10:00:00+08:00',
    targetKind: RECURRENCE_TEMPLATE_TARGET_KIND,
    targetId: templateId,
    batchId: nextId(),
    payload: {
      templateId,
      originalPlannedDate: '2026-09-22',
      completedDayKey: '2026-09-23',
      nextAnchorDate: '2026-09-24',
      nextAnchorMode: 'catch_up',
    },
    ...overrides,
  }
}

const FOUR_TYPES = [
  'recurrence/template-created',
  'recurrence/template-updated',
  'recurrence/template-deleted',
  'recurrence/round-completed',
]

describe('登记（ADR-010 §2：未登记即拒写）', () => {
  it('四类事件都在注册表里', () => {
    for (const type of FOUR_TYPES) expect(listRegisteredTypes()).toContain(type)
  })

  it('四类的 apply 都能在 project() 里跑通（不会因「登记了但没实现」而抛错）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const events = append(account, [
      created(templateId, 'A'),
      updated(templateId, 'A2'),
      completed(templateId),
      deleted(templateId, 'A2'),
    ])
    expect(() => project(events)).not.toThrow()
  })
})

describe('recurrence/template-created（插入行）', () => {
  it('投影行逐字段等于载荷 + 事件里的账号与时刻', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    append(account, [created(templateId, '每天喝水')])

    expect(readProjection(db, account).templates).toEqual([
      {
        id: templateId,
        accountId: account,
        title: '每天喝水',
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: '2026-09-22',
        // 创建事件同时是 createdAt 与 updatedAt 的来源（载荷不重复携带）
        createdAt: '2026-09-22T10:00:00+08:00',
        updatedAt: '2026-09-22T10:00:00+08:00',
      },
    ])
  })

  it('同一模板 id 的第二次 created 覆盖而不是抛错（合并导入 / 撤销后重导入）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    append(account, [created(templateId, '先', { batchId: nextId() })])
    append(account, [created(templateId, '后', { batchId: nextId() })])

    const templates = readProjection(db, account).templates
    expect(templates).toHaveLength(1)
    expect(templates[0]!.title).toBe('后')
  })

  it('规则原样往返：数组与可选字段不被吞掉、不被重排', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const rule = { freq: 'monthly', interval: 3, byMonthDay: [31, -1], count: 12 }
    append(account, [
      created(templateId, '月末', { payload: { ...(created(templateId, 'x').payload as object), rule } }),
    ])
    expect(readProjection(db, account).templates[0]!.rule).toEqual(rule)
  })
})

describe('recurrence/template-updated（改行）', () => {
  it('替换可变字段，保留 createdAt，并把 updatedAt 推到事件时刻', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    append(account, [created(templateId, '原名')])
    append(account, [updated(templateId, '改名')])

    const [template] = readProjection(db, account).templates
    expect(template).toMatchObject({
      title: '改名',
      rule: { freq: 'weekly', interval: 2, byDayOfWeek: [0, 4] },
      nextAnchorMode: 'extend',
      startsOn: '2026-09-01',
      createdAt: '2026-09-22T10:00:00+08:00',
      updatedAt: '2026-09-23T10:00:00+08:00',
    })
  })

  it('没有对应模板时是无操作：不伪造出一个没有创建事实的半行', () => {
    const account = freshAccount()
    append(account, [updated(tid(account, 'ghost'), '无中生有')])
    expect(readProjection(db, account).templates).toHaveLength(0)
  })

  it('创建所在批次被撤销后，更新事件不会让模板复活', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const createdEvent = append(account, [created(templateId, 'A')])[0]!
    append(account, [updated(templateId, 'A2')])
    append(account, [
      { type: 'system/revoke', occurredAt: '2026-09-25T10:00:00+08:00', payload: { targetBatchId: createdEvent.batchId } },
    ])
    expect(readProjection(db, account).templates).toHaveLength(0)
    expect(project(readAccountEvents(db, account)).templates).toHaveLength(0)
  })
})

describe('recurrence/template-deleted（删行）', () => {
  it('删除后投影里不再有该行', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    append(account, [created(templateId, 'A'), created(tid(account, 't2'), 'B')])
    append(account, [deleted(templateId, 'A')])
    expect(readProjection(db, account).templates.map((t) => t.id)).toEqual([tid(account, 't2')])
  })

  it('删除不存在的模板是无操作（不是错误：事件流可能被撤销成半截）', () => {
    const account = freshAccount()
    append(account, [deleted(tid(account, 'ghost'), '幽灵')])
    expect(readProjection(db, account).templates).toHaveLength(0)
  })

  it('删除载荷是快照：模板行没了，但快照仍在事件里（§7「已完成轮次保留」的前提）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    append(account, [created(templateId, 'A')])
    const deleteEvent = append(account, [deleted(templateId, 'A')])[0]!
    expect(deleteEvent.payload).toMatchObject({
      templateId,
      title: 'A',
      rule: { freq: 'daily', interval: 1 },
      startsOn: '2026-09-22',
    })
    expect(deleteEvent.targetKind).toBe(RECURRENCE_TEMPLATE_TARGET_KIND)
    expect(deleteEvent.targetId).toBe(templateId)
  })
})

describe('recurrence/round-completed（不写投影表）', () => {
  it('apply 是空操作：投影一行都不多', () => {
    const account = freshAccount()
    expect(append(account, [completed(tid(account, 't1'))])).toHaveLength(1)
    expect(readProjection(db, account).templates).toHaveLength(0)
    expect(project(readAccountEvents(db, account)).templates).toHaveLength(0)
  })

  it('但事件确实落了库，且带标识落点（它只作为 deriveRounds 的输入存在）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const [event] = append(account, [completed(templateId)])
    expect(event!.type).toBe('recurrence/round-completed')
    expect(event!.targetKind).toBe(RECURRENCE_TEMPLATE_TARGET_KIND)
    expect(event!.targetId).toBe(templateId)
    expect(readAccountEvents(db, account)).toHaveLength(1)
  })

  it('nextAnchorDate 可为 null（规则已终止），且原样保留', () => {
    const account = freshAccount()
    const [event] = append(account, [
      completed(tid(account, 't1'), {
        payload: {
          templateId: tid(account, 't1'),
          originalPlannedDate: '2026-09-22',
          completedDayKey: '2026-09-22',
          nextAnchorDate: null,
          nextAnchorMode: 'extend',
        },
      }),
    ])
    expect((event!.payload as { nextAnchorDate: unknown }).nextAnchorDate).toBeNull()
  })

  /**
   * 映射式（ADR-011 §4）：`RoundCompletion = 载荷 + { eventId: event.id, accountId: event.accountId }`。
   *
   * 这里**刻意不走类型断言**：造对象的写法若写成
   * `{ ...(payload as Omit<RoundCompletion,'eventId'>), eventId }`，
   * `RoundCompletion` 新增必填字段时照样编译通过，运行期那个字段是 `undefined`——
   * 对 `accountId` 而言，后果是 `deriveRounds` 把每条完成记录都判成「别的账号的」，
   * **历史轮次全部静默消失**。构造放在 `eventToCompletion`（显式逐字段），
   * 于是「漏字段」是编译错误；本用例再从**库里的那条事件**出发走一遍完整映射。
   */
  it('eventToCompletion 把事件映射成 RoundCompletion（accountId / eventId 取自事件行）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const [appended] = append(account, [completed(templateId)])

    // 从库里读回来，并让 **schema** 收窄载荷类型（不是断言）：顺带证明落库的载荷确实合法
    const stored = readAccountEvents(db, account)[0]!
    const completion = eventToCompletion({
      ...stored,
      payload: roundCompletedPayloadSchema.parse(stored.payload),
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
    expect(completion.templateId).toBe(templateId)
    expect(completion.originalPlannedDate).toBe('2026-09-22')
    expect(completion.nextAnchorDate).toBe('2026-09-24')
  })

  it('账号取自事件行：模板 id 相同、账号不同时，两条完成记录不会被混为一谈', () => {
    // 这正是 accountId 必须进 RoundCompletion 的场景（ADR-011 §4）：
    // §1 的模板主键是 (account_id, id)，模板 id 只在账号内唯一。
    const alice = freshAccount()
    const bob = freshAccount()
    const sharedTemplateId = 'bbbbbbbb-0000-7000-8000-000000000001'
    const [aliceEvent] = append(alice, [completed(sharedTemplateId)])
    const [bobEvent] = append(bob, [completed(sharedTemplateId)])

    const aliceCompletion = eventToCompletion({
      ...aliceEvent!,
      payload: roundCompletedPayloadSchema.parse(aliceEvent!.payload),
    })
    const bobCompletion = eventToCompletion({
      ...bobEvent!,
      payload: roundCompletedPayloadSchema.parse(bobEvent!.payload),
    })
    expect(aliceCompletion.accountId).toBe(alice)
    expect(bobCompletion.accountId).toBe(bob)
    expect(aliceCompletion.templateId).toBe(bobCompletion.templateId)
  })
})

describe('契约缺口：事件层不判「该不该完成」（见交付报告）', () => {
  it('同一轮次完成两次：两条事件都入库，事件层不判重', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const twice = [
      completed(templateId),
      completed(templateId, { occurredAt: '2026-09-23T11:00:00+08:00' }),
    ]
    expect(append(account, twice)).toHaveLength(2)
    expect(readAccountEvents(db, account)).toHaveLength(2)
    // 实例键 =（模板标识 + 原计划日期）的去重不在这里做：ADR-011 §4 规定已完成轮次
    // 「原样返回」，deriveRounds 也不去重。缺口的处置见交付报告。
  })

  it('超出 count / until 的轮次完成事件同样被接受', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const [event] = append(account, [
      completed(templateId, {
        payload: {
          templateId,
          originalPlannedDate: '2027-01-01',
          completedDayKey: '2027-01-01',
          nextAnchorDate: null,
          nextAnchorMode: 'extend',
        },
      }),
    ])
    expect(event!.id).toBeTruthy()
  })

  it('提前完成的锚点若「倒指」，事件层也照收——不变式由 deriveRounds 守（ADR-011 §5）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    // nextAnchorDate ≤ originalPlannedDate：ADR-011 §5 判定为固化值被写坏（500），
    // 但事件层只校验「是不是一个日历日」，不校验锚点不变式。
    const [event] = append(account, [
      completed(templateId, {
        payload: {
          templateId,
          originalPlannedDate: '2026-09-22',
          completedDayKey: '2026-09-22',
          nextAnchorDate: '2026-09-22',
          nextAnchorMode: 'extend',
        },
      }),
    ])
    expect((event!.payload as { nextAnchorDate: string }).nextAnchorDate).toBe('2026-09-22')
  })
})

describe('载荷校验（结构由 zod，语义委托 @shared/recurrence）', () => {
  function rejects(draft: EventDraft, pattern: RegExp): void {
    const account = freshAccount()
    expect(() => append(account, [draft])).toThrow(pattern)
    expect(readAccountEvents(db, account)).toHaveLength(0)
    expect(readProjection(db, account).templates).toHaveLength(0)
  }

  it('count 与 until 并存被拒（RFC 5545 MUST NOT，ADR-011 §2）', () => {
    rejects(
      created('t1', 'A', {
        payload: {
          templateId: 't1',
          title: 'A',
          rule: { freq: 'daily', interval: 1, count: 3, until: '2026-12-31' },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
        },
      }),
      /count-until-exclusive|不得并存/,
    )
  })

  it('byDayOfWeek 用在 daily 上被拒（静默忽略会导出成错误的 RRULE）', () => {
    rejects(
      created('t1', 'A', {
        payload: {
          templateId: 't1',
          title: 'A',
          rule: { freq: 'daily', interval: 1, byDayOfWeek: [1] },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
        },
      }),
      /仅 weekly 使用/,
    )
  })

  it('interval < 1、until 早于 startsOn 都被拒', () => {
    rejects(
      created('t1', 'A', {
        payload: {
          templateId: 't1',
          title: 'A',
          rule: { freq: 'daily', interval: 0 },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
        },
      }),
      /interval/,
    )
    rejects(
      created('t1', 'A', {
        payload: {
          templateId: 't1',
          title: 'A',
          rule: { freq: 'daily', interval: 1, until: '2026-09-01' },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
        },
      }),
      /不得早于/,
    )
  })

  it('载荷不许夹带额外字段（.strict()：多余字段即契约漂移）', () => {
    rejects(
      created('t1', 'A', {
        payload: {
          templateId: 't1',
          title: 'A',
          rule: { freq: 'daily', interval: 1 },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
          nextAnchorDate: '2026-09-23',
        },
      }),
      /载荷不合法/,
    )
  })

  it('锚点模式、标题、模板标识都不得为空或越界', () => {
    rejects(
      created('t1', 'A', {
        payload: {
          templateId: 't1',
          title: 'A',
          rule: { freq: 'daily', interval: 1 },
          nextAnchorMode: 'yolo',
          startsOn: '2026-09-22',
        },
      }),
      /载荷不合法/,
    )
    rejects(
      created('t1', '', {
        payload: {
          templateId: 't1',
          title: '',
          rule: { freq: 'daily', interval: 1 },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
        },
      }),
      /载荷不合法/,
    )
  })

  it('完成事件里的日期必须是真实存在的日历日（「2026-02-31」这类不许入库）', () => {
    rejects(
      completed('t1', {
        payload: {
          templateId: 't1',
          originalPlannedDate: '2026-02-31',
          completedDayKey: '2026-02-28',
          nextAnchorDate: '2026-03-01',
          nextAnchorMode: 'extend',
        },
      }),
      /originalPlannedDate/,
    )
  })
})

describe('标识落点与重放的关系（ADR-011 §6）', () => {
  it('模板事件的 target_kind / target_id 与载荷里的 templateId 一致', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const [event] = append(account, [created(templateId, 'A')])
    expect(event!.targetKind).toBe(RECURRENCE_TEMPLATE_TARGET_KIND)
    expect(event!.targetId).toBe(templateId)
    expect((event!.payload as { templateId: string }).templateId).toBe(templateId)
  })

  it('两列由载荷派生：调用方省掉它们也一样对（无从写错、也无从漏写）', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const [event] = append(account, [created(templateId, 'A', { targetKind: undefined, targetId: undefined })])
    expect(event!.targetKind).toBe(RECURRENCE_TEMPLATE_TARGET_KIND)
    // 重放的折叠用载荷，索引列用派生值——两边同源，故**不存在**「不一致」这个状态
    expect(event!.targetId).toBe((event!.payload as { templateId: string }).templateId)
    expect(readProjection(db, account).templates.map((t) => t.id)).toEqual([templateId])
  })

  it('显式给出且与载荷不符时拒绝写入，而不是静默取其一（ADR-010 §2）', () => {
    const account = freshAccount()
    const truth = tid(account, 'truth')
    const lie = tid(account, 'lie')
    // 这条用例原先断言的是相反的语义（「以载荷为准」，把不一致当合法状态）。
    // 落点改为派生式之后，「两列与载荷不一致」已经**不可达**：这个输入不再是一种
    // 「可容忍的冗余」，而是「同一条事件两份内容」——与 assertSameEvent 同类，
    // 宁可当场拒绝，也不留下一个要靠文档解释的例外。
    expect(() => append(account, [created(lie, '谁说了算', { targetId: truth })])).toThrow(/target_id/)
    expect(() =>
      append(account, [created(lie, '谁说了算', { targetKind: 'something_else' })]),
    ).toThrow(/target_kind/)
    expect(readAccountEvents(db, account)).toHaveLength(0)
  })
})

describe('增量与全量在重复事件上一致（ADR-010 §5）', () => {
  it('建—改—完成—删走一遍，增量结果 == 重建结果', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    append(account, [created(templateId, 'A'), created(tid(account, 't2'), 'B')])
    append(account, [updated(templateId, 'A2'), completed(templateId)])
    append(account, [deleted(tid(account, 't2'), 'B')])

    const incremental = readProjection(db, account)
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
    expect(incremental.templates.map((t) => t.title)).toEqual(['A2'])
  })
})
