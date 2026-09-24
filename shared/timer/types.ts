import type { DayKey } from '@shared/time'

/** 任务级开关；没有配置事件的任务默认关闭。 */
export interface TimerTaskConfig {
  taskId: string
  enabled: boolean
}

/** 同账号至多一条运行中的计时；sessionId 是开始事件的 UUIDv7。 */
export interface TimerActive {
  sessionId: string
  taskId: string
  occurrenceKey: DayKey
  startedAt: string
}

/** 一段已结束的实际用时；休息时间不包含在内。 */
export interface TimerSession extends TimerActive {
  stoppedAt: string
  elapsedSeconds: number
}

export interface TimerSnapshot {
  /** 服务端当前时刻，用于校准客户端运行中的计时显示。 */
  serverNow: string
  active: TimerActive | null
  tasks: TimerTaskConfig[]
  sessions: TimerSession[]
}

export interface StartTimerInput {
  taskId: string
  occurrenceKey: DayKey
}

export interface PauseTimerInput {
  sessionId: string
}
