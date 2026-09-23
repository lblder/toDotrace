/**
 * `rounds.ts` 的测试矩阵（ADR-013 §3 的跨越点 + ADR-015 §2 的缝合规则 + §后果 的
 * 「缝合不串轮」「非重复实例键」「取消完成」三条回归）。
 *
 * **缝错的症状特别隐蔽**：标题是对的，完成状态却串到了别的轮次——一个「每日复盘」
 * 今天显示「已完成」，而实际完成的是昨天那一轮。界面上看不出任何异常，
 * 用户只会以为自己记错了。因此这里逐天分别查询、逐天断言。
 */
import { describe, expect, it } from 'vitest'

import { deriveRounds } from '@shared/recurrence'

import { effectiveCompletions, eventToCompletion, resolveInstance, roundsOf, toRecurrenceTemplate } from './rounds'
import {
  ACC,
  OTHER_ACC,
  completed,
  dailyRule,
  eventId,
  task,
  taskId,
  uncompleted,
} from './test-fixtures'

const T1 = taskId(1)
const D0 = '2026-09-01'
const D1 = '2026-09-02'
const D2 = '2026-09-03'
const D3 = '2026-09-04'

describe('toRecurrenceTemplate · 任务 → 模板（ADR-013 §3）', () => {
  it('null 当且仅当 task.recurrence === null', () => {
    expect(toRecurrenceTemplate(task({ id: T1 }))).toBeNull()
    expect(toRecurrenceTemplate(task({ id: T1, recurrence: dailyRule() }))).not.toBeNull()
  })

  it('字段逐个搬运，startsOn 原样（**不得由 plannedDate 推导**）', () => {
    // 陷阱场景（ADR-013 §3）：「每周一」起于 9/7，用户把它顺延到 9/23——
    // plannedDate 变了，startsOn 必须仍是 9/7，否则整条序列的相位平移。
    const projected = task({
      id: T1,
      title: '周报',
      recurrence: { rule: { freq: 'weekly', interval: 1, byDayOfWeek: [0] }, nextAnchorMode: 'extend', startsOn: '2026-09-07' },
      plannedDate: '2026-09-23',
      createdAt: '2026-09-07T09:00:00+08:00',
      updatedAt: '2026-09-20T09:00:00+08:00',
    })
    expect(toRecurrenceTemplate(projected)).toEqual({
      id: T1,
      accountId: ACC,
      title: '周报',
      rule: { freq: 'weekly', interval: 1, byDayOfWeek: [0] },
      nextAnchorMode: 'extend',
      startsOn: '2026-09-07',
      createdAt: '2026-09-07T09:00:00+08:00',
      updatedAt: '2026-09-20T09:00:00+08:00',
    })
  })
})

describe('eventToCompletion · 完成事件 → RoundCompletion（ADR-011 §4）', () => {
  it('taskId 映射到 templateId，next 拆成两个字段，eventId/accountId 取自事件行', () => {
    const event = completed(
      7,
      { taskId: T1, originalPlannedDate: D0, completedDayKey: D1, next: { date: D2, mode: 'catch_up' } },
    )
    if (event.type !== 'task/occurrence-completed') throw new Error('夹具类型不对')
    expect(eventToCompletion(event)).toEqual({
      accountId: ACC,
      templateId: T1,
      originalPlannedDate: D0,
      completedDayKey: D1,
      nextAnchorDate: D2,
      nextAnchorMode: 'catch_up',
      eventId: eventId(7),
    })
  })

  it('next === null（没有下一轮）→ nextAnchorDate 为 null，不填越界日期充数', () => {
    const event = completed(8, { taskId: T1, originalPlannedDate: D0, next: null })
    if (event.type !== 'task/occurrence-completed') throw new Error('夹具类型不对')
    const mapped = eventToCompletion(event)
    expect(mapped.nextAnchorDate).toBeNull()
    // 与 `nextAnchorDate` 同生共死：ADR-013 §4.6 的裁决是「宁可让字段可空，
    // 也不填一个无意义的默认值」（那条放宽已落在 `shared/recurrence/types.ts`）
    expect(mapped.nextAnchorMode).toBeNull()
  })

  it('映射结果能直接喂给 deriveRounds（同一份推导，不另写一遍）', () => {
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: D0, next: { date: D1, mode: 'catch_up' } }),
    ]
    const closed = events.map((event) => {
      if (event.type !== 'task/occurrence-completed') throw new Error('夹具类型不对')
      return eventToCompletion(event)
    })
    expect(deriveRounds(toRecurrenceTemplate(task({ id: T1, recurrence: dailyRule() }))!, closed, D1)).toEqual([
      { templateId: T1, originalPlannedDate: D0, status: 'completed', completedDayKey: D0, title: '任务' },
      { templateId: T1, originalPlannedDate: D1, status: 'pending', title: '任务' },
    ])
  })
})

describe('缝合不串轮（ADR-015 §后果 的回归）', () => {
  const projected = task({ id: T1, recurrence: dailyRule(), indexDate: D0 })
  // 「每日」任务连续完成 3 天：D0、D1、D2 各自在当天完成
  const events = [
    completed(1, { taskId: T1, originalPlannedDate: D0, completedDayKey: D0, next: { date: D1, mode: 'catch_up' } }),
    completed(2, { taskId: T1, originalPlannedDate: D1, completedDayKey: D1, next: { date: D2, mode: 'catch_up' } }),
    completed(3, { taskId: T1, originalPlannedDate: D2, completedDayKey: D2, next: { date: D3, mode: 'catch_up' } }),
  ]

  it('逐天分别查询：各返回该天的 occurrenceKey 与完成态', () => {
    const at0 = resolveInstance(projected, events, D0)
    expect(at0.occurrenceKey).toBe(D0)
    expect(at0.completion?.payload.completedDayKey).toBe(D0)

    const at1 = resolveInstance(projected, events, D1)
    expect(at1.occurrenceKey).toBe(D1)
    expect(at1.completion?.payload.completedDayKey).toBe(D1)

    const at2 = resolveInstance(projected, events, D2)
    expect(at2.occurrenceKey).toBe(D2)
    expect(at2.completion?.payload.completedDayKey).toBe(D2)
  })

  it('**今天的完成不得被昨天的那一轮顶替**（D3 查询：轮次是 D3、未完成）', () => {
    const at3 = resolveInstance(projected, events, D3)
    expect(at3.occurrenceKey).toBe(D3)
    expect(at3.completion).toBeNull()
    // 反面对照：如果实现按 `taskId` 匹配完成记录（不比对实例键），这里会拿到 D2 的完成
    expect(at3.pending).toBe(D3)
  })

  it('**昨天的完成不得把今天标成已完成**（只完成 D0、D1 时查 D2）', () => {
    const onlyTwo = events.slice(0, 2)
    const at2 = resolveInstance(projected, onlyTwo, D2)
    expect(at2.occurrenceKey).toBe(D2)
    expect(at2.completion).toBeNull()
    expect(at2.pending).toBe(D2)
    // 同一份数据在 D1 上仍是已完成——「不得标成已完成」不是「再也不显示完成」
    expect(resolveInstance(projected, onlyTwo, D1).completion).not.toBeNull()
  })

  it('已完成轮次原样保留（历史不因为推进入下一轮而消失）', () => {
    expect(roundsOf(projected, events, D3).map((round) => `${round.originalPlannedDate}:${round.status}`)).toEqual([
      `${D0}:completed`,
      `${D1}:completed`,
      `${D2}:completed`,
      `${D3}:pending`,
    ])
  })
})

describe('非重复任务的唯一实例（ADR-015 §2 的新增分支）', () => {
  const indexDate = '2026-09-10'
  const base = task({ id: T1, indexDate, plannedDate: indexDate })

  it('实例键恒为 indexDate；**顺延 plannedDate 后不变、已完成态不丢**', () => {
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: indexDate, completedDayKey: indexDate, next: null }),
    ]
    const before = resolveInstance(base, events, '2026-09-10')
    expect(before.occurrenceKey).toBe(indexDate)
    expect(before.completion).not.toBeNull()

    const rescheduled = { ...base, plannedDate: '2026-09-25' }
    const after = resolveInstance(rescheduled, events, '2026-09-22')
    expect(after.occurrenceKey).toBe(indexDate) // ← 与当前 plannedDate 无关
    expect(after.completion).not.toBeNull() // ← 已完成态不丢
  })

  it('未完成时 occurrenceKey 仍是 indexDate，且 **pending 恒为 false**（不是「待完成轮次」）', () => {
    const resolved = resolveInstance(base, [], '2026-09-22')
    expect(resolved.occurrenceKey).toBe(indexDate)
    expect(resolved.completion).toBeNull()
    expect(resolved.pending).toBeNull()
  })

  it('完成事件不落在 indexDate 上时不算完成（补记别的日期不影响本实例）', () => {
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: '2026-09-30', completedDayKey: '2026-09-30', next: null }),
    ]
    expect(resolveInstance(base, events, '2026-09-22').completion).toBeNull()
  })
})

describe('取消完成（ADR-015 §后果 的回归，防「存在即完成」的退化实现）', () => {
  const indexDate = '2026-09-01'
  const projected = task({ id: T1, indexDate })

  it('非重复：完成 → 取消后为**未完成**', () => {
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: indexDate, completedDayKey: indexDate, next: null }),
      uncompleted(2, { taskId: T1, originalPlannedDate: indexDate }),
    ]
    expect(resolveInstance(projected, events, indexDate).completion).toBeNull()
    // 退化实现（「存在任意一条完成事件即已完成」）会在这里返回非 null
    expect(effectiveCompletions(projected, events)).toEqual([])
  })

  it('非重复：完成 → 取消 → 完成，三次之后为**已完成**（且取最后一条的时刻）', () => {
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: indexDate, completedDayKey: indexDate, next: null }),
      uncompleted(2, { taskId: T1, originalPlannedDate: indexDate }),
      completed(3, { taskId: T1, originalPlannedDate: indexDate, completedDayKey: indexDate, next: null }),
    ]
    const resolved = resolveInstance(projected, events, indexDate)
    expect(resolved.completion).not.toBeNull()
    expect(resolved.completion?.eventId).toBe(eventId(3)) // 「最后一条」按事件 id 序（ADR-001 §2）
  })

  it('重复任务：取消完成让该轮**回到待完成**（不靠删除事件）', () => {
    const recurring = task({ id: T1, recurrence: dailyRule(), indexDate: D0 })
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: D0, completedDayKey: D0, next: { date: D1, mode: 'catch_up' } }),
      uncompleted(2, { taskId: T1, originalPlannedDate: D0 }),
    ]
    const resolved = resolveInstance(recurring, events, D0)
    expect(resolved.occurrenceKey).toBe(D0)
    expect(resolved.completion).toBeNull()
    expect(resolved.pending).toBe(D0)
    // 退化实现会拿被取消那条固化的 nextAnchorDate（D1）继续推进，
    // 于是 D0 仍显示已完成、或下一轮跳到 D1——两者都被上面两条断言挡住。
  })

  it('事件顺序被打乱时仍按事件 id 取「最后一条」（不看数组顺序）', () => {
    const events = [
      uncompleted(2, { taskId: T1, originalPlannedDate: indexDate }),
      completed(1, { taskId: T1, originalPlannedDate: indexDate, completedDayKey: indexDate, next: null }),
    ]
    expect(resolveInstance(projected, events, indexDate).completion).toBeNull()
  })
})

describe('账号隔离（ADR-011 §4：跨账号串台防线）', () => {
  it('他人账号的同 id 完成记录**不**影响本账号的轮次', () => {
    const projected = task({ id: T1, indexDate: '2026-09-01' })
    const events = [
      completed(1, { taskId: T1, originalPlannedDate: '2026-09-01', next: null }, OTHER_ACC),
    ]
    expect(resolveInstance(projected, events, '2026-09-01').completion).toBeNull()
    // 漏了这层过滤的症状是「B 导入 A 的文件后，A 的完成记录让 B 的轮次也变成已完成」，且不报错
    expect(resolveInstance(projected, events, '2026-09-01').occurrenceKey).toBe('2026-09-01')
  })
})

describe('一轮都没有的重复任务（startsOn 在未来，ADR-013 §3.3）', () => {
  it('occurrenceKey 回落成 indexDate，但 pending 为 false（不假装有轮次）', () => {
    const projected = task({
      id: T1,
      indexDate: '2026-09-01',
      recurrence: { rule: { freq: 'weekly', interval: 1, byDayOfWeek: [0] }, nextAnchorMode: 'catch_up', startsOn: '2026-09-28' },
    })
    const resolved = resolveInstance(projected, [], '2026-09-22')
    expect(resolved.rounds).toEqual([])
    expect(resolved.occurrenceKey).toBe('2026-09-01')
    expect(resolved.pending).toBeNull()
  })
})
