/**
 * 任务与读模型 —— ADR-013 / ADR-015 的 `shared/` 层。**桶文件，只做再导出，无任何实现。**
 *
 * 六个文件的职责（ADR-015 §后果 的清单）：
 *
 * | 文件 | 管什么 |
 * |---|---|
 * | `types.ts` | 域类型的**唯一落点**（`Task` / `Step` / `StepCheck` / `RecurrenceSpec` / `TodoItem` / `Scope`…） |
 * | `rounds.ts` | 任务层 ↔ `@shared/recurrence` 的**唯一跨越点**（两个函数 + 实例的解算） |
 * | `today.ts` | 今日待办：缝合、A–F 入选、紧迫日折算与档位、视图范围 |
 * | `sort.ts` | 全序（档位 → 重要性 → `createdAt` → `taskId`） |
 * | `filter.ts` | 状态 / 范围 / 标签筛选、项目视图的区间分组 |
 * | `state.ts` | ADR-013 §2 的迁移表（前端禁用按钮、服务端 409 的同一份判据） |
 *
 * **为什么要有这个桶**：`shared/` 下每个模块都从自己的入口导入（`@shared/time` /
 * `@shared/recurrence` / `@shared/plan`），本目录此前是唯一例外，而
 * **ADR-013 §3 与 ADR-014 §1 都写着从 `@shared/tasks` 导入**——ADR-014 那处已注明
 * 「该模块的桶文件（index.ts）」。显式路径（`@shared/tasks/types` 等）**照旧可用**，
 * 本文件只是并列提供同一个公开面，**不引入第二份定义**：这里每一个名字都原样再导出，
 * 没有一行实现。
 *
 * **不含 `test-fixtures.ts`**：那是 `*.test.ts` 专用的夹具，不在生产路径上。
 *
 * 两个**不属于本模块**的常用类型，需要时各回各家导入（ADR-015 §后果：
 * `tasks` 与 `plan` 是分工而非重复）：
 * - `DayKey` / `TimeContext` → `@shared/time`
 * - `ProjectInterval` / `Anchors` / `OwnershipLevel` → `@shared/plan`
 */
export type {
  Importance,
  NextAnchor,
  OccurrenceCompletedPayload,
  OccurrenceEvent,
  OccurrenceUncompletedPayload,
  ProjectedTask,
  RecurrenceSpec,
  Scope,
  Step,
  StepCheck,
  Task,
  TaskStatus,
  TodoItem,
  TodoItemStep,
  TodoReason,
} from './types'

/** 跨越点（ADR-013 §3）与实例解算（ADR-015 §2） */
export {
  effectiveCompletions,
  eventToCompletion,
  lastEventPerOccurrence,
  resolveInstance,
  roundsOf,
  toRecurrenceTemplate,
} from './rounds'
export type { ResolvedInstance } from './rounds'

/** 今日待办（ADR-015 §3 / §4 / §5） */
export {
  BUCKET_REASON,
  bucketReasonOf,
  buildTodoItem,
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
export type { TodoBucket, TodoReadInput } from './today'

/** 排序（ADR-015 §4 / §7） */
export { compareBySmart, sortItems } from './sort'
export type { SortMode } from './sort'

/** 筛选（ADR-015 §4 的优先级表 / §5 的项目视图） */
export { isOutsideProjectRange, matchesQuery, queryItems } from './filter'
export type { StatusFilter, TaskQuery } from './filter'

/** 状态迁移（ADR-013 §2；错误码取自 ADR-017 §2） */
export {
  canChangeStatus,
  canCompleteOccurrence,
  canRescheduleTask,
  canUncompleteOccurrence,
  STATUS_TRANSITIONS,
  TASK_STATUSES,
} from './state'
export type { TaskActionRejection, TaskActionVerdict } from './state'
