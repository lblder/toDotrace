/**
 * `rounds.ts` —— **任务层与 `shared/recurrence` 之间唯一的跨越点**（ADR-013 §3 / ADR-015 §2）。
 *
 * 两个方向的跨越各一个函数，**同落在这里**：
 *
 * - 进：`toRecurrenceTemplate(task)` —— 任务 → 模板；
 * - 出：`eventToCompletion(event)` —— 完成事件 → `RoundCompletion`。
 *
 * **除这两个以外，任何模块不得自行拼装 `RecurrenceTemplate` 或 `RoundCompletion`**
 * （ADR-013 §3 明文）。位置在 `shared/` 而不是服务端，是因为**前端也要缝合**：
 * 排序筛选吃 `TodoItem`，任务明细页要显示全部轮次历史；放服务端会逼前端再写一份推导，
 * 那就是两个真相（ADR-009 §1）。
 *
 * 本文件同时承载 ADR-015 §2 的**非重复任务分支**：非重复任务的唯一实例**不走
 * `deriveRounds`**（它没有规则可推），其完成态由该实例键上**最后一条**完成/取消事件决定。
 *
 * ```
 * 非重复：实例键 = indexDate（与当前 plannedDate 无关）
 * 重复  ：实例键 = 该轮的 originalPlannedDate（deriveRounds 给出）
 * ```
 *
 * ⚠️ **「最后一条」不是「存在任意一条」**（ADR-015 §2）：取消完成是**追加**一条
 * `task/occurrence-uncompleted`（ADR-013 §4.7），故同一实例会有多条记录，
 * **只有最后一条决定当前态**。按「存在即完成」判定会让取消完成永久失效，
 * 且**撤销之后也不会恢复**（事件少了，那个错误判定反而更「成立」）。
 */
import { compareDayKey } from '@shared/time'
import type { DayKey } from '@shared/time'
import { deriveRounds } from '@shared/recurrence'
import type { NextAnchorMode, RecurrenceTemplate, Round, RoundCompletion } from '@shared/recurrence'

import type { OccurrenceEvent, ProjectedTask } from './types'

/**
 * 任务 → 模板。**null 当且仅当 `task.recurrence === null`**（ADR-013 §3）——
 * 类型上排除「非重复任务去推轮次」这件事，调用方不必自己判。
 *
 * `startsOn` **原样搬运、绝不推导**（ADR-013 §3 的陷阱）：它是相位原点，
 * 与「打算哪天做」是两件事，`plannedDate` 改了它也必须不变。
 *
 * 本函数**不做规则校验**：`deriveRounds` 内部会 `assertValidTemplate`
 * （ADR-011 §4.1 的 `RecurrenceRuleError`），再校验一遍就是两份判据。
 */
export function toRecurrenceTemplate(task: ProjectedTask): RecurrenceTemplate | null {
  const spec = task.recurrence
  if (spec === null) return null
  return {
    id: task.id,
    accountId: task.accountId,
    title: task.title,
    rule: spec.rule,
    nextAnchorMode: spec.nextAnchorMode,
    startsOn: spec.startsOn,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * 完成事件 → `RoundCompletion`（ADR-011 §4 的映射式）。
 *
 * **签名必须是结构化的三个值**，不能照搬 `server/events/definitions/recurrence.ts`
 * 里那个吃 `Event<P>` 的版本：`Event` 是**服务端类型**，而 `shared/` 不能 import `server/`
 * （阶段 4 复核实测）。两个附加字段本来就取自**事件行**而非载荷
 * （`accountId` 来自 `account_id` 列、`eventId` 来自 `id` 列），故这次收窄
 * **只是把「它实际用到的」写进签名**，不改变任何行为。
 *
 * 逐字段显式构造、**不用类型断言**：断言会放过漏字段（`RoundCompletion` 新增必填字段时
 * 照样编译通过，运行期是 `undefined`），而漏 `accountId` 的后果是 `deriveRounds`
 * 把每条记录都判成「别人的」→ **历史轮次全部静默消失且不报错**（ADR-011 §4）。
 */
export function eventToCompletion(input: {
  eventId: string
  accountId: string
  payload: {
    taskId: string
    originalPlannedDate: DayKey
    completedDayKey: DayKey
    next: { date: DayKey; mode: NextAnchorMode } | null
  }
}): RoundCompletion {
  const next = input.payload.next
  return {
    accountId: input.accountId,
    templateId: input.payload.taskId, // taskId → templateId：ADR-013 §4.6 的搬运
    originalPlannedDate: input.payload.originalPlannedDate,
    completedDayKey: input.payload.completedDayKey,
    nextAnchorDate: next === null ? null : next.date,
    // 「没有下一轮」时**宁可让字段可空，也不填一个无意义的默认值**——随便填一个
    // `catch_up` 是往数据结构里写谎，读的人会以为系统选了它（ADR-013 §4.6）。
    // 该可空性由 `shared/recurrence/types.ts` 里 §4.6 授权的唯一一处放宽承载
    // （`nextAnchorMode: NextAnchorMode | null`，逻辑一行未改）。
    nextAnchorMode: next === null ? null : next.mode,
    eventId: input.eventId,
  }
}

/** 该事件是否属于该任务（`taskId` 与 `accountId` **同时**相等，ADR-011 §4） */
function belongsTo(event: OccurrenceEvent, task: ProjectedTask): boolean {
  return event.payload.taskId === task.id && event.accountId === task.accountId
}

/**
 * 每个实例键上**最后一条**完成/取消事件（ADR-001 §2 的事件 id 序）。
 *
 * 过滤条件是 `taskId` 与 `accountId` **同时**相等——`accountId` 是跨账号串台的防线
 * （ADR-011 §4）：模板/任务 id 只在账号内唯一，而 ADR-005 允许 B 导入 A 导出的同一份文件。
 * 它的上限是「挡漏填、挡不住填错」（ADR-011 §4 已登记），故 `accountId` 必须来自鉴权上下文。
 */
export function lastEventPerOccurrence(
  task: ProjectedTask,
  events: readonly OccurrenceEvent[],
): Map<DayKey, OccurrenceEvent> {
  const latest = new Map<DayKey, OccurrenceEvent>()
  for (const event of events) {
    if (!belongsTo(event, task)) continue
    const key = event.payload.originalPlannedDate
    const current = latest.get(key)
    // 按事件 id 序取最大者。调用方须按该序传入，这里**再取一次最大值以防误用**
    // （ADR-011 §4 对 deriveRounds 的同款要求，理由逐字相同）。
    if (current === undefined || event.eventId > current.eventId) latest.set(key, event)
  }
  return latest
}

/**
 * **有效完成事件**：每个实例键上「最后一条是完成」的那些，按事件 id 序升序。
 *
 * 这是 `deriveRounds` 的输入。取消完成（最后一条是 `task/occurrence-uncompleted`）
 * 的实例**不在这里出现**——于是 `deriveRounds` 会把它重新算成待完成轮次，
 * 「完成 → 取消后为未完成」因此在重复任务上也成立。
 */
export function effectiveCompletions(
  task: ProjectedTask,
  events: readonly OccurrenceEvent[],
): (OccurrenceEvent & { type: 'task/occurrence-completed' })[] {
  const effective: (OccurrenceEvent & { type: 'task/occurrence-completed' })[] = []
  for (const event of lastEventPerOccurrence(task, events).values()) {
    if (event.type === 'task/occurrence-completed') effective.push(event)
  }
  // 按事件 id 序：`deriveRounds` 的「已完成轮次」原样按传入顺序返回（ADR-011 §4 规则 1），
  // 顺序因此必须确定，否则「增量 == 全量」那类逐字段断言会 flaky。
  return effective.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
}

/**
 * 该任务的**全部轮次**（ADR-011 §4）：已完成轮次 + **至多一条**待完成轮次。
 *
 * - 重复任务：`deriveRounds(toRecurrenceTemplate(task), 有效完成记录, today)` 原样调用；
 * - 非重复任务：唯一的实例（§2），键恒为 `indexDate`，完成态由「最后一条事件」决定。
 *
 * 抽出来是因为**读模型的两处都要它**：今日视图只取其中「当前那一轮」，
 * 而任务明细页要显示全部历史（ADR-013 §3：前端也要缝合）。
 */
export function roundsOf(
  task: ProjectedTask,
  events: readonly OccurrenceEvent[],
  today: DayKey,
): Round[] {
  const template = toRecurrenceTemplate(task)
  if (template !== null) {
    return deriveRounds(template, effectiveCompletions(task, events).map(eventToCompletion), today)
  }

  // ── 非重复任务的「唯一实例」分支（ADR-015 §2）——**不走 deriveRounds** ──
  const last = lastEventPerOccurrence(task, events).get(task.indexDate)
  if (last !== undefined && last.type === 'task/occurrence-completed') {
    return [
      {
        templateId: task.id,
        originalPlannedDate: task.indexDate,
        status: 'completed',
        completedDayKey: last.payload.completedDayKey,
        title: task.title,
      },
    ]
  }
  return [
    {
      templateId: task.id,
      originalPlannedDate: task.indexDate,
      status: 'pending',
      title: task.title,
    },
  ]
}

/**
 * 「当前那一轮」——今日视图与任务行要显示的那个实例（ADR-015 §2 / §3）。
 *
 * 选轮优先级**必须写死**，否则同一个任务在不同视图里会显示不同的轮次：
 *
 * 1. **待完成轮次**（若有）——它就是「今天要做的那件事」（§3 E）；
 * 2. 否则，**今天完成的轮次**（`completedDayKey === today`，多条取原计划日期最大者）
 *    ——§3 D/F「今天做完的要留在视野里」；
 * 3. 否则，**最后一个已完成轮次**（原计划日期最大者）——供项目 / 全部视图显示任务行；
 * 4. 否则，`indexDate`。可达：`startsOn` 在未来的重复任务到 today 为止一轮都没有
 *    （ADR-013 §3.3 允许给任务增设规则时 `startsOn = plannedDate ?? indexDate`，
 *    `plannedDate` 可以是未来）。此时 `indexDate` 是唯一稳定的日期分量；
 *    ⚠️ 这样的任务**不会**因此进今日视图——§3 的 A–F 没有一条会命中它。
 */
export interface ResolvedInstance {
  /** 展示的那一轮的实例键（§2） */
  occurrenceKey: DayKey
  /** 本实例的完成事件；null = 未完成（含「完成过又取消」——最后一条决定，§2） */
  completion: (OccurrenceEvent & { type: 'task/occurrence-completed' }) | null
  /**
   * 重复任务：该模板当前的**待完成轮次**（ADR-011 §4 至多一条，
   * 且恒 `≤ today`）；非重复任务恒为 null。
   */
  pending: DayKey | null
  /** 全部轮次（同 `roundsOf`），供明细页/历史区使用 */
  rounds: Round[]
}

export function resolveInstance(
  task: ProjectedTask,
  events: readonly OccurrenceEvent[],
  today: DayKey,
): ResolvedInstance {
  const rounds = roundsOf(task, events, today)
  const completions = effectiveCompletions(task, events)
  const completionByKey = new Map<DayKey, (typeof completions)[number]>()
  for (const completion of completions) {
    completionByKey.set(completion.payload.originalPlannedDate, completion)
  }

  // 「待完成轮次」是 ADR-011 §4 的概念，**只对重复任务成立**。
  // 非重复任务的唯一实例在 `roundsOf` 里也用 `status: 'pending'` 表示「未完成」，
  // 但那是「这一轮还没做完」，不是「模板推到今天的那一轮」——两者混同会让
  // `TodoItem.pending` 对普通任务恒为 true，而 §3 E 的判据就建立在它上面。
  let pending: DayKey | null = null
  if (task.recurrence !== null) {
    for (const round of rounds) {
      if (round.status === 'pending') pending = round.originalPlannedDate
    }
  }

  const pick = (key: DayKey): ResolvedInstance => ({
    occurrenceKey: key,
    completion: completionByKey.get(key) ?? null,
    pending,
    rounds,
  })

  // 0. 非重复任务：实例键**恒为 `indexDate`**（ADR-015 §2），到此为止。
  // 不能走下面的 2/3——那些分支按「完成事件落在哪个键上」选轮次，
  // 而一条 `originalPlannedDate ≠ indexDate` 的孤儿完成事件（补记、或合并导入带来的）
  // 会因此把这个任务的实例键**换掉**，于是它的完成态与「本实例」不再对应同一件事。
  if (task.recurrence === null) return pick(task.indexDate)

  // 1. 待完成轮次
  if (pending !== null) return pick(pending)

  // 2. 今天完成的轮次（多条时取原计划日期最大者）
  let completedToday: DayKey | null = null
  for (const [key, completion] of completionByKey) {
    if (compareDayKey(completion.payload.completedDayKey, today) !== 0) continue
    if (completedToday === null || compareDayKey(key, completedToday) > 0) completedToday = key
  }
  if (completedToday !== null) return pick(completedToday)

  // 3. 最后一个已完成轮次
  let latest: DayKey | null = null
  for (const key of completionByKey.keys()) {
    if (latest === null || compareDayKey(key, latest) > 0) latest = key
  }
  if (latest !== null) return pick(latest)

  // 4. 一轮都没有（`startsOn` 在未来）
  return pick(task.indexDate)
}
