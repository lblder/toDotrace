import type { Db } from '../db/connection.js'
import type { DayKey } from '@shared/time'
import { AnchorInvariantError } from '@shared/recurrence'
import {
  buildTodoItem,
  type OccurrenceCompletedPayload,
  type OccurrenceEvent,
  type OccurrenceUncompletedPayload,
  type StepCheck,
  type TodoItem,
  type TodoReadInput,
} from '@shared/tasks'
import {
  taskOccurrenceCompletedDefinition,
  taskOccurrenceUncompletedDefinition,
  taskRescheduledDefinition,
  taskStepToggledDefinition,
} from '../events/index.js'
import { readAccountEvents } from '../events/event-store.js'
import { foldedEvents } from '../events/project.js'
import { readProjection } from '../events/projection-store.js'
import type { Event, ProjectedTask, Projection } from '../events/types.js'

/**
 * 读路径的**取数层**：把「任务行的当前态」与「完成 / 勾选事件」凑成读模型的输入。
 *
 * ## 它为什么必须存在
 *
 * ADR-015 的 `TodoItem` 是**缝**出来的：任务定义来自投影表，完成态来自**事件**
 * （ADR-007 §4：完成态不进投影行），重复任务的轮次由 `deriveRounds` 推导。
 * 服务端每一条读路径（列表、明细、完成 / 取消后的响应）都要这三样，
 * 于是取数只有一处——两处各拼一遍的后果是「同一条任务在列表里已完成、在明细里未完成」，
 * 而那种分叉没有任何报错。
 *
 * ## 一次请求只读一次流水
 *
 * `loadTaskSources` 一次取回该账号的全部事件，`occurrenceEventsOf` / `stepChecksOf` /
 * `reschedulesOf` 都从**同一份数组**派生。事件流的规模是账号级的（几百条任务、
 * 几千条事件），一次全读比按类型查三次更可预测，也让「同一个请求内的两次判断
 * 看到的是同一份流水」成为结构事实——分两次读会得到「完成事件已写、勾选事件还没读到」
 * 这类半截状态。
 *
 * ⚠️ **本模块只读，不写**：它不碰投影表（那是 `projection-store` 的独占职责），
 * 也不追加事件。读事件流是为了**读模型**（ADR-015 §2 明文要求「取该任务全部
 * 完成/取消事件中最后一条」），不是为了绕过 `apply` 改投影——两者不是一回事。
 */

/** 该账号的投影与全部事件（一次请求内共用同一份，见文件头） */
export interface TaskSources {
  projection: Projection
  events: readonly Event[]
}

export function loadTaskSources(db: Db, accountId: string): TaskSources {
  return {
    projection: readProjection(db, accountId),
    // ⚠️ **必须经 `foldedEvents`**（排定覆盖面边界 + 跳过被撤销批次），**不能直接吃
    // `readAccountEvents` 的原始流水**：完成态与步骤勾选由事件固化（ADR-007 §4 /
    // ADR-013 §4.12），撤销一个批次之后那些事件必须**同时**从投影与读路径里消失。
    // 直接吃原始流水会出现「投影里任务已经回来了，但它的完成记录还算数」——
    // 两个真相，且没有任何报错。这一条是实测发现的（撤销一次顺延后 `carryCount`
    // 仍是 2，而它按 ADR-013 §4.3 必须是 1）。
    events: foldedEvents(readAccountEvents(db, accountId)),
  }
}

/**
 * 完成 / 取消完成事件，**保持事件 id 序**。
 *
 * 映射成 `OccurrenceEvent`（`shared/tasks/types.ts`）而不是直接传 `Event<P>`：
 * `shared/` 不得 import `server/`，故 ADR-015 §2 把签名收窄成结构化参数。
 * `accountId` 取自**事件行**的 `account_id` 列（ADR-011 §4：跨账号串台的结构性防线）——
 * 这正是「漏填会抛错、填错则静默采纳」的那个字段，在服务端它只有这一个来源。
 */
export function occurrenceEventsOf(events: readonly Event[]): OccurrenceEvent[] {
  const result: OccurrenceEvent[] = []
  for (const event of events) {
    if (event.type === taskOccurrenceCompletedDefinition.type) {
      result.push({
        type: 'task/occurrence-completed',
        eventId: event.id,
        accountId: event.accountId,
        occurredAt: event.occurredAt,
        payload: event.payload as OccurrenceCompletedPayload,
      })
    } else if (event.type === taskOccurrenceUncompletedDefinition.type) {
      result.push({
        type: 'task/occurrence-uncompleted',
        eventId: event.id,
        accountId: event.accountId,
        occurredAt: event.occurredAt,
        payload: event.payload as OccurrenceUncompletedPayload,
      })
    }
  }
  return result
}

/**
 * 步骤勾选的**折叠结果**：键 =（`taskId`, `stepId`, `occurrenceKey`），
 * 同一键取**最后一条** `task/step-toggled`（事件 id 序，ADR-001 §2）；
 * 最后一条的 `checkedAt` 为 `null`（取消勾选）时该键**不出现**。
 *
 * 与完成态同一形态（ADR-013 §4.12）：勾选属于**某一轮实例**，不进投影表，
 * 由事件折叠得出。「没有例外」——这条纪律不因为对象是步骤就放宽。
 *
 * ⚠️ **复合键的分隔符必须写成转义序列 `\x00`，不得内嵌裸 NUL 字节**（与
 * `shared/tasks/today.ts` 同一处置）：裸字节会让**整个文件对 grep 变成二进制**
 * ——grep 不报错、不提示，**只是静默返回空**。一次针对「某道门槛存不存在」的 grep
 * 静默返回空，足以让人得出错误结论；而 ADR-013 §6 要求静态纪律扫描的根扩到
 * `shared/` 与 `server/`，带裸 NUL 的文件会被那条扫描**静默漏掉**。
 * 转义序列的运行时行为与裸字节完全相同，文件却仍然是文本。
 */
export function stepChecksOf(events: readonly Event[]): StepCheck[] {
  interface Folded {
    eventId: string
    check: StepCheck | null
  }
  const folded = new Map<string, Folded>()
  for (const event of events) {
    if (event.type !== taskStepToggledDefinition.type) continue
    const payload = event.payload as {
      taskId: string
      stepId: string
      originalPlannedDate: DayKey
      checkedAt: string | null
    }
    const key = `${payload.taskId}\x00${payload.stepId}\x00${payload.originalPlannedDate}`
    const current = folded.get(key)
    // 按事件 id 序取最大者。流水已按 id 升序，这里仍显式比较：与
    // `lastEventPerOccurrence` / `deriveRounds` 同一条纪律——「按传入顺序取最后一条」
    // 是别处的实现细节，而「按 id 序取最大者」是契约本身，两者必须能独立成立。
    if (current !== undefined && event.id < current.eventId) continue
    folded.set(key, {
      eventId: event.id,
      check:
        payload.checkedAt === null
          ? null
          : {
              taskId: payload.taskId,
              stepId: payload.stepId,
              occurrenceKey: payload.originalPlannedDate,
              checkedAt: payload.checkedAt,
            },
    })
  }
  const checks: StepCheck[] = []
  for (const entry of folded.values()) {
    if (entry.check !== null) checks.push(entry.check)
  }
  return checks
}

/**
 * 读模型的入参（`TodoReadInput`）：投影里的任务 + 完成事件 + 勾选态 + `today`。
 *
 * `today` **由服务端算出并传入**（ADR-015 §6）：客户端若自行算，跨零点的那一刻
 * 两端会算出不同日期，症状是「列表里的任务点不动」，且没有任何报错。
 */
export function todoInputOf(sources: TaskSources, today: DayKey): TodoReadInput {
  return {
    tasks: sources.projection.tasks,
    events: occurrenceEventsOf(sources.events),
    stepChecks: stepChecksOf(sources.events),
    today,
  }
}

/**
 * **按任务 id 找行**（含已软删除的）。找不到返回 `undefined`。
 *
 * `deletedAt` 的判定**不在这里**：要不要看已删除的任务由各路由自己决定——
 * `GET /api/tasks/:id` 对它 404，而取消完成按 `shared/tasks/state.ts` 的裁决
 * **允许**已删除的任务（放弃与完成态正交，误点完成需要一个更正入口）。
 */
export function findTask(projection: Projection, taskId: string): ProjectedTask | undefined {
  return projection.tasks.find((task) => task.id === taskId)
}

/**
 * 把一条任务缝成读模型的一行。
 *
 * ## 为什么在这里包一层 try/catch
 *
 * `AnchorInvariantError` 是**读时抛出**的（`deriveRounds` 发现某条完成事件固化的锚点
 * 不满足 ADR-011 §5 的不变式），而它抛出的时刻只知道 `originalPlannedDate`，
 * **不知道是哪个任务**——ADR-017 §2 要求日志里同时有 `taskId` 与 `originalPlannedDate`，
 * 「使『哪条事件坏了』从猜测变成可查的事实」。
 *
 * 这一层是**唯一知道当前正在缝哪条任务**的地方，于是它把 `taskId` 附到
 * **同一个错误对象**上再原样抛出：
 *
 * - **不吞、不降级**：错误对象、类型、栈都不变，中间件仍按 `500` 处理
 *   （ADR-017 §2：「不得把它降级成 4xx，也不得吞掉后返回部分结果」）；
 * - **不换类型**：包装成新错误会让 `instanceof AnchorInvariantError` 失效，
 *   而那正是中间件识别它的方式。
 */
export function buildItem(input: TodoReadInput, task: ProjectedTask): TodoItem {
  try {
    return buildTodoItem(input, task)
  } catch (error) {
    if (error instanceof AnchorInvariantError) {
      throw withTaskId(error, task.id)
    }
    throw error
  }
}

/** 把任务标识附到 `AnchorInvariantError` 上（见 `buildItem`） */
export function withTaskId(error: AnchorInvariantError, taskId: string): AnchorInvariantError {
  ;(error as AnchorInvariantWithTask).taskId = taskId
  return error
}

/**
 * 带上任务标识的 `AnchorInvariantError`。
 *
 * 该字段**不是** `shared/recurrence` 契约的一部分（那里只有 `originalPlannedDate` 与
 * `nextAnchorDate`），而是服务端为满足 ADR-017 §2 的日志要求附加的。故它是可选属性，
 * 读取方（`middleware/error.ts`）必须容忍它缺席——从重建、导入等**没有任务上下文**
 * 的路径抛出来时它就是缺席的，而那时「不知道是哪条任务」正是事实。
 *
 * ⚠️ **ADR-017 §2 说「该错误对象上两者都有」是不准确的**：`AnchorInvariantError`
 * 只有 `originalPlannedDate` 与 `nextAnchorDate`，**没有 `taskId`**
 * （见 `shared/recurrence/types.ts`）。本字段就是那个缺口的服务端补法。
 */
export interface AnchorInvariantWithTask extends AnchorInvariantError {
  taskId?: string
}

/**
 * 该任务的**全部顺延记录**（FR2.7 要求展示「原定 X → 现 Y」），按事件 id 序（最早在前）。
 *
 * `carryCount` 就是它的条数（ADR-013 §4.3：派生量，「由 `task/rescheduled` 事件的条数算出」，
 * **不落库**——落库就多一处会与事件分叉的地方，而撤销一次顺延批次时它必须自然减一）。
 *
 * `from*` 三列**不入投影**（`definitions/tasks.ts` 的 `apply` 只写 `to*`），
 * 故这份历史只能从流水读出——它也因此没有第二个来源。
 */
export interface RescheduleRecord {
  fromPlannedDate: DayKey | null
  toPlannedDate: DayKey | null
  fromPlannedWeek: DayKey | null
  toPlannedWeek: DayKey | null
  fromDueDate: DayKey | null
  toDueDate: DayKey | null
  /** 该次顺延的发生时刻（事件行的 `occurred_at`） */
  occurredAt: string
  /** 该次顺延所在**批次**——撤销入口（`POST /api/undo`）的入参 */
  batchId: string
}

export function reschedulesOf(events: readonly Event[], taskId: string): RescheduleRecord[] {
  const records: RescheduleRecord[] = []
  for (const event of events) {
    if (event.type !== taskRescheduledDefinition.type) continue
    const payload = event.payload as {
      taskId: string
      fromPlannedDate: DayKey | null
      toPlannedDate: DayKey | null
      fromPlannedWeek: DayKey | null
      toPlannedWeek: DayKey | null
      fromDueDate: DayKey | null
      toDueDate: DayKey | null
    }
    if (payload.taskId !== taskId) continue
    records.push({
      fromPlannedDate: payload.fromPlannedDate,
      toPlannedDate: payload.toPlannedDate,
      fromPlannedWeek: payload.fromPlannedWeek,
      toPlannedWeek: payload.toPlannedWeek,
      fromDueDate: payload.fromDueDate,
      toDueDate: payload.toDueDate,
      occurredAt: event.occurredAt,
      batchId: event.batchId,
    })
  }
  return records
}
