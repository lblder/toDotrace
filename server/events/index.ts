/**
 * 事件存储与重放（ADR-010 阶段 2，各阶段陆续登记自己的类型）。
 *
 * 分层：
 *   definitions/  事件类型定义（schema + apply）——**注册表的唯一来源**
 *                 （system / settings / checkin / notes / tasks / projects 六组）
 *   registry.ts   注册表：未登记的 type 一律拒绝
 *   event-store.ts     events 表读写
 *   projection-store.ts 投影表读写（**全仓唯一写投影表的地方**）
 *   project.ts    纯函数重放：排定边界 → 按 id 升序 → 折叠
 *   append.ts     追加（调用方开事务）+ 增量投影（同事务）
 *   rebuild.ts    全量重建（安全网）
 *   data-migration.ts 启动时的数据迁移（ADR-010 §7：给存量账号补 settings/updated）
 *   settings.ts   账号设置的读取与初始化事件（**只读投影，不写投影表**）
 */

export { appendEvents, classifyMaintenance } from './append.js'
export { backfillAccountSettings } from './data-migration.js'
export { readAccountEvents, findEvent, readMaxEventId } from './event-store.js'
export { project, canonicalizeProjection } from './project.js'
export { readProjection } from './projection-store.js'
export { rebuildProjection } from './rebuild.js'
export {
  ANCHOR_TYPE,
  REVOKE_TYPE,
  SYSTEM_EVENT_TYPES,
  isBoundaryEventType,
  overwriteAnchorDefinition,
  revokeDefinition,
  overwriteAnchorPayloadSchema,
  revokePayloadSchema,
  type OverwriteAnchorPayload,
  type RevokePayload,
} from './definitions/system.js'
export {
  SETTINGS_UPDATED_TYPE,
  isIanaTimeZone,
  settingsEventDefinitions,
  settingsUpdatedDefinition,
  settingsUpdatedPayloadSchema,
  type SettingsUpdatedPayload,
} from './definitions/settings.js'
export {
  CHECKIN_ARRIVED_TYPE,
  CHECKIN_LEFT_TYPE,
  checkinArrivedDefinition,
  checkinEventDefinitions,
  checkinLeftDefinition,
  checkinPayloadSchema,
  type CheckinPayload,
} from './definitions/checkin.js'
export {
  FOCUS_ADDED_TYPE,
  FOCUS_REMOVED_TYPE,
  focusAddedDefinition,
  focusRemovedDefinition,
  focusEventDefinitions,
  focusPayloadSchema,
  type FocusEventPayload,
} from './definitions/focus.js'
export {
  TIMER_CONFIGURED_TYPE,
  TIMER_STARTED_TYPE,
  TIMER_STOPPED_TYPE,
  timerConfiguredDefinition,
  timerStartedDefinition,
  timerStoppedDefinition,
  timerEventDefinitions,
  timerConfiguredPayloadSchema,
  timerStartedPayloadSchema,
  timerStoppedPayloadSchema,
  type TimerConfiguredPayload,
  type TimerStartedPayload,
  type TimerStoppedPayload,
} from './definitions/timer.js'
/**
 * `eventToCompletion` 的**唯一实现在 `@shared/tasks/rounds`**（ADR-013 §3 的跨越点之一：
 * 「进」是 `toRecurrenceTemplate`、「出」是 `eventToCompletion`，两个都在那里）。
 * 这里**只再导出、不重新实现**——`server/` 侧的调用方仍从本层取用，
 * 但全仓只有一份实现（两处各写一份 = 两个真相，ADR-009 §1）。
 */
export { eventToCompletion } from '@shared/tasks/rounds'
export {
  TASK_TARGET_KIND,
  taskCreatedDefinition,
  taskCreatedPayloadSchema,
  taskDeletedDefinition,
  taskDeletedPayloadSchema,
  taskEventDefinitions,
  taskOccurrenceCompletedDefinition,
  taskOccurrenceCompletedPayloadSchema,
  taskOccurrenceUncompletedDefinition,
  taskOccurrenceUncompletedPayloadSchema,
  taskReorderedDefinition,
  taskReorderedPayloadSchema,
  taskRescheduledDefinition,
  taskRescheduledPayloadSchema,
  taskStatusChangedDefinition,
  taskStatusChangedPayloadSchema,
  taskStepAddedDefinition,
  taskStepAddedPayloadSchema,
  taskStepRemovedDefinition,
  taskStepRemovedPayloadSchema,
  taskStepRenamedDefinition,
  taskStepRenamedPayloadSchema,
  taskStepToggledDefinition,
  taskStepToggledPayloadSchema,
  taskStepsReorderedDefinition,
  taskStepsReorderedPayloadSchema,
  taskUpdatedDefinition,
  taskUpdatedPayloadSchema,
  type TaskCreatedPayload,
  type TaskDeletedPayload,
  type TaskOccurrenceCompletedPayload,
  type TaskOccurrenceUncompletedPayload,
  type TaskReorderedPayload,
  type TaskRescheduledPayload,
  type TaskStatusChangedPayload,
  type TaskStepAddedPayload,
  type TaskStepRemovedPayload,
  type TaskStepRenamedPayload,
  type TaskStepToggledPayload,
  type TaskStepsReorderedPayload,
  type TaskUpdatedPayload,
} from './definitions/tasks.js'
export {
  PROJECT_TARGET_KIND,
  projectCreatedDefinition,
  projectCreatedPayloadSchema,
  projectCurrentChangedDefinition,
  projectCurrentChangedPayloadSchema,
  projectOrderDefinition,
  projectOrderPayloadSchema,
  projectArchiveChangedDefinition,
  projectArchiveChangedPayloadSchema,
  projectDeletedDefinition,
  projectDeletedPayloadSchema,
  projectEventDefinitions,
  projectUpdatedDefinition,
  projectUpdatedPayloadSchema,
  type ProjectCreatedPayload,
  type ProjectCurrentChangedPayload,
  type ProjectOrderPayload,
  type ProjectArchiveChangedPayload,
  type ProjectDeletedPayload,
  type ProjectUpdatedPayload,
} from './definitions/projects.js'
export {
  NOTE_UPDATED_TYPE,
  noteEventDefinitions,
  noteUpdatedDefinition,
  noteUpdatedPayloadSchema,
  type NoteUpdatedPayload,
} from './definitions/notes.js'
export { getEventDefinition, isRegisteredType, listRegisteredTypes } from './registry.js'
export {
  initialSettingsDraft,
  loadAccountSettings,
  serverTimeZone,
  timeContextOf,
  type AccountSettings,
} from './settings.js'
export { assertInTransaction, runInTransaction } from './transaction.js'
export { defineEvent } from './types.js'
export type {
  Event,
  EventDefinition,
  EventDraft,
  NextAnchorMode,
  ProjectedDayNote,
  ProjectedProject,
  ProjectedTask,
  Projection,
  RecurrenceRule,
  RecurrenceSpec,
  RecurrenceTemplate,
  RegisteredDefinition,
  Step,
  Task,
} from './types.js'
