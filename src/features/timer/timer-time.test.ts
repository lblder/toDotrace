import { describe, expect, it } from 'vitest'
import type { TimerSnapshot } from '@shared/timer'
import { getTimerTaskConfig, timerElapsedSeconds, timerHasRecord } from '../../hooks/use-timer'
import { formatTimerDuration } from './TimerControls'

const taskId = '0198d000-0000-7000-8000-000000000001'
const occurrenceKey = '2026-09-24'

describe('任务实例的真实计时', () => {
  it('只合并当前实例的已停片段和活动片段，暂停空档不补算', () => {
    const snapshot: TimerSnapshot = {
      serverNow: '2026-09-24T09:31:20+08:00',
      active: { sessionId: 's3', taskId, occurrenceKey, startedAt: '2026-09-24T09:31:10+08:00' },
      tasks: [{ taskId, enabled: true }],
      sessions: [
        { sessionId: 's1', taskId, occurrenceKey, startedAt: '2026-09-24T09:00:00+08:00', stoppedAt: '2026-09-24T09:10:00+08:00', elapsedSeconds: 600 },
        { sessionId: 's2', taskId, occurrenceKey, startedAt: '2026-09-24T09:20:00+08:00', stoppedAt: '2026-09-24T09:22:00+08:00', elapsedSeconds: 120 },
        { sessionId: 'other', taskId, occurrenceKey: '2026-09-23', startedAt: '2026-09-23T09:00:00+08:00', stoppedAt: '2026-09-23T09:20:00+08:00', elapsedSeconds: 1_200 },
      ],
    }
    expect(timerElapsedSeconds(snapshot, taskId, occurrenceKey, Date.parse(snapshot.serverNow))).toBe(730)
    expect(timerHasRecord(snapshot, taskId, occurrenceKey)).toBe(true)
    expect(formatTimerDuration(730)).toBe('12:10')
  })

  it('未配置的任务默认关闭，历史片段仍保留并可按小时显示', () => {
    const snapshot: TimerSnapshot = {
      serverNow: '2026-09-24T10:00:00+08:00', active: null, tasks: [],
      sessions: [{ sessionId: 's1', taskId, occurrenceKey, startedAt: '2026-09-24T08:00:00+08:00', stoppedAt: '2026-09-24T09:01:01+08:00', elapsedSeconds: 3_661 }],
    }
    expect(getTimerTaskConfig(snapshot, taskId)).toEqual({ enabled: false, explicit: false })
    expect(timerElapsedSeconds(snapshot, taskId, occurrenceKey, Date.parse(snapshot.serverNow))).toBe(3_661)
    expect(formatTimerDuration(3_661)).toBe('1:01:01')
  })
})
