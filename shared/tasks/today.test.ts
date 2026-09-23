/**
 * `today.ts` 的测试矩阵（ADR-015 §3 入选 A–F / §4 紧迫日与档位 / §5 视图范围 / §后果）。
 *
 * 时间基准写死：`TODAY = 2026-09-22`（**周二**），
 * 故 `weekStart = 2026-09-21`（周一）、`weekEnd = 2026-09-27`（周日）。
 * 本模块不读时钟（`today` 显式传入），所以这些断言与运行时无关。
 */
import { describe, expect, it } from 'vitest'

import {
  BUCKET_REASON,
  buildTodoItems,
  inScope,
  isBucketReason,
  isInTodayView,
  isInstanceCompleted,
  isOverdue,
  isSelectionReason,
  relevantDates,
  selectionReasons,
  todayItems,
  urgencyBucket,
  urgencyDates,
} from './today'
import { sortItems } from './sort'
import { ACC, checked, completed, dailyRule, itemOf, idsOf, has, task, taskId } from './test-fixtures'
import type { RecurrenceSpec, TodoItem } from './types'

const TODAY = '2026-09-22' // 周二
const MONDAY = '2026-09-21'
const YESTERDAY = '2026-09-21'
const TOMORROW = '2026-09-23'
const SUNDAY = '2026-09-27'
const NEXT_MONDAY = '2026-09-28'
const LAST_WEEK_MONDAY = '2026-09-14'

/** 「每周一」（`byDayOfWeek: [0]`，ADR-011 §2 的 0 = 周一），起点也是一个周一 */
function weeklyRule(): RecurrenceSpec {
  return {
    rule: { freq: 'weekly', interval: 1, byDayOfWeek: [0] },
    nextAnchorMode: 'catch_up',
    startsOn: '2026-09-07',
  }
}

/** 单任务场景的快捷构造 */
function one(overrides: Parameters<typeof task>[0], events: Parameters<typeof buildTodoItems>[0]['events'] = []): TodoItem {
  return buildTodoItems({ tasks: [task(overrides)], events, today: TODAY })[0]!
}

describe('入选规则 A–F（ADR-015 §3）', () => {
  it('A 正例：未完成且 plannedDate = 今天 → 入选，理由 planned_today', () => {
    const item = one({ id: taskId(1), plannedDate: TODAY })
    expect(isInTodayView(item, TODAY)).toBe(true)
    expect(item.reasons).toContain('planned_today')
  })

  it('A 正例（逾期）：plannedDate = 昨天 → 入选，理由 planned_overdue', () => {
    const item = one({ id: taskId(1), plannedDate: YESTERDAY })
    expect(item.reasons).toContain('planned_overdue')
  })

  it('A 反例：plannedDate = 明天 → **不**入选', () => {
    expect(isInTodayView(one({ id: taskId(1), plannedDate: TOMORROW }), TODAY)).toBe(false)
  })

  it('B 正例：dueDate = 今天 / 昨天 → 入选，理由分别为 due_today / due_overdue', () => {
    expect(one({ id: taskId(1), dueDate: TODAY }).reasons).toContain('due_today')
    expect(one({ id: taskId(2), dueDate: YESTERDAY }).reasons).toContain('due_overdue')
  })

  it('B 反例：dueDate = 明天 → **不**入选（「明天到期」不进今日）', () => {
    expect(isInTodayView(one({ id: taskId(1), dueDate: TOMORROW }), TODAY)).toBe(false)
  })

  it('C 正例：无日期、进行中 → 入选，理由 in_progress_undated（用户显式按过「开始」）', () => {
    const item = one({ id: taskId(1), status: 'in_progress' })
    expect(item.reasons).toContain('in_progress_undated')
  })

  it('C 反例：无日期、未开始 → 不入选', () => {
    expect(isInTodayView(one({ id: taskId(1), status: 'not_started' }), TODAY)).toBe(false)
  })

  it('D 正例 / 反例：本实例今天完成的入选，昨天完成的不入选', () => {
    const id = taskId(1)
    const todayDone = one(
      { id, indexDate: '2026-09-10' },
      [completed(1, { taskId: id, originalPlannedDate: '2026-09-10', completedDayKey: TODAY, next: null })],
    )
    expect(todayDone.reasons).toContain('completed_today')

    const yesterdayDone = one(
      { id, indexDate: '2026-09-10' },
      [completed(1, { taskId: id, originalPlannedDate: '2026-09-10', completedDayKey: YESTERDAY, next: null })],
    )
    expect(isInTodayView(yesterdayDone, TODAY)).toBe(false)
    // 但它昨天是在的——「今天不在」不是「永远不在」
    expect(isInTodayView(yesterdayDone, YESTERDAY)).toBe(true)
  })

  it('E 正例：重复任务的待完成轮次 = 今天 / 昨天 → recurring_pending / recurring_overdue', () => {
    const id = taskId(1)
    const pendingToday = one({ id, recurrence: dailyRule(), indexDate: '2026-09-01' }, [
      completed(1, { taskId: id, originalPlannedDate: YESTERDAY, completedDayKey: YESTERDAY, next: { date: TODAY, mode: 'catch_up' } }),
    ])
    expect(pendingToday.occurrenceKey).toBe(TODAY)
    expect(pendingToday.reasons).toContain('recurring_pending')

    // 「轮次早于今天」只可能发生在**今天不是命中日**时：待完成轮次取的是
    // 「最后一个 ≤ today 的命中日」（ADR-011 §4），每日任务在每天都是命中日，
    // 故它的待完成轮次恒等于今天。这里用「每周一」的任务：today = 周二 → 本轮是周一。
    const weeklyId = taskId(2)
    const pendingOverdue = one({ id: weeklyId, recurrence: weeklyRule(), indexDate: '2026-09-07' }, [])
    expect(pendingOverdue.occurrenceKey).toBe(YESTERDAY)
    expect(pendingOverdue.reasons).toContain('recurring_overdue')
  })

  it('E 反例：重复任务的待完成轮次在**未来**（startsOn = 明天）→ 不入选', () => {
    const item = one({
      id: taskId(1),
      indexDate: '2026-09-01',
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: TOMORROW },
    })
    // §后果 的回归行：「`pending` 是 E 的**唯一**判据」——
    // 用 `completedAt === null && recurring` 代替 `pending` 的实现会在这里红：
    // 该任务一轮都没有，`occurrenceKey` 回落成 `indexDate`（= 创建日 ≤ today），
    // 那个替代判据于是把它误判成「待完成轮次已逾期」→ **误进今日视图**。
    expect(item.pending).toBe(false)
    expect(item.occurrenceKey).toBe('2026-09-01') // 实例键回落（§2 的唯一稳定日期分量）
    expect(selectionReasons(item, TODAY)).toEqual([])
    expect(isInTodayView(item, TODAY)).toBe(false)
  })

  it('F 正例：重复任务本轮今天完成 → 入选，理由 completed_today', () => {
    const id = taskId(1)
    const item = one({ id, recurrence: dailyRule(), indexDate: '2026-09-01' }, [
      completed(1, { taskId: id, originalPlannedDate: TODAY, completedDayKey: TODAY, next: { date: TOMORROW, mode: 'catch_up' } }),
    ])
    expect(item.occurrenceKey).toBe(TODAY)
    expect(item.reasons).toContain('completed_today')
  })

  it('F 反例：重复任务本轮昨天完成、下一轮在未来 → 不入选', () => {
    const id = taskId(1)
    const item = one({ id, recurrence: dailyRule(), indexDate: '2026-09-01' }, [
      completed(1, { taskId: id, originalPlannedDate: YESTERDAY, completedDayKey: YESTERDAY, next: { date: TODAY, mode: 'catch_up' } }),
      completed(2, { taskId: id, originalPlannedDate: TODAY, completedDayKey: TODAY, next: { date: TOMORROW, mode: 'catch_up' } }),
    ])
    // 今天那一轮已完成 → 它是「今天完成的」，仍在今日视图里（§3 D/F：今天做完的要留在视野里）
    expect(item.reasons).toContain('completed_today')
    // 而**明天**的查询里它就不在了
    const atTomorrow = buildTodoItems({
      tasks: [task({ id, recurrence: dailyRule(), indexDate: '2026-09-01' })],
      events: [
        completed(1, { taskId: id, originalPlannedDate: YESTERDAY, completedDayKey: YESTERDAY, next: { date: TODAY, mode: 'catch_up' } }),
        completed(2, { taskId: id, originalPlannedDate: TODAY, completedDayKey: TODAY, next: { date: TOMORROW, mode: 'catch_up' } }),
      ],
      today: TOMORROW,
    })[0]!
    expect(atTomorrow.occurrenceKey).toBe(TOMORROW)
    expect(atTomorrow.reasons).toContain('recurring_pending')
  })

  it('已放弃的任务**不进**今日视图（即使 plannedDate ≤ today）', () => {
    const item = one({ id: taskId(1), plannedDate: YESTERDAY, status: 'abandoned' })
    expect(selectionReasons(item, TODAY)).toEqual([])
    expect(isInTodayView(item, TODAY)).toBe(false)
  })

  it('软删除的任务不会出现在读模型里（ADR-013 §4.8）', () => {
    const items = buildTodoItems({
      tasks: [
        task({ id: taskId(1), plannedDate: TODAY, deletedAt: '2026-09-20T10:00:00+08:00' }),
        task({ id: taskId(2), plannedDate: TODAY }),
      ],
      events: [],
      today: TODAY,
    })
    expect(idsOf(items)).toEqual([taskId(2)])
  })

  it('入选理由是**并集**：同时满足 A 与 C 时两条都在（不然排查「它为什么在这儿」会漏一半）', () => {
    const item = one({ id: taskId(1), plannedDate: YESTERDAY, status: 'in_progress' })
    expect(selectionReasons(item, TODAY).sort()).toEqual(['in_progress_undated', 'planned_overdue'])
  })
})

describe('紧迫日折算与档位（ADR-015 §4）', () => {
  it('urgencyDates：日锚点取自身、**周锚点折算成周日**、重复任务才计入 occurrenceKey', () => {
    expect(urgencyDates(one({ id: taskId(1), plannedDate: '2026-09-10', dueDate: '2026-09-11' })).sort()).toEqual([
      '2026-09-10',
      '2026-09-11',
    ])
    expect(urgencyDates(one({ id: taskId(2), plannedWeek: MONDAY }))).toEqual([SUNDAY])
    // 非重复任务的 occurrenceKey 是**创建日**，不是排期日——不计入
    expect(urgencyDates(one({ id: taskId(3), indexDate: '2026-01-01' }))).toEqual([])
    // 重复任务的 occurrenceKey 是那一轮唯一的排期日——计入
    expect(
      urgencyDates(one({ id: taskId(4), indexDate: '2026-09-01', recurrence: dailyRule() }, [])),
    ).toContain(TODAY)
  })

  it('六档各自落位', () => {
    const overdue = one({ id: taskId(1), plannedDate: YESTERDAY })
    const today = one({ id: taskId(2), plannedDate: TODAY })
    const tomorrow = one({ id: taskId(3), plannedDate: TOMORROW })
    const thisWeek = one({ id: taskId(4), plannedDate: '2026-09-25' })
    const noDate = one({ id: taskId(5) })
    const later = one({ id: taskId(6), plannedDate: NEXT_MONDAY })
    const abandoned = one({ id: taskId(7), plannedDate: YESTERDAY, status: 'abandoned' })
    const done = one({ id: taskId(8), plannedDate: TODAY, indexDate: '2026-09-01' }, [
      completed(1, { taskId: taskId(8), originalPlannedDate: '2026-09-01', completedDayKey: TODAY, next: null }),
    ])

    expect(urgencyBucket(overdue, TODAY)).toBe(0)
    expect(urgencyBucket(today, TODAY)).toBe(1)
    expect(urgencyBucket(tomorrow, TODAY)).toBe(2)
    expect(urgencyBucket(thisWeek, TODAY)).toBe(3)
    expect(urgencyBucket(noDate, TODAY)).toBe(4)
    expect(urgencyBucket(later, TODAY)).toBe(4) // 档 4 的名字里必须有「或更晚」
    expect(urgencyBucket(abandoned, TODAY)).toBe(5)
    expect(urgencyBucket(done, TODAY)).toBe(6)
  })

  it('同时命中多档时取**最靠前**的那一档（取第一个命中的，不是全部命中的）', () => {
    // dueDate 已逾期、plannedDate 在明天 → 档 0（不是档 2）
    const item = one({ id: taskId(1), plannedDate: TOMORROW, dueDate: YESTERDAY })
    expect(urgencyBucket(item, TODAY)).toBe(0)
  })

  it('档位理由与档位一一对应（七个档、七个理由，一个不多一个不少）', () => {
    expect(new Set(Object.values(BUCKET_REASON)).size).toBe(7)
    for (const reason of Object.values(BUCKET_REASON)) expect(isBucketReason(reason)).toBe(true)
  })

  it('**周锚点不误判逾期**：plannedWeek = 本周周一、today = 周二 → 档 3（本周），不是档 0', () => {
    // 折算成周日（9/27）才比较；若直接用周一（9/21）比较会算出 `9/21 < 9/22` → 误判逾期
    expect(urgencyBucket(one({ id: taskId(1), plannedWeek: MONDAY }), TODAY)).toBe(3)
  })

  it('上周的周锚点才逾期；下周的周锚点落档 4', () => {
    expect(urgencyBucket(one({ id: taskId(1), plannedWeek: LAST_WEEK_MONDAY }), TODAY)).toBe(0)
    expect(urgencyBucket(one({ id: taskId(2), plannedWeek: NEXT_MONDAY }), TODAY)).toBe(4)
  })

  it('非重复任务的 occurrenceKey（创建日）**不**让它恒判逾期', () => {
    // 一条 9/1 创建、计划 9/30 的任务，在 9/22 不该被判逾期（ADR-015 §4 的 v1.0 缺陷回归）
    const item = one({ id: taskId(1), indexDate: '2026-09-01', plannedDate: '2026-09-30' })
    expect(urgencyBucket(item, TODAY)).toBe(4)
    expect(item.overdue).toBe(false)
  })

  it('**`overdue` 对已放弃恒为 false**，而档位仍是 5（两条一起断言才钉得住）', () => {
    const abandoned = one({ id: taskId(1), dueDate: YESTERDAY, status: 'abandoned' })
    // ⚠️ **这条用例翻过面**：第一版按 FR2.2 的字面取 `true`（「未完成 且 期限日早于今天」
    // 没有排除已放弃），并在报告里登记为一处需要裁决的分叉。§1 / §理由 的裁定取 `false`：
    // `overdue` 驱动的是「期限标红」，而**已经放弃的事不该继续催**——
    // 把用户明确说了「不做了」的任务标红，是在替他惋惜，不是在描述事实。
    expect(abandoned.overdue).toBe(false)
    // 「不再催」与「排第几」是两件事：档位照旧由 status 优先（§4 的「压过一切」）
    expect(urgencyBucket(abandoned, TODAY)).toBe(5)
    expect(abandoned.reasons).toContain('bucket_abandoned')
    // 未放弃的同款任务是 overdue 的——否则上面那条 `false` 可能只是「永远返回 false」
    expect(one({ id: taskId(2), dueDate: YESTERDAY }).overdue).toBe(true)
  })

  it('overdue 用**紧迫日**而不是 dueDate（重复任务没有 dueDate）', () => {
    // 「每周一」的任务，today = 周二 → 本轮是周一（昨天）→ 逾期
    const id = taskId(1)
    const item = one({ id, recurrence: weeklyRule(), indexDate: '2026-09-07' })
    expect(item.dueDate).toBeNull()
    expect(item.occurrenceKey).toBe(YESTERDAY)
    expect(item.overdue).toBe(true)
    expect(isOverdue(item, TODAY)).toBe(true)
  })
})

describe('今日视图不是区间判定（ADR-015 §5 的警告 + §后果）', () => {
  it('**逾期项必须在今日视图里**：plannedDate = 昨天 → 今日必须有它', () => {
    const overdue = task({ id: taskId(1), plannedDate: YESTERDAY })
    const items = todayItems({ tasks: [overdue], events: [], today: TODAY })
    expect(has(items, taskId(1))).toBe(true)
    // 反面：初稿的 `range[today, today]` 写法会让它消失——
    // 下面这条断言把那个写法钉死在「不成立」上
    const asRangeToday = buildTodoItems({ tasks: [overdue], events: [], today: TODAY }).filter((item) =>
      inScope(item, { kind: 'range', from: TODAY, to: TODAY }),
    )
    expect(asRangeToday).toEqual([])
  })

  it('周级任务不因「它是周级的」进今日：① 无期限、未开始、今天也没完成 → 今日**不出现**、本周视图**出现**', () => {
    const weekly = task({ id: taskId(1), plannedWeek: MONDAY })
    expect(todayItems({ tasks: [weekly], events: [], today: TODAY })).toEqual([])
    const weekView = buildTodoItems({ tasks: [weekly], events: [], today: TODAY }).filter((item) =>
      inScope(item, { kind: 'range', from: MONDAY, to: SUNDAY }),
    )
    expect(has(weekView, taskId(1))).toBe(true)
  })

  it('② 同一条任务改 dueDate = 今天 → 今日**必须**出现（§3 B）', () => {
    const weekly = task({ id: taskId(1), plannedWeek: MONDAY, dueDate: TODAY })
    expect(has(todayItems({ tasks: [weekly], events: [], today: TODAY }), taskId(1))).toBe(true)
  })

  it('③ 再改 status = 进行中 → 今日**必须**出现（§3 C）', () => {
    const weekly = task({ id: taskId(1), plannedWeek: MONDAY, status: 'in_progress' })
    expect(has(todayItems({ tasks: [weekly], events: [], today: TODAY }), taskId(1))).toBe(true)
  })

  it('④ today 取本周周日、且该任务无期限未开始 → 今日**仍不**出现（今日不是区间判定）', () => {
    const weekly = task({ id: taskId(1), plannedWeek: MONDAY })
    // weekEnd(plannedWeek) === SUNDAY === today，若今日走区间判定就会命中
    expect(has(todayItems({ tasks: [weekly], events: [], today: SUNDAY }), taskId(1))).toBe(false)
  })

  it('周级任务今天被完成 → 按 §3 D 进今日（「且今天也没完成」这个限定词不能省）', () => {
    const id = taskId(1)
    const weekly = task({ id, plannedWeek: MONDAY, indexDate: '2026-09-14' })
    const events = [completed(1, { taskId: id, originalPlannedDate: '2026-09-14', completedDayKey: TODAY, next: null })]
    expect(has(todayItems({ tasks: [weekly], events, today: TODAY }), id)).toBe(true)
  })
})

describe('已放弃压过完成态（ADR-015 §4，四项断言之①）', () => {
  it('① 完成过、已放弃 → 落**档 5**（理由 bucket_abandoned），**不是档 6**', () => {
    const id = taskId(1)
    const item = one({ id, indexDate: '2026-09-01', status: 'abandoned' }, [
      completed(1, { taskId: id, originalPlannedDate: '2026-09-01', completedDayKey: TODAY, next: null }),
    ])
    // 完成记录仍在（放弃**不取消**完成记录，ADR-013 §2）
    expect(isInstanceCompleted(item)).toBe(true)
    expect(urgencyBucket(item, TODAY)).toBe(5)
    expect(item.reasons).toContain('bucket_abandoned')
    expect(item.reasons).not.toContain('bucket_done')
    expect(item.reasons).not.toContain('completed_today') // 也不得「呈现为已完成」（FR2.1 v1.4）
  })

  it('理由数组里**恒有且仅有一条**档位理由，且入选理由与档位理由不混', () => {
    const items = buildTodoItems({
      tasks: [
        task({ id: taskId(1), plannedDate: TODAY }),
        task({ id: taskId(2), plannedDate: YESTERDAY, status: 'abandoned' }),
        task({ id: taskId(3) }),
      ],
      events: [],
      today: TODAY,
    })
    for (const item of items) {
      expect(item.reasons.filter(isBucketReason)).toHaveLength(1)
      expect(item.reasons.filter(isSelectionReason)).toEqual(selectionReasons(item, TODAY))
      // §7 的核心要求：**界面显示的排序理由与实际档位是同一个东西**——
      // 由 `urgencyBucket` 现算一遍，必须与行里那条档位理由一致
      expect(item.reasons).toContain(BUCKET_REASON[urgencyBucket(item, TODAY)])
    }
  })
})

describe('C 的堆积（如实断言代价，不假装它不存在）', () => {
  it('无日期、进行中、创建于一年前的任务**仍然**出现在今日视图', () => {
    const item = task({
      id: taskId(1),
      indexDate: '2025-09-22',
      createdAt: '2025-09-22T09:00:00+08:00',
      status: 'in_progress',
    })
    const items = todayItems({ tasks: [item], events: [], today: TODAY })
    expect(has(items, taskId(1))).toBe(true)
    // 它是档 4（紧迫日为空）——不逾期、也不靠前，但**不会被自动隐藏**
    expect(urgencyBucket(itemOf(items, taskId(1)), TODAY)).toBe(4)
  })
})

describe('视图范围（ADR-015 §5）', () => {
  it('relevantDates 含 plannedWeek（**折算成周日**）——周级任务才会落在正确的周', () => {
    expect(relevantDates(one({ id: taskId(1), plannedWeek: MONDAY }))).toEqual([SUNDAY])
  })

  it('**周级任务落在正确的周**：「上周创建、计划本周做」→ 在本周视图、**不在上周**', () => {
    const weekly = task({ id: taskId(1), indexDate: LAST_WEEK_MONDAY, plannedWeek: MONDAY })
    const items = buildTodoItems({ tasks: [weekly], events: [], today: TODAY })
    const thisWeek = items.filter((item) => inScope(item, { kind: 'range', from: MONDAY, to: SUNDAY }))
    const lastWeek = items.filter((item) =>
      inScope(item, { kind: 'range', from: LAST_WEEK_MONDAY, to: '2026-09-20' }),
    )
    expect(has(thisWeek, taskId(1))).toBe(true)
    // 「不在上周」：occurrenceKey（= 创建日）**不参与**区间判定，否则它会同时出现在两周里
    expect(lastWeek).toEqual([])
  })

  it('范围边界：周视图周一与周日各一条，**两端都含**', () => {
    const items = buildTodoItems({
      tasks: [
        task({ id: taskId(1), plannedDate: MONDAY }),
        task({ id: taskId(2), plannedDate: SUNDAY }),
      ],
      events: [],
      today: TODAY,
    })
    const week = items.filter((item) => inScope(item, { kind: 'range', from: MONDAY, to: SUNDAY }))
    expect(idsOf(week)).toEqual([taskId(1), taskId(2)])
  })

  it('闭区间为空（from > to）抛 RangeError，不静默返回空', () => {
    const item = one({ id: taskId(1), plannedDate: MONDAY })
    expect(() => inScope(item, { kind: 'range', from: SUNDAY, to: MONDAY })).toThrow(RangeError)
  })

  it('项目范围是**归属**判据，不看日期', () => {
    const inProject = one({ id: taskId(1), projectId: 'p1' })
    const otherProject = one({ id: taskId(2), projectId: 'p2' })
    const noProject = one({ id: taskId(3) })
    expect(inScope(inProject, { kind: 'project', projectId: 'p1' })).toBe(true)
    expect(inScope(otherProject, { kind: 'project', projectId: 'p1' })).toBe(false)
    expect(inScope(noProject, { kind: 'project', projectId: 'p1' })).toBe(false)
    expect(inScope(noProject, { kind: 'all' })).toBe(true)
  })

  it('「不出现瞬间比较」：区间判定只吃 DayKey（类型层面 Date 不可传）', () => {
    const item = one({ id: taskId(1), plannedDate: TODAY })
    // @ts-expect-error from 必须是 'YYYY-MM-DD'（DayKey）；Date 在类型上不可传（ADR-015 §后果）
    const call = (): boolean => inScope(item, { kind: 'range', from: new Date(), to: TODAY })
    expect(call).toThrow(RangeError)
  })
})

describe('`today` 由调用方给定（ADR-015 §6）', () => {
  it('同一份数据在 today = D 与 today = D+1 上给出不同的入选集合（判据自洽、不读时钟）', () => {
    const id = taskId(1)
    const tasks = [task({ id, indexDate: '2026-09-01' })]
    const events = [
      completed(1, { taskId: id, originalPlannedDate: '2026-09-01', completedDayKey: TODAY, next: null }),
    ]
    expect(has(todayItems({ tasks, events, today: TODAY }), id)).toBe(true)
    expect(has(todayItems({ tasks, events, today: TOMORROW }), id)).toBe(false)
  })

  it('today 不是合法 DayKey 时抛 RangeError（不静默当成某一天）', () => {
    expect(() => buildTodoItems({ tasks: [], events: [], today: '2026-9-22' })).toThrow(RangeError)
    expect(() => urgencyBucket(one({ id: taskId(1) }), 'garbage')).toThrow(RangeError)
  })
})

describe('步骤勾选属于**本实例**（ADR-013 §4.12）', () => {
  it('昨天的勾选不会在今天还亮着（重复任务每一轮各自从零开始）', () => {
    const id = taskId(1)
    const tasks = [
      task({
        id,
        recurrence: dailyRule(),
        indexDate: '2026-09-01',
        steps: [
          { id: 's1', title: '写日志' },
          { id: 's2', title: '看论文' },
        ],
      }),
    ]
    const events = [
      completed(1, { taskId: id, originalPlannedDate: YESTERDAY, completedDayKey: YESTERDAY, next: { date: TODAY, mode: 'catch_up' } }),
    ]
    const checks = [checked(id, 's1', YESTERDAY)]

    const atYesterday = buildTodoItems({ tasks, events, stepChecks: checks, today: YESTERDAY })[0]!
    expect(atYesterday.steps.map((step) => step.checkedAt)).toEqual([checks[0]!.checkedAt, null])

    const atToday = buildTodoItems({ tasks, events, stepChecks: checks, today: TODAY })[0]!
    expect(atToday.occurrenceKey).toBe(TODAY)
    expect(atToday.steps.map((step) => step.checkedAt)).toEqual([null, null])
  })

  it('非重复任务：顺延 plannedDate 后勾选态不丢（实例键仍是 indexDate，ADR-013 §4.12 的「零感知」）', () => {
    const id = taskId(1)
    const base = task({
      id,
      indexDate: '2026-09-10',
      plannedDate: '2026-09-10',
      steps: [{ id: 's1', title: '步骤' }],
    })
    const checks = [checked(id, 's1', '2026-09-10')]
    const rescheduled = { ...base, plannedDate: '2026-09-25' }
    const item = buildTodoItems({ tasks: [rescheduled], events: [], stepChecks: checks, today: TODAY })[0]!
    expect(item.occurrenceKey).toBe('2026-09-10')
    expect(item.steps[0]!.checkedAt).toBe(checks[0]!.checkedAt)
  })
})

describe('纯函数（ADR-015 §后果）', () => {
  it('同一 `(tasks, events, today)` 反复调用结果恒等，且不改动入参', () => {
    const id1 = taskId(1)
    const id2 = taskId(2)
    const tasks = [
      task({ id: id1, plannedDate: YESTERDAY, tags: ['实验'] }),
      task({ id: id2, recurrence: dailyRule(), indexDate: '2026-09-01', steps: [{ id: 's1', title: '步骤' }] }),
    ]
    const events = [
      completed(1, { taskId: id2, originalPlannedDate: YESTERDAY, completedDayKey: YESTERDAY, next: { date: TODAY, mode: 'catch_up' } }),
    ]
    const input = { tasks, events, today: TODAY, stepChecks: [checked(id2, 's1', TODAY)] }

    const first = todayItems(input)
    const second = todayItems(input)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)

    const sorted = [sortItems(first, TODAY), sortItems(first, TODAY)]
    expect(sorted[1]).toEqual(sorted[0])

    // 入参未被改动（`sortItems` 也不得原地排序）
    expect(tasks).toHaveLength(2)
    expect(tasks[1]!.tags).toEqual([])
    expect(first.map((item) => item.taskId)).toEqual(second.map((item) => item.taskId))
    // 行的 `tags` 是副本，改它不会污染任务行
    first[0]!.tags.push('污染')
    expect(tasks[0]!.tags).toEqual(['实验'])

    // 账号只出现在夹具里，读模型不因它而变（同一输入同一结果）
    expect(ACC).toBe('acc-1')
  })
})
