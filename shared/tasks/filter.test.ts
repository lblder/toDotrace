/**
 * `filter.ts` 的测试矩阵（ADR-015 §4 的优先级表 / §5 的项目视图 / §后果）。
 *
 * 四条断言的落点：**已放弃压过完成态**的 ②③④ 在本文件（① 是档位，在 `today.test.ts`）。
 */
import { describe, expect, it } from 'vitest'

import { isOutsideProjectRange, matchesQuery, queryItems } from './filter'
import type { TaskQuery } from './filter'
import { buildTodoItems } from './today'
import { completed, dailyRule, idsOf, task, taskId } from './test-fixtures'
import type { ProjectedTask } from './types'

const TODAY = '2026-09-22'
const PROJECT = 'p1'
const OTHER_PROJECT = 'p2'
/** 项目区间（ADR-016 §2 的闭区间）：9/10 ~ 9/25 */
const INTERVAL = { startsOn: '2026-09-10', endsOn: '2026-09-25' }

function project(tasks: ProjectedTask[]): ReturnType<typeof buildTodoItems> {
  return buildTodoItems({ tasks, events: [], today: TODAY })
}

/** 一条「完成过、又放弃」的任务（第五轮裁决之后这是**常态**，不是不可能） */
function completedThenAbandoned(id: string, projectId: string | null): ProjectedTask {
  return task({ id, projectId, status: 'abandoned', indexDate: '2026-09-20' })
}
const completedThenAbandonedEvents = (id: string) => [
  completed(1, { taskId: id, originalPlannedDate: '2026-09-20', completedDayKey: '2026-09-20', next: null }),
]

describe('状态筛选（FR2.6 的四个筛选值 + 默认）', () => {
  const open = task({ id: taskId(1), plannedDate: TODAY })
  const finished = task({ id: taskId(2), indexDate: '2026-09-20' })
  const abandoned = task({ id: taskId(3), plannedDate: TODAY, status: 'abandoned' })
  const items = buildTodoItems({
    tasks: [open, finished, abandoned],
    events: completedThenAbandonedEvents(taskId(2)),
    today: TODAY,
  })

  it('默认（不给 status）：排除已放弃，**保留已完成**（今天做完的要留在视野里）', () => {
    expect(idsOf(queryItems(items, {}))).toEqual([taskId(1), taskId(2)])
  })

  it('「进行中」筛选 = 未完成且未放弃（**不是** TaskStatus.in_progress）', () => {
    expect(idsOf(queryItems(items, { status: 'active' }))).toEqual([taskId(1)])
  })

  it('「已完成」筛选：查 status，不查完成事件 → 未放弃且本实例已完成', () => {
    expect(idsOf(queryItems(items, { status: 'completed' }))).toEqual([taskId(2)])
  })

  it("「已放弃」筛选：status === 'abandoned'，不论是否完成过", () => {
    expect(idsOf(queryItems(items, { status: 'abandoned' }))).toEqual([taskId(3)])
  })

  it('「全部」筛选：含已放弃（否则用户无法重新打开它）', () => {
    expect(idsOf(queryItems(items, { status: 'all' }))).toEqual([taskId(1), taskId(2), taskId(3)])
  })
})

describe('已放弃压过完成态（ADR-015 §4，②③④）', () => {
  const id = taskId(1)
  const abandonedId = taskId(2)
  const tasks = [
    task({ id, projectId: PROJECT, plannedDate: TODAY }),
    completedThenAbandoned(abandonedId, PROJECT),
  ]
  const items = buildTodoItems({
    tasks,
    events: completedThenAbandonedEvents(abandonedId),
    today: TODAY,
  })

  it('② **不**出现在「已完成」筛选里（它虽然完成过）', () => {
    expect(idsOf(queryItems(items, { status: 'completed' }))).toEqual([])
  })

  it('③ 出现在「已放弃」与「全部」两个筛选里', () => {
    expect(idsOf(queryItems(items, { status: 'abandoned' }))).toEqual([abandonedId])
    expect(idsOf(queryItems(items, { status: 'all' }))).toEqual([id, abandonedId])
  })

  it('④ **项目视图与全部视图**也必须显式排除它（这两条判据本身不看状态）', () => {
    // 归属判据（`inScope`）只看 projectId，故排除必须由筛选那一层加上来
    expect(idsOf(queryItems(items, { scope: { kind: 'project', projectId: PROJECT } }))).toEqual([id])
    expect(idsOf(queryItems(items, { scope: { kind: 'all' } }))).toEqual([id])
    // 而「全部」**筛选**下它仍在（③）——两个「全部」不是同一件事：
    // scope=all 是视图范围，status='all' 是状态筛选
    expect(idsOf(queryItems(items, { scope: { kind: 'all' }, status: 'all' }))).toEqual([id, abandonedId])
  })
})

describe('标签筛选（多个标签是 **AND**，口径未经 ADR 批准）', () => {
  const items = project([
    task({ id: taskId(1), tags: ['实验', '紧急'] }),
    task({ id: taskId(2), tags: ['实验'] }),
    task({ id: taskId(3), tags: [] }),
  ])

  it('每个标签都必须有', () => {
    expect(idsOf(queryItems(items, { tags: ['实验'] }))).toEqual([taskId(1), taskId(2)])
    expect(idsOf(queryItems(items, { tags: ['实验', '紧急'] }))).toEqual([taskId(1)])
    expect(idsOf(queryItems(items, { tags: ['紧急', '不存在'] }))).toEqual([])
  })

  it('空标签数组 = 不筛（不是「筛出没有标签的」）', () => {
    expect(idsOf(queryItems(items, { tags: [] }))).toEqual([taskId(1), taskId(2), taskId(3)])
  })
})

describe('项目视图是**归属**不是区间（ADR-016 §10 的裁决 / ADR-015 §5）', () => {
  const tasks = [
    task({ id: taskId(1), projectId: PROJECT, plannedDate: '2026-12-01' }), // 区间外
    task({ id: taskId(2), projectId: PROJECT, plannedDate: '2026-09-15' }), // 区间内
    task({ id: taskId(3), projectId: OTHER_PROJECT, plannedDate: '2026-09-15' }), // 别的项目、日期在区间内
    task({ id: taskId(4), projectId: PROJECT }), // 项目级：两个日期锚点皆空
  ]
  const items = project(tasks)
  const query: TaskQuery = { scope: { kind: 'project', projectId: PROJECT }, projectInterval: INTERVAL }

  it('① 属于 P、日期全部在 P 区间外的任务**仍出现**，且带 `outside_project_range`', () => {
    const result = queryItems(items, query)
    expect(idsOf(result)).toEqual([taskId(1), taskId(2), taskId(4)])
    const outside = result.find((item) => item.taskId === taskId(1))!
    expect(outside.reasons).toContain('outside_project_range')
    // 区间内的不带这条理由（界面据此分成两组）
    expect(result.find((item) => item.taskId === taskId(2))!.reasons).not.toContain('outside_project_range')
  })

  it('② 属于**别的**项目、日期落在 P 区间内的任务**不出现**（区间判定会把它错收进来）', () => {
    expect(idsOf(queryItems(items, query))).not.toContain(taskId(3))
  })

  it('区间判据不看 `occurrenceKey`（非重复任务）= 创建日——**同一条 bug 的第三次发作**', () => {
    // 一条**在项目区间内创建**、却排期在区间外的任务：`occurrenceKey` 落在区间内
    // （非重复任务的实例键恒为 `indexDate`，ADR-013 §2），而它的**排期**在区间外。
    // 若判据把 `occurrenceKey` 无条件计入锚点，这条会被判成「区间内」→ 拿不到标注，
    // 正是 §5 收录这条分组标注要防的那种「用户看到一条十二月排期的任务出现在
    // 九月结束的项目里，而界面不解释为什么」。
    const createdInside = project([
      task({ id: taskId(7), projectId: PROJECT, indexDate: '2026-09-15', plannedDate: '2026-12-01' }),
    ])[0]!
    expect(createdInside.occurrenceKey).toBe('2026-09-15') // 实例键仍稳定（ADR-013 §2）
    // 它与分组判据是两件事：前者必须稳定，后者看的是**排期**
    expect(isOutsideProjectRange(createdInside, INTERVAL)).toBe(true)
    expect(
      queryItems([createdInside], { scope: { kind: 'project', projectId: PROJECT }, projectInterval: INTERVAL })[0]!
        .reasons,
    ).toContain('outside_project_range')
  })

  it('重复任务的 `occurrenceKey` **是**排期日，照常参与（分流不能一刀切）', () => {
    // 「每日」任务的某一轮落在区间内 → 不算区间外
    const recurringInRange = project([
      task({ id: taskId(8), projectId: PROJECT, indexDate: '2026-09-01', recurrence: dailyRule() }),
    ])[0]!
    expect(recurringInRange.occurrenceKey).toBe(TODAY) // 本轮 = 今天（2026-09-22，在区间内）
    expect(isOutsideProjectRange(recurringInRange, INTERVAL)).toBe(false)
  })

  it('未排期的项目级任务不会消失——它就是最典型的项目任务（ADR-016 §10 的「会消失」回归）', () => {
    const projectLevel = queryItems(items, query).find((item) => item.taskId === taskId(4))!
    expect(projectLevel).toBeDefined()
    expect(isOutsideProjectRange(projectLevel, INTERVAL)).toBe(true) // 四个锚点一个都不在区间内
  })

  it('没给 `projectInterval` 时不做分组标注（判据仍成立，只是不标）', () => {
    const result = queryItems(items, { scope: { kind: 'project', projectId: PROJECT } })
    expect(idsOf(result)).toEqual([taskId(1), taskId(2), taskId(4)])
    expect(result.every((item) => !item.reasons.includes('outside_project_range'))).toBe(true)
  })

  it("`projectInterval` 只对 `scope.kind === 'project'` 生效（别的范围不受影响）", () => {
    const result = queryItems(items, { scope: { kind: 'all' }, projectInterval: INTERVAL })
    expect(result.every((item) => !item.reasons.includes('outside_project_range'))).toBe(true)
  })

  it('`plannedWeek` 在区间判据里折算成周日（本周与项目只重叠一部分时不算「区间外」）', () => {
    const weekly = project([task({ id: taskId(9), projectId: PROJECT, plannedWeek: '2026-09-07' })])[0]!
    // 周一 9/7 在区间外，但那一周（到 9/13）与项目 [9/10, 9/25] 有重叠 → 不算区间外
    expect(isOutsideProjectRange(weekly, INTERVAL)).toBe(false)
  })

  it('项目区间反向时抛 RangeError', () => {
    const item = project([task({ id: taskId(1), projectId: PROJECT })])[0]!
    expect(() => isOutsideProjectRange(item, { startsOn: '2026-09-25', endsOn: '2026-09-10' })).toThrow(
      RangeError,
    )
  })
})

describe('**比率的分子也排除已放弃**（01 FR4.3 v1.4 的回归；ADR-016 §3 的可复算反例）', () => {
  /**
   * 反例（ADR-016 §3 逐字）：项目 P 下 T1（完成于 9/20，9/22 放弃）、T2（未完成）→
   * 若「已完成」的判据只排除分母，会算出 分子 1 / 分母 1 = **100%**；
   * 再加一条「已完成并放弃」的 → **2/1 = 200%**，而 P 下明明还有一条没做完。
   *
   * ⚠️ **比率函数本身属阶段 6（01 FR4.3 / ADR-016 §3），不在本模块的范围内。**
   * 本用例锁的是**读模型这一侧**：比率的分子候选集（「已完成」筛选）与分母候选集
   * （默认筛选）**都不含已放弃**。两侧同基，200% 那种失真就无从产生。
   */
  const t1 = task({ id: taskId(1), projectId: PROJECT, indexDate: '2026-09-20', status: 'abandoned' })
  const t1b = task({ id: taskId(2), projectId: PROJECT, indexDate: '2026-09-20', status: 'abandoned' })
  const t2 = task({ id: taskId(3), projectId: PROJECT })
  const items = buildTodoItems({
    tasks: [t1, t1b, t2],
    events: [
      completed(1, { taskId: t1.id, originalPlannedDate: '2026-09-20', completedDayKey: '2026-09-20', next: null }),
      completed(2, { taskId: t1b.id, originalPlannedDate: '2026-09-20', completedDayKey: '2026-09-20', next: null }),
    ],
    today: TODAY,
  })
  const scope = { kind: 'project', projectId: PROJECT } as const

  it('分子候选集（「已完成」筛选）为 0，分母候选集为 1 —— 不是 1/1、更不是 2/1', () => {
    const numerator = queryItems(items, { scope, status: 'completed' })
    const denominator = queryItems(items, { scope })
    expect(idsOf(numerator)).toEqual([])
    expect(idsOf(denominator)).toEqual([taskId(3)])
    // 分子 ⊆ 分母，且比率只能是 0/1
    expect(numerator.length).toBeLessThanOrEqual(denominator.length)
  })

  it('若把「已完成」判成「完成过」，分子会变成 2、分母 1（>100%）——本用例正是防这个', () => {
    const completedEver = items.filter((item) => item.completedAt !== null)
    expect(completedEver).toHaveLength(2) // 完成记录**仍在**（放弃不抹除历史，ADR-013 §2）
    // 但「完成过」不是「已完成」：filter 用 status 判，故上面那两条进不了分子
    expect(idsOf(queryItems(items, { scope, status: 'completed' }))).toEqual([])
  })
})

describe('筛选是纯函数', () => {
  it('同一 `(items, query)` 反复调用结果恒等，且不改动入参', () => {
    const items = project([task({ id: taskId(1), projectId: PROJECT, tags: ['a'] })])
    const query: TaskQuery = { scope: { kind: 'project', projectId: PROJECT }, projectInterval: INTERVAL }
    expect(queryItems(items, query)).toEqual(queryItems(items, query))
    expect(items[0]!.reasons).not.toContain('outside_project_range')
    expect(matchesQuery(items[0]!, query)).toBe(true)
    expect(matchesQuery(items[0]!, { status: 'abandoned' })).toBe(false)
  })
})
