/**
 * 筛选 —— FR2.6 的「状态 / 范围 / 标签」三组筛选（ADR-015 §4 的优先级表 / §5 的视图范围）。
 *
 * 零依赖纯函数，**服务端与前端导入同一份**（ADR-015 §7）。
 *
 * ## 已放弃的任务：优先级高于一切（§4 那张表）
 *
 * | 位置 | 规则 |
 * |---|---|
 * | **项目**视图（`projectId === P`）与**全部**视图 | **必须额外加 `status !== 'abandoned'`** ——这两条判据本身不看状态，不加就会把已放弃的任务混进正常清单 |
 * | 「已完成」筛选 | **查 `status`，不查完成事件**：`TodoItem.status` 的取值里**没有 `completed`**，故「已完成」= **未放弃且本实例已完成** |
 * | 「已放弃」筛选 | `status === 'abandoned'`（**不论是否完成过**） |
 * | 今日视图 | 已有 `status !== 'abandoned'` 门槛（§3），无需另加 |
 *
 * **已放弃的任务仍然要能被找到**（否则用户无法重新打开它）——它出现在
 * 「已放弃」与「全部」两个**筛选**下，**不在**其余筛选与所有默认视图里。
 *
 * ## 与排序的分工
 *
 * 本模块只做筛选，**不排序**。默认顺序见 `sort.ts`。五个 HTTP scope 的组合方式：
 *
 * ```ts
 * // scope=today —— ⚠️ 不是区间判定（§5）
 * sortItems(todayItems(input), today)
 * // scope=week
 * sortItems(queryItems(buildTodoItems(input), { scope: { kind: 'range', from: weekStart(today), to: weekEnd(today) } }), today)
 * // scope=range / project / all
 * sortItems(queryItems(buildTodoItems(input), { scope, projectInterval }), today)
 * ```
 */
import { compareDayKey, isDayKey, weekEnd } from '@shared/time'
import type { DayKey } from '@shared/time'
// 项目区间的**唯一定义**在 `shared/plan/project.ts`（ADR-016 §2），这里只导入、不重写
import type { ProjectInterval } from '@shared/plan'

import { inScope, isInstanceCompleted } from './today'
import type { Scope, TodoItem, TodoReason } from './types'

/**
 * FR2.6 的状态筛选（「进行中 / 已完成 / 已放弃 / 全部」）。
 *
 * ⚠️ `'active'` 是 FR2.6 那个**筛选值**「进行中」，含义是
 * **未完成且未放弃**（`status !== 'abandoned' && !本实例已完成`）——
 * 它**不是** `TaskStatus.in_progress`（那是任务级意图态，FR2.1 的「进行中」复选框）。
 * 两个「进行中」是不同维度上的词，这里按筛选值的语义实现，并**不用同一个名字**。
 */
export type StatusFilter = 'active' | 'completed' | 'abandoned' | 'all'

/**
 * 视图查询。
 *
 * - `status` 缺省 / `null` = **默认视图**：排除已放弃、**保留已完成**（FR2.6 的默认清单里
 *   今天做完的仍要留在视野里，§3 D/F）。显式给值时才按 FR2.6 的四个筛选值收窄。
 * - `tags` 给了多个时是 **AND**（每个都要有）。
 *   ⚠️ **这一条 ADR 没有规定**（01 FR2.6 只写了「筛选：……标签」）：本模块取 AND，
 *   理由是筛选的用途是**收窄**、而 OR 会让「再加一个标签」变成扩大结果集，
 *   与「筛选」二字相反（Todoist 的多标签过滤同为 AND）。**口径未经 ADR 批准，已报告**。
 * - `projectInterval` **仅在 `scope.kind === 'project'` 时有意义**（ADR-016 §2 的
 *   `[startsOn, endsOn]`，闭区间）：给了它才按 §5 标注 `outside_project_range`。
 */
export interface TaskQuery {
  scope?: Scope
  status?: StatusFilter | null
  tags?: readonly string[]
  projectInterval?: ProjectInterval | null
}

/** 默认视图的状态判据：排除已放弃，保留已完成 */
function matchesStatus(item: TodoItem, status: StatusFilter | null | undefined): boolean {
  const completed = isInstanceCompleted(item)
  switch (status ?? null) {
    case null:
      return item.status !== 'abandoned'
    case 'active':
      return item.status !== 'abandoned' && !completed
    case 'completed':
      // 「已完成」= **未放弃且本实例已完成**（不查完成事件——TodoItem.status 里没有 completed）
      return item.status !== 'abandoned' && completed
    case 'abandoned':
      // 不论是否完成过（放弃不取消完成记录，ADR-013 §2）
      return item.status === 'abandoned'
    case 'all':
      return true
  }
}

/**
 * §5 的项目分组判据：`plannedDate` / `plannedWeek` / `dueDate` / `occurrenceKey`
 * **没有任何一个**落在 `[startsOn, endsOn]` 内。
 *
 * 为什么需要它：用户会看到一条十月排期的任务出现在九月就结束的项目里，而界面不解释
 * 为什么——**看起来像 bug**。分组让「归属」与「区间」两件事各自可见，
 * 而不是让其中一个悄悄失效（ADR-016 §10 的调和方案）。
 *
 * ⚠️ `plannedWeek` 在这里**同样折算成 `weekEnd`**（与 §4 的紧迫日折算同一口径）：
 * §5 的原文只列了这个锚点、没说按哪一天比较，而按周一比较会在「这一周与项目只重叠
 * 一部分」时把任务判成区间外（项目 9/10 起，任务的「本周」是 9/8 那一周——
 * 用户显然认为它在项目里）。`occurrenceKey` **不折算**（它就是具体某天）。
 *
 * ⚠️ 判据里**没有 `completedDayKey`**（§5 只列了四个锚点）：一条计划日远在区间外、
 * 却在项目期间被完成的任务，仍算「区间外」。这是 §5 的字面口径。
 */
export function isOutsideProjectRange(item: TodoItem, interval: ProjectInterval): boolean {
  assertDayKey(interval.startsOn, 'interval.startsOn')
  assertDayKey(interval.endsOn, 'interval.endsOn')
  if (compareDayKey(interval.startsOn, interval.endsOn) > 0) {
    throw new RangeError(
      `项目区间反向：startsOn (${interval.startsOn}) 晚于 endsOn (${interval.endsOn})`,
    )
  }
  const anchors: DayKey[] = []
  if (item.plannedDate !== null) anchors.push(item.plannedDate)
  if (item.plannedWeek !== null) anchors.push(weekEnd(item.plannedWeek))
  if (item.dueDate !== null) anchors.push(item.dueDate)
  // ⚠️ **`occurrenceKey` 必须按 `recurring` 分流**——这是同一条 bug 的**第三次**发作：
  //   `urgencyDates`（§4）与 `relevantDates`（§5）先中招，这里是第三处。
  //   非重复任务的 `occurrenceKey` 恒为 `indexDate`，而它是**创建日**、不是排期日；
  //   无条件计入会让「在项目区间内**创建**、却排期在区间外」的任务拿不到
  //   `outside_project_range` —— 正是 ADR-015 §5 收录这条分组标注要防的那种
  //   「用户看到一条十月排期的任务出现在九月结束的项目里，而界面不解释为什么」。
  //   重复任务不受影响：那里 `occurrenceKey` 就是该轮的原计划日，是它唯一的排期日。
  if (item.recurring) anchors.push(item.occurrenceKey)
  return !anchors.some(
    (dk) => compareDayKey(dk, interval.startsOn) >= 0 && compareDayKey(dk, interval.endsOn) <= 0,
  )
}

/** 单条是否命中筛选（`queryItems` 与界面上的即时过滤共用这一份判据） */
export function matchesQuery(item: TodoItem, query: TaskQuery = {}): boolean {
  if (!matchesStatus(item, query.status)) return false
  if (!inScope(item, query.scope ?? { kind: 'all' })) return false

  const wanted = query.tags
  if (wanted !== undefined && wanted.length > 0) {
    const owned = new Set(item.tags)
    for (const tag of wanted) {
      if (!owned.has(tag)) return false
    }
  }
  return true
}

/**
 * 按查询筛选（**返回新数组、不改动入参**；**不排序**——顺序由 `sortItems` 决定）。
 *
 * 项目视图 + 给了 `projectInterval` 时，区间外的任务会被**追加**一条
 * `outside_project_range` 理由（§5），界面据此分组标注；其余不变。
 */
export function queryItems(items: readonly TodoItem[], query: TaskQuery = {}): TodoItem[] {
  const matched = items.filter((item) => matchesQuery(item, query))

  const interval = query.scope?.kind === 'project' ? (query.projectInterval ?? null) : null
  if (interval === null) return matched

  return matched.map((item) =>
    isOutsideProjectRange(item, interval) ? withReason(item, 'outside_project_range') : item,
  )
}

/** 追加一条理由（幂等：已有则不重复加）。理由数组是 `readonly`，故返回新对象 */
function withReason(item: TodoItem, reason: TodoReason): TodoItem {
  if (item.reasons.includes(reason)) return item
  return { ...item, reasons: [...item.reasons, reason] }
}

function assertDayKey(value: DayKey, name: string): void {
  if (!isDayKey(value)) {
    throw new RangeError(`${name} 不是合法 DayKey：'${String(value)}'`)
  }
}
