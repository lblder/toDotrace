import { z } from 'zod'
import { isDayKey } from '@shared/time'
import { isUuidV7 } from '../../lib/uuid.js'
import { defineEvent, type EventDefinition, type RegisteredDefinition } from '../types.js'

export const TIMER_CONFIGURED_TYPE = 'task/timer-configured'
export const TIMER_STARTED_TYPE = 'task/timer-started'
export const TIMER_STOPPED_TYPE = 'task/timer-stopped'

const taskId = z.string().refine(isUuidV7, 'taskId 必须是 UUIDv7')
const sessionId = z.string().refine(isUuidV7, 'sessionId 必须是 UUIDv7')

export const timerConfiguredPayloadSchema = z.object({ taskId, enabled: z.boolean() }).strict()
export const timerStartedPayloadSchema = z.object({
  taskId,
  occurrenceKey: z.string().refine(isDayKey, 'occurrenceKey 必须是真实日历日'),
}).strict()
export const timerStoppedPayloadSchema = z.object({ taskId, sessionId }).strict()

export type TimerConfiguredPayload = z.infer<typeof timerConfiguredPayloadSchema>
export type TimerStartedPayload = z.infer<typeof timerStartedPayloadSchema>
export type TimerStoppedPayload = z.infer<typeof timerStoppedPayloadSchema>

const target = {
  kind: 'task',
  fromPayload: (payload: { taskId: string }): string => payload.taskId,
}

export const timerConfiguredDefinition: EventDefinition<TimerConfiguredPayload> = defineEvent({
  type: TIMER_CONFIGURED_TYPE,
  schema: timerConfiguredPayloadSchema,
  target,
  apply() {},
})

export const timerStartedDefinition: EventDefinition<TimerStartedPayload> = defineEvent({
  type: TIMER_STARTED_TYPE,
  schema: timerStartedPayloadSchema,
  target,
  apply() {},
})

export const timerStoppedDefinition: EventDefinition<TimerStoppedPayload> = defineEvent({
  type: TIMER_STOPPED_TYPE,
  schema: timerStoppedPayloadSchema,
  target,
  apply() {},
})

/** 计时只在事件读模型里折叠；apply 参与统一增量/全量重放。 */
export const timerEventDefinitions: readonly RegisteredDefinition[] = [
  timerConfiguredDefinition,
  timerStartedDefinition,
  timerStoppedDefinition,
]
