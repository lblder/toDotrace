/**
 * 事件存储与重放（ADR-010 / ADR-011 阶段 2）。
 *
 * 分层：
 *   definitions/  事件类型定义（schema + apply）——**注册表的唯一来源**
 *                 （system / settings / recurrence / checkin 四组）
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
  RECURRENCE_TEMPLATE_TARGET_KIND,
  eventToCompletion,
  roundCompletedDefinition,
  roundCompletedPayloadSchema,
  templateCreatedDefinition,
  templateCreatedPayloadSchema,
  templateDeletedDefinition,
  templateDeletedPayloadSchema,
  templateUpdatedDefinition,
  templateUpdatedPayloadSchema,
  type RoundCompletedPayload,
  type TemplateCreatedPayload,
  type TemplateDeletedPayload,
  type TemplateUpdatedPayload,
} from './definitions/recurrence.js'
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
  ProjectedTemplate,
  Projection,
  RecurrenceRule,
  RecurrenceTemplate,
  RegisteredDefinition,
} from './types.js'
