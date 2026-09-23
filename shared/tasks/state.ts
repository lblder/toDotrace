/**
 * 状态迁移与「这个动作合不合法」的唯一判据（ADR-013 §2，两端共用）。
 *
 * **前端据此禁用非法按钮，服务端据同一份判据产出 409**——ADR-013 §后果 明令
 * 「不得在前端重写一份」。两份判据必然漂移，而漂移的症状是
 * 「按钮是亮的、点下去报错」，用户只会觉得软件坏了。
 *
 * ## 两个层级，一个真相（ADR-013 §2）
 *
 * | 层级 | 状态 | 存于 |
 * |---|---|---|
 * | **任务级**（意图） | `未开始` / `进行中` / `已放弃` | 任务行 |
 * | **实例级**（完成） | 已完成 / 未完成 | **完成事件** |
 *
 * 因此**完成/取消完成不是任务级迁移**：`TaskStatus` 里没有 `completed`，
 * 它们走 `canCompleteOccurrence` / `canUncompleteOccurrence`（§4.6 / §4.7）。
 *
 * 错误码取自 ADR-017 §2 的清单，**不新增**（ADR-008 §8 沿用）。
 */

import type { RecurrenceSpec, TaskStatus } from './types'

/** 任务级状态集（三元素，一个不少；「已完成」不在其中——它是实例的属性） */
export const TASK_STATUSES: readonly TaskStatus[] = ['not_started', 'in_progress', 'abandoned']

/**
 * 状态迁移表（ADR-013 §2，**唯一一份**）。
 *
 * | 从 | 到 | 触发 |
 * |---|---|---|
 * | `未开始` | `进行中` | 复选框二次切换（`[ ]` → `[/]`），**只能显式触发，绝不自动推断** |
 * | `进行中` | `未开始` | 再次二次切换 |
 * | `未开始` / `进行中` | `已放弃` | 显式动作（重复任务借此终止整个系列） |
 * | `已放弃` | `未开始` | 重新打开 |
 *
 * **`已完成 → 已放弃` 不在这张表里，也不需要单列**：它**与「未开始/进行中 → 已放弃」
 * 是同一条边**——放弃与完成态**正交**（ADR-013 §2：放弃**不取消任何完成记录**，
 * 也不检查任务处于哪个实例状态）。§2 的迁移表把它单列一行，只是为了标注
 * 「用户此刻看到的是已完成」这个**入口**，不是多出一条规则。
 *
 * **`任意 → 已完成` 同样不在这里**：完成不是任务级迁移（见文件头）。
 */
export const STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  not_started: ['in_progress', 'abandoned'],
  in_progress: ['not_started', 'abandoned'],
  abandoned: ['not_started'],
}

/** 动作被拒时的错误码（ADR-017 §2，取自既有清单，不新增） */
export type TaskActionRejection =
  /** 非法状态迁移（如重复任务转「进行中」） */
  | 'conflict/status-transition'
  /** 完成一个**已放弃或已删除**的任务 */
  | 'conflict/task-not-completable'
  /** 重复完成同一实例（未先取消） */
  | 'conflict/occurrence-already-completed'
  /** 取消一个**本就未完成**的实例 */
  | 'conflict/occurrence-not-completed'
  /** 对**重复任务**调 `/reschedule`（ADR-013 §3.2：日期由规则决定，不可直接顺延） */
  | 'conflict/date-driven-by-rule'

/** 判定结果：允许（并区分「会不会真的改变什么」）/ 拒绝（带错误码与可直接展示的文案） */
export type TaskActionVerdict =
  | {
      allowed: true
      /**
       * **`true` = 这会是一次无操作**（`to === from`）。
       *
       * 事件层对同值写入是**幂等**的（ADR-013 §4.4：`task/status-changed` 只带 `to`，
       * 不带 `from`），因此服务端**照收**——否则客户端重试一个响应丢失的请求会拿到 409。
       * 而界面对「无操作」的按钮应当置灰（点了什么也不会发生）。
       * 两个问题分开表达，就不必在「允许」与「拒绝」之间二选一。
       */
      noop: boolean
    }
  | { allowed: false; code: TaskActionRejection; message: string }

function rejected(code: TaskActionRejection, message: string): TaskActionVerdict {
  return { allowed: false, code, message }
}

/**
 * 任务级状态迁移是否合法（ADR-013 §2）。
 *
 * @param from 当前状态（任务行上的 `status`）
 * @param to   目标状态
 * @param recurring 该任务是否重复任务——**重复任务的「进行中」不可达**
 *   （ADR-013 §2：`进行中` 对「系列」无意义；这是一条**可达性约束，不是第二套状态机**，
 *   由服务端在写入前守卫）
 */
export function canChangeStatus(input: {
  from: TaskStatus
  to: TaskStatus
  recurring: boolean
}): TaskActionVerdict {
  const { from, to, recurring } = input

  // 同值：事件幂等（§4.4），照收；界面据此把按钮置灰而不是报错
  if (from === to) return { allowed: true, noop: true }

  if (recurring && to === 'in_progress') {
    return rejected(
      'conflict/status-transition',
      '重复任务的「进行中」不可达：进行中对整个系列没有意义，重复任务只有「进行（未开始）」与「已放弃」两态。',
    )
  }

  if (!STATUS_TRANSITIONS[from].includes(to)) {
    return rejected(
      'conflict/status-transition',
      `从「${from}」不能迁移到「${to}」。`,
    )
  }

  return { allowed: true, noop: false }
}

/**
 * 是否可完成某个实例（ADR-013 §2 / §4.6）。
 *
 * 合法前提是任务 `status ∈ {未开始, 进行中}` 且 `deletedAt === null`，
 * 且该实例**尚未完成**；否则 409。
 *
 * **已放弃的任务不可完成**——放弃是「不做了」，允许它之后再被完成等于让同一条任务
 * 既被放弃又被完成。
 */
export function canCompleteOccurrence(input: {
  task: { status: TaskStatus; deletedAt: string | null }
  /** 该实例（`taskId` + `originalPlannedDate`）当前是否已完成 */
  instanceCompleted: boolean
}): TaskActionVerdict {
  if (input.task.deletedAt !== null) {
    return rejected('conflict/task-not-completable', '任务已删除，不能完成它的实例。')
  }
  if (input.task.status === 'abandoned') {
    return rejected(
      'conflict/task-not-completable',
      '任务已放弃，不能完成它的实例；若要继续做，请先把它「重新打开」（回到未开始）。',
    )
  }
  if (input.instanceCompleted) {
    return rejected(
      'conflict/occurrence-already-completed',
      '这一轮已经完成过了；若要重新完成，请先「取消完成」（历史不会被抹除）。',
    )
  }
  return { allowed: true, noop: false }
}

/**
 * 是否可取消完成某个实例（ADR-013 §4.7）。
 *
 * 唯一前提是**该实例已完成**（否则 409）——取消完成是**追加一条事件**，不是删除，
 * 故已取消过的实例再取消一次会被这条判据挡住，而「完成 → 取消 → 完成」照常可走。
 *
 * ⚠️ **已放弃 / 已删除的任务也能取消完成**：放弃与完成态**正交**（ADR-013 §2），
 * 而「误点了完成」需要一个更正入口；历史不因为放弃而消失，也就不因为放弃而不能更正。
 * 本判据因此**只看实例态**。
 */
export function canUncompleteOccurrence(input: { instanceCompleted: boolean }): TaskActionVerdict {
  if (!input.instanceCompleted) {
    return rejected('conflict/occurrence-not-completed', '这一轮本来就是未完成，没有可取消的完成记录。')
  }
  return { allowed: true, noop: false }
}

/**
 * 是否可顺延任务的日期锚点（ADR-013 §3.2）。
 *
 * **重复任务一律拒绝**：它的实例键 `originalPlannedDate` 是推导出来的
 * （ADR-011 §4），挪动一轮等于换一个实例键——既会与规则的下一次命中冲突，
 * 也会让已完成记录对不上轮次。给重复任务「改到别的时间」的办法是改规则或改 `startsOn`
 * （走 `task/updated`），它平移的是**整条序列**而不是某一轮。
 *
 * 任务是否存在、是否已删除不在这里判：那是路由的 404 职责（ADR-017 §2）。
 */
export function canRescheduleTask(input: { recurrence: RecurrenceSpec | null }): TaskActionVerdict {
  if (input.recurrence !== null) {
    return rejected('conflict/date-driven-by-rule', '该任务的日期由重复规则决定，不可直接顺延。')
  }
  return { allowed: true, noop: false }
}
