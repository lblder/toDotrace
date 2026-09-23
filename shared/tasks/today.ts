/**
 * 「今天要做哪些事」—— ADR-015 的读模型（缝合、入选、紧迫日折算、档位、视图范围）。
 *
 * **本文件是「今日待办」判据的唯一实现**，两端共用（ADR-015 §7）。界面不得自己写
 * `dueDate < today`、也不得自己推「为什么它排第一」——那些判据各有至少两个坑
 * （`today` 从哪来、重复任务该看 `occurrenceKey` 还是 `plannedDate`），
 * 写在组件里几乎必然算错，且错得没有症状。
 *
 * 三条缝进来的信息（ADR-015 §背景）：
 *
 * | 信息 | 来源 |
 * |---|---|
 * | 任务的定义 | `tasks` 表（`Task`） |
 * | 非重复任务完成了没有 | 完成/取消完成**事件** |
 * | 重复任务今天该不该做、做了没有 | `deriveRounds` **推导** |
 *
 * **今日视图不走 `relevantDates`**（§3 末）：它由 A–F 唯一决定，而 A–F 里没有任何一条
 * 以 `plannedWeek` 为条件。`relevantDates` 只服务区间视图与项目分组。
 *
 * 纯函数：同一输入反复调用结果恒等；不读时钟（`today` 由调用方按 ADR-015 §6
 * 用服务端的 `today(ctx, new Date())` 算好传入）、不读库、不写库。
 */
import { addDays, compareDayKey, isDayKey, weekEnd } from '@shared/time'
import type { DayKey } from '@shared/time'

import { resolveInstance } from './rounds'
import type {
  OccurrenceEvent,
  ProjectedTask,
  Scope,
  StepCheck,
  TodoItem,
  TodoItemStep,
  TodoReason,
} from './types'

// ───────────────────────── 理由的分类（§1 的两类理由） ─────────────────────────

/** **入选**理由：回答「它为什么在这儿」（排查「任务怎么不见了」时的依据） */
const SELECTION_REASONS: ReadonlySet<TodoReason> = new Set<TodoReason>([
  'planned_today',
  'planned_overdue',
  'due_today',
  'due_overdue',
  'in_progress_undated',
  'completed_today',
  'recurring_pending',
  'recurring_overdue',
])

/** **档位**理由：回答「它为什么排第一」——**界面要展示的是这一组**（FR2.6 原文是「可见排序理由」） */
const BUCKET_REASONS: ReadonlySet<TodoReason> = new Set<TodoReason>([
  'bucket_overdue',
  'bucket_today',
  'bucket_tomorrow',
  'bucket_this_week',
  'bucket_no_date',
  'bucket_done',
  'bucket_abandoned',
])

/**
 * 理由分组的唯一判据。界面**按它取**，不要按数组位置取、也不要自己列一份名字：
 * 两份名单必然漂移，而漂移的症状是「界面显示了入选理由当成排序理由」。
 */
export function isSelectionReason(reason: TodoReason): boolean {
  return SELECTION_REASONS.has(reason)
}

/** 见 `isSelectionReason` */
export function isBucketReason(reason: TodoReason): boolean {
  return BUCKET_REASONS.has(reason)
}

// ───────────────────────── 紧迫日折算与档位（§4） ─────────────────────────

/**
 * 把各锚点折算成「紧迫日」（ADR-015 §4 第一步）。
 *
 * - 日粒度锚点直接取自身；**周粒度锚点折算成该周的周日**（`weekEnd`）。
 *   若直接用周一参与比较，「本周三」看一条「本周做」的任务会算出 `周一 < 周三` →
 *   **被判成逾期**，而用户说的明明是「这周做」。折算后它在周四落进「本周」档、
 *   在**下周一**才变成逾期——一条规则解决了整类问题。
 * - ⚠️ **`occurrenceKey` 只在 `item.recurring` 为真时参与**。非重复任务的
 *   `occurrenceKey` 恒为 `indexDate`（§2），而 `indexDate` 是**创建日**——
 *   **它不是一个排期日**。无条件计入会让任何「今天之前创建、未完成」的任务都满足
 *   `min(紧迫日) < today` → **恒落档 0「逾期」**，症状是「凡是过夜的任务全部标红」
 *   （与 FR2.2 的「期限日早于今天」直接相反），且档 2 / 档 3 对非重复任务永不可达。
 * - 重复任务的 `occurrenceKey` **不折算成周日**：那里它就是该轮的
 *   `originalPlannedDate`，是这一轮唯一的排期日（重复任务的三个日期锚点恒空）。
 */
export function urgencyDates(item: TodoItem): DayKey[] {
  const dates: DayKey[] = []
  if (item.dueDate !== null) dates.push(item.dueDate)
  if (item.plannedDate !== null) dates.push(item.plannedDate)
  if (item.plannedWeek !== null) dates.push(weekEnd(item.plannedWeek))
  if (item.recurring) dates.push(item.occurrenceKey)
  return dates
}

/**
 * 档位 0–6（§4 第二步）：**取第一个命中的**，不是全部命中。
 *
 * | 档 | 条件 |
 * |---|---|
 * | 0 逾期 | 未完成 且 `min(紧迫日) < today` |
 * | 1 今天 | 未完成 且 `min(紧迫日) === today` |
 * | 2 明天 | 未完成 且 `min(紧迫日) === addDays(today, 1)` |
 * | 3 本周 | 未完成 且 `min(紧迫日) ≤ weekEnd(today)` |
 * | 4 无日期或更晚 | 未完成 且（紧迫日为空 **或** `> weekEnd(today)`） |
 * | 5 已放弃 | `status === 'abandoned'`（**压过一切**） |
 * | 6 已完成 | **未放弃** 且 本实例已完成 |
 *
 * ⚠️ **`abandoned` 压过「本实例已完成」**——档 0–5 的每一档都**先判 `status`**。
 * 放弃不取消完成记录（ADR-013 §2），于是「已放弃 + 本实例已完成」是**常态**；
 * 若档位只看完成事件，这条任务会被标成 `bucket_done`、排进「已完成」，
 * 而 FR2.1（v1.4）明令「已放弃的**不得呈现为已完成**」。档 6 因此是「**未放弃** 且 已完成」。
 *
 * 档 4 的名字里必须有「**或更晚**」：FR2.6 的措辞是「无期限」，但周级锚点与远期日期
 * 都会落到这里；若叫「无期限」而实际收着有日期的任务，界面显示的排序理由就是一句假话。
 */
export type TodoBucket = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 档位 ↔ 排序理由（唯一一份；界面据此显示「为什么排在这里」） */
export const BUCKET_REASON: Readonly<Record<TodoBucket, TodoReason>> = {
  0: 'bucket_overdue',
  1: 'bucket_today',
  2: 'bucket_tomorrow',
  3: 'bucket_this_week',
  4: 'bucket_no_date',
  5: 'bucket_abandoned',
  6: 'bucket_done',
}

/** 本实例是否已完成（**本实例**，不是「这个任务曾经完成过」——ADR-013 §2） */
export function isInstanceCompleted(item: TodoItem): boolean {
  return item.completedAt !== null
}

/**
 * 逾期判定（FR2.2 + §4 的紧迫日折算）。
 *
 * 判据只此一份（§1 对 `overdue` 的注释）：界面若自己写 `dueDate < today`，它要同时避开
 * `today` 从哪来（§6）与「重复任务该看 `occurrenceKey` 还是 `plannedDate`」（§2）两个坑。
 *
 * 口径 = FR2.2 的「未完成 且 期限日早于今天」，只是「期限日」取**折算后的最早紧迫日**：
 * 重复任务的 `dueDate` 恒为 null（ADR-013 §3.1），它的「期限」就是它自己那一天。
 *
 * ⚠️ 它与**档位**是两件事：已放弃的任务仍可能 `overdue === true`（它确实没做完），
 * 但档位是 5（§4 的 status 优先）。界面标红用 `overdue`，排序用档位。
 */
export function isOverdue(item: TodoItem, today: DayKey): boolean {
  assertDayKey(today, 'today')
  if (isInstanceCompleted(item)) return false
  const earliest = earliestUrgencyDate(item)
  return earliest !== null && compareDayKey(earliest, today) < 0
}

/** 最早的紧迫日；为空（真的没有排期）时返回 null */
function earliestUrgencyDate(item: TodoItem): DayKey | null {
  let earliest: DayKey | null = null
  for (const dk of urgencyDates(item)) {
    if (earliest === null || compareDayKey(dk, earliest) < 0) earliest = dk
  }
  return earliest
}

/** 档位（§4 第二步）。`today` 必须显式传入——本模块不读时钟（ADR-009 同款纪律） */
export function urgencyBucket(item: TodoItem, today: DayKey): TodoBucket {
  assertDayKey(today, 'today')

  // 档 5：已放弃压过一切（**包括**「本实例已完成」，见函数头注释）
  if (item.status === 'abandoned') return 5
  // 档 6：未放弃 且 本实例已完成
  if (isInstanceCompleted(item)) return 6

  const earliest = earliestUrgencyDate(item)
  if (earliest === null) return 4 // 紧迫日为空 = 真的没有排期
  if (compareDayKey(earliest, today) < 0) return 0
  if (compareDayKey(earliest, today) === 0) return 1
  if (compareDayKey(earliest, addDays(today, 1)) === 0) return 2
  if (compareDayKey(earliest, weekEnd(today)) <= 0) return 3
  return 4 // 比本周更晚
}

/** 档位对应的排序理由（界面展示用） */
export function bucketReasonOf(bucket: TodoBucket): TodoReason {
  return BUCKET_REASON[bucket]
}

// ───────────────────────── 入选规则 A–F（§3） ─────────────────────────

/**
 * 「它为什么入选」（§3 的表；**今日视图的判据只此一份**）。
 *
 * 任务进入某一天的今日视图，**当且仅当** `deletedAt === null` 且 `status !== 'abandoned'`，
 * 且满足 A–F 任一条。返回空数组 ⇔ 不进今日视图（`deletedAt` 的过滤在 `buildTodoItems`，
 * 因为已删除的任务根本不该有 `TodoItem`）。
 *
 * | # | 条件 | 理由码 |
 * |---|---|---|
 * | A | 未完成，且 `plannedDate ≤ today` | `planned_today` / `planned_overdue` |
 * | B | 未完成，且 `dueDate ≤ today` | `due_today` / `due_overdue` |
 * | C | 未完成，且 `status === 'in_progress'` | `in_progress_undated` |
 * | D | **本实例** `completedDayKey === today` | `completed_today` |
 * | E | 重复任务：**待完成轮次**的 `originalPlannedDate ≤ today` | `recurring_pending` / `recurring_overdue` |
 * | F | 重复任务：**显示的那一轮** `completedDayKey === today` | `completed_today` |
 *
 * **C 单独辩护过**（§3）：一条没有日期的任务，用户显式按下了「开始」——
 * 那比任何日期都更能说明他想做这件事。代价如实登记：长期不结的进行中任务会**堆积**
 * 在今日视图里，缓解靠筛选器（FR2.6），**不设自动隐藏**。
 *
 * ⚠️ **E 与 F 都按「本行显示的那一轮」判定**（`resolveInstance` 选出的那一轮）。
 * ADR-015 §3 说「E 与 F 不会同时为真」，理由写的是「今天完成的轮次一旦完成就不再是待完成」——
 * 那个理由只在默认锚点②（`catch_up`）下成立：锚点①（`extend`）下今天补做了**上一轮**时，
 * 「今天完成的轮次」与「待完成轮次」会是**两条不同的轮次**，两者同时为真。
 * 按「本行显示的那一轮」判定使两句都成立：一行要么显示待完成的那一轮、要么显示今天完成的那一轮。
 *
 * ⚠️ **周级任务不因为「它是周级的」而进今日视图**（§3）：A–F 里没有任何一条以
 * `plannedWeek` 为条件。但只要它满足 B（有期限且到期）/ C（被显式开工）/ D（今天完成），
 * **照样进**——被排除的只有「周级、无期限、未开始、今天也没完成」那一种。
 */
export function selectionReasons(item: TodoItem, today: DayKey): TodoReason[] {
  assertDayKey(today, 'today')

  // §3 的门槛：`status !== 'abandoned'`。已放弃的任务**不在任何默认视图里**
  // （它只出现在「已放弃」与「全部」两个筛选下，否则用户无法重新打开它）。
  if (item.status === 'abandoned') return []

  const reasons: TodoReason[] = []
  const completed = isInstanceCompleted(item)

  if (!completed) {
    // A：计划日 ≤ today（含逾期——FR2.4「忘了规划的任务不会从视野里消失」）
    if (item.plannedDate !== null) {
      const order = compareDayKey(item.plannedDate, today)
      if (order === 0) reasons.push('planned_today')
      else if (order < 0) reasons.push('planned_overdue')
    }
    // B：期限 ≤ today（含逾期）
    if (item.dueDate !== null) {
      const order = compareDayKey(item.dueDate, today)
      if (order === 0) reasons.push('due_today')
      else if (order < 0) reasons.push('due_overdue')
    }
    // C：进行中（无日期也进；无限定条件——见函数头注释）
    if (item.status === 'in_progress') reasons.push('in_progress_undated')
  }

  // D / F：本行显示的那一轮今天完成
  if (item.completedDayKey !== null && compareDayKey(item.completedDayKey, today) === 0) {
    reasons.push('completed_today')
  }

  // E：本行显示的是待完成轮次，且它 ≤ today（`deriveRounds` 保证恒 ≤ today）
  if (item.recurring && item.pending && !completed) {
    const order = compareDayKey(item.occurrenceKey, today)
    if (order === 0) reasons.push('recurring_pending')
    else if (order < 0) reasons.push('recurring_overdue')
  }

  return reasons
}

/** 该行是否进今日视图（§3 的 A–F）——判据只有 `selectionReasons` 一处 */
export function isInTodayView(item: TodoItem, today: DayKey): boolean {
  return selectionReasons(item, today).length > 0
}

// ───────────────────────── 视图范围（§5） ─────────────────────────

/**
 * `{ plannedDate, plannedWeek, dueDate, occurrenceKey, completedDayKey }` 去掉 null（§5）。
 *
 * `plannedWeek` **必须在**里面——漏掉它会产生一个极隐蔽的错误：「上周创建、计划本周做」
 * 的周级任务会出现在**上周**的周视图里（它的 `occurrenceKey` 是**创建日**），
 * 而它计划的那一周什么也没有。**这不是「看不见」，是「看见的日子不对」**。
 *
 * ⚠️ **`occurrenceKey` 与 `urgencyDates` 同样按 `recurring` 分流**（实现时的判定，
 * 见 ADR-015 §5 的正文与 §4 对同款缺陷的论证）：非重复任务的 `occurrenceKey` 是
 * **创建日**，不是排期日，无条件计入会让「上周创建、计划本周做」的任务**上周也出现**——
 * 那正是 §后果 的「周级任务落在正确的周」用例要防的（它要求「不在上周」）。
 */
export function relevantDates(item: TodoItem): DayKey[] {
  const dates = new Set<DayKey>()
  if (item.plannedDate !== null) dates.add(item.plannedDate)
  if (item.plannedWeek !== null) dates.add(weekEnd(item.plannedWeek))
  if (item.dueDate !== null) dates.add(item.dueDate)
  if (item.recurring) dates.add(item.occurrenceKey)
  if (item.completedDayKey !== null) dates.add(item.completedDayKey)
  return [...dates]
}

/**
 * 视图范围判定（§5）。
 *
 * | 视图 | 判定 |
 * |---|---|
 * | 今日 | ⚠️ **不是区间判定**——由 §3 的 A–F 唯一决定（用 `isInTodayView`） |
 * | 本周 | `range[weekStart(today), weekEnd(today)]`（闭区间，两端都含） |
 * | 项目 | **`item.projectId === scope.projectId`**（归属判据，**不是区间**） |
 * | 全部 | 不做判定 |
 *
 * ⚠️ **「今日」不能写成 `range[today, today]`**：§3 的 A（`plannedDate ≤ today`）、
 * B（`dueDate ≤ today`）、E（轮次 `≤ today`）都是**含逾期**的，而 `[today, today]`
 * 只收「恰好落在今天」的——一条拖了三天的任务会从今日视图**静默消失**，
 * 直接推翻 FR2.4 的「已逾期」。
 *
 * ⚠️ **`inScope` 不看 `status`**（§5 的项目一行只写了归属判据）。已放弃的排除在
 * **筛选**那一层（§4 的优先级表：项目视图与全部视图**必须额外加 `status !== 'abandoned'`**），
 * 即 `filter.ts` 的 `queryItems`。单独用 `inScope` 拼视图会漏掉那一条。
 *
 * `range` 的 `from > to` 抛 `RangeError`（闭区间为空），不返回 false——
 * 与 `shared/checkin` 的 `countCheckins` 同一条纪律：静默返回空会让调用方
 * 以为「那段时间没有任务」。
 */
export function inScope(item: TodoItem, scope: Scope): boolean {
  switch (scope.kind) {
    case 'range': {
      assertDayKey(scope.from, 'scope.from')
      assertDayKey(scope.to, 'scope.to')
      if (compareDayKey(scope.from, scope.to) > 0) {
        throw new RangeError(`scope.from (${scope.from}) 晚于 scope.to (${scope.to})：闭区间为空`)
      }
      return relevantDates(item).some(
        (dk) => compareDayKey(dk, scope.from) >= 0 && compareDayKey(dk, scope.to) <= 0,
      )
    }
    case 'project':
      return item.projectId === scope.projectId
    case 'all':
      return true
  }
}

// ───────────────────────── 读模型的构造 ─────────────────────────

/** 读模型的入参（服务端与前端同一份） */
export interface TodoReadInput {
  /** 该账号**全部**任务（含已删除的；软删除的过滤在本函数内，见 `buildTodoItems`） */
  tasks: readonly ProjectedTask[]
  /** 完成 / 取消完成事件（ADR-013 §4.6 / §4.7），**按事件 id 序**（ADR-001 §2） */
  events: readonly OccurrenceEvent[]
  /**
   * 折叠后的「当前已勾选」步骤记录（ADR-013 §4.12）：同一键取最后一条
   * `task/step-toggled`，未勾选的键不出现。缺省 = 没有任何勾选。
   */
  stepChecks?: readonly StepCheck[]
  /**
   * 今日归属日，**由服务端**用 `today(ctx, new Date())` 算出（ADR-015 §6）。
   * 响应必须把同一个值回带给前端——前端不得自行计算用于提交。
   */
  today: DayKey
}

/**
 * 步骤勾选的查找键：三者共同构成「某一轮的某个步骤」（ADR-013 §4.12）。
 *
 * ⚠️ **分隔符必须写成 `\x00` 这个转义序列，不能在源码里嵌裸的 NUL 字节。**
 * 两者的运行时行为**完全相同**，但**裸字节会让整个文件变成「二进制」**：
 * `file` 判定为 `data`，而 **`grep` 会静默跳过它**——不报错、不提示，只是什么都不返回。
 *
 * 这是实测过的：本项目一度在这个文件里嵌了裸 NUL，于是
 * **一次针对「`abandoned` 门槛到底存不存在」的 grep 返回空**，
 * 协调者据此得出了「门槛不存在」的**错误结论**，并在发现前把它当成了事实。
 * 更要紧的是 **ADR-013 §6 要求把静态纪律扫描的根扩到 `shared/`**——
 * 一扩，这个 470 行的核心模块就会被那条扫描**静默漏掉**，而漏掉不会有任何症状。
 *
 * 分隔符选 NUL 的理由成立（它不可能出现在 UUID 或 `DayKey` 里），
 * **只是必须用转义写法**。（`server/tasks/sources.ts` 有同款问题，见那里的注释。）
 */
function stepCheckKey(taskId: string, stepId: string, occurrenceKey: DayKey): string {
  return `${taskId}\x00${stepId}\x00${occurrenceKey}`
}

function buildOne(
  task: ProjectedTask,
  events: readonly OccurrenceEvent[],
  checks: ReadonlyMap<string, string>,
  today: DayKey,
): TodoItem {
  const instance = resolveInstance(task, events, today)
  const recurring = task.recurrence !== null

  const steps: TodoItemStep[] = task.steps.map((step) => ({
    id: step.id,
    title: step.title,
    // 勾选属于**本实例**：昨天的勾选今天不该还亮着（ADR-013 §4.12）。
    checkedAt: checks.get(stepCheckKey(task.id, step.id, instance.occurrenceKey)) ?? null,
  }))

  // 分两步构造：`reasons` 的入选部分由 `selectionReasons` 从 item 自身算出，
  // 而 `overdue` 同理。先构造一个「无理由」的骨架，再补齐——这样两个判据都只有一份实现。
  const skeleton: TodoItem = {
    taskId: task.id,
    occurrenceKey: instance.occurrenceKey,
    title: task.title,
    notes: task.notes,
    importance: task.importance,
    tags: [...task.tags],
    projectId: task.projectId,
    steps,
    plannedDate: task.plannedDate,
    plannedWeek: task.plannedWeek,
    dueDate: task.dueDate,
    status: task.status,
    completedAt: instance.completion === null ? null : instance.completion.occurredAt,
    completedDayKey:
      instance.completion === null ? null : instance.completion.payload.completedDayKey,
    recurring,
    pending: instance.pending !== null,
    createdAt: task.createdAt,
    overdue: false,
    reasons: [],
  }

  const bucket = urgencyBucket(skeleton, today)
  return {
    ...skeleton,
    overdue: isOverdue(skeleton, today),
    // 入选理由（按 A–F 的表序）+ 档位理由（**恒为一条**，§4「取第一个命中的」）
    reasons: [...selectionReasons(skeleton, today), bucketReasonOf(bucket)],
  }
}

/**
 * 把一个任务缝成一行读模型（任务明细页也要用）。
 *
 * ⚠️ 本函数**不判 `deletedAt`**：软删除的任务该不该出现由调用方按视图决定
 * （`buildTodoItems` 已替你过滤掉）。
 */
export function buildTodoItem(input: TodoReadInput, task: ProjectedTask): TodoItem {
  assertDayKey(input.today, 'today')
  return buildOne(task, input.events, stepCheckLookup(input.stepChecks), input.today)
}

/**
 * 把全部任务缝成读模型（**已删除的除外**——软删除的任务不出现在任何视图里，ADR-013 §4.8）。
 *
 * 返回的数组与 `input.tasks` 同序；**不排序**——顺序由 `sort.ts` 的 `sortItems` 决定
 * （ADR-015 §7：服务端与前端导入同一份纯函数，不得在组件里重写排序）。
 */
export function buildTodoItems(input: TodoReadInput): TodoItem[] {
  assertDayKey(input.today, 'today')
  const checks = stepCheckLookup(input.stepChecks)
  const items: TodoItem[] = []
  for (const task of input.tasks) {
    if (task.deletedAt !== null) continue
    items.push(buildOne(task, input.events, checks, input.today))
  }
  return items
}

/**
 * 今日视图的**入选集合**（§3 的 A–F）。
 *
 * ⚠️ **不排序**：默认顺序 = `sortItems(todayItems(input), input.today)`（§4 / §7）。
 * 二者都是纯函数，服务端与前端同一份。
 *
 * ⚠️ **不得改用 `inScope(item, { kind: 'range', from: today, to: today })`**——
 * 那会让所有逾期项从今日视图消失（§5 的警告，有专门的回归测试）。
 */
export function todayItems(input: TodoReadInput): TodoItem[] {
  assertDayKey(input.today, 'today')
  return buildTodoItems(input).filter((item) => isInTodayView(item, input.today))
}

function stepCheckLookup(checks: readonly StepCheck[] | undefined): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>()
  if (checks === undefined) return lookup
  for (const check of checks) {
    const key = stepCheckKey(check.taskId, check.stepId, check.occurrenceKey)
    const current = lookup.get(key)
    // 同一键出现多次时按 `checkedAt` 的字典序取较晚者（ISO 串的字典序 === 时间序）。
    // 上游已折叠，这里只是不让误用变成静默的随机结果。
    if (current === undefined || check.checkedAt > current) lookup.set(key, check.checkedAt)
  }
  return lookup
}

function assertDayKey(value: DayKey, name: string): void {
  if (!isDayKey(value)) {
    throw new RangeError(`${name} 不是合法 DayKey：'${String(value)}'`)
  }
}
