import { z } from 'zod'
import { isDayKey } from '@shared/time'
import { isUuidV7 } from '../../lib/uuid.js'
import { defineEvent, type EventDefinition, type RegisteredDefinition } from '../types.js'

/**
 * 聚焦是日级选择，不是任务定义。三元组 `(focusDayKey, taskId, occurrenceKey)`
 * 的当前状态由参与重放的事件序列派生；无需再建一张可与流水分叉的投影表。
 */
export const FOCUS_ADDED_TYPE = 'task/focus-added'
export const FOCUS_REMOVED_TYPE = 'task/focus-removed'

export const focusPayloadSchema = z.object({
  taskId: z.string().refine(isUuidV7, 'taskId 必须是 UUIDv7'),
  occurrenceKey: z.string().refine(isDayKey, 'occurrenceKey 必须是真实日历日'),
  focusDayKey: z.string().refine(isDayKey, 'focusDayKey 必须是真实日历日'),
}).strict()

export type FocusEventPayload = z.infer<typeof focusPayloadSchema>

const target = {
  kind: 'task',
  fromPayload: (payload: FocusEventPayload): string => payload.taskId,
}

function assertSameDay(eventDayKey: string, focusDayKey: string): void {
  if (eventDayKey !== focusDayKey) {
    throw new Error(`聚焦事件的 day_key（${eventDayKey}）与 focusDayKey（${focusDayKey}）不一致`)
  }
}

export const focusAddedDefinition: EventDefinition<FocusEventPayload> = defineEvent({
  type: FOCUS_ADDED_TYPE,
  schema: focusPayloadSchema,
  target,
  apply(_projection, event) {
    // 读模型直接对 `foldedEvents` 折叠；apply 仍参与全量重放和增量写入校验。
    assertSameDay(event.dayKey, event.payload.focusDayKey)
  },
})

export const focusRemovedDefinition: EventDefinition<FocusEventPayload> = defineEvent({
  type: FOCUS_REMOVED_TYPE,
  schema: focusPayloadSchema,
  target,
  apply(_projection, event) {
    assertSameDay(event.dayKey, event.payload.focusDayKey)
  },
})

export const focusEventDefinitions: readonly RegisteredDefinition[] = [
  focusAddedDefinition,
  focusRemovedDefinition,
]
