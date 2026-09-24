import type { Db } from '../db/connection.js'
import { today as accountToday, toIsoInZone, type DayKey } from '@shared/time'
import type { TimerActive, TimerSession, TimerSnapshot, TimerTaskConfig } from '@shared/timer'
import { roundsOf } from '@shared/tasks'
import { appendEvents } from '../events/append.js'
import {
  TIMER_CONFIGURED_TYPE,
  TIMER_STARTED_TYPE,
  TIMER_STOPPED_TYPE,
  type TimerConfiguredPayload,
  type TimerStartedPayload,
  type TimerStoppedPayload,
} from '../events/definitions/timer.js'
import { taskStatusChangedDefinition } from '../events/definitions/tasks.js'
import { readAccountEvents } from '../events/event-store.js'
import { foldedEvents } from '../events/project.js'
import { readTaskRows } from '../events/projection-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import type { Event, EventDraft } from '../events/types.js'
import { conflict, notFound } from '../lib/errors.js'
import { loadTaskSources, occurrenceEventsOf } from '../tasks/sources.js'

interface TimerState {
  active: TimerActive | null
  tasks: TimerTaskConfig[]
  sessions: TimerSession[]
}

function elapsedSeconds(startedAt: string, stoppedAt: string): number {
  return Math.max(0, Math.floor((Date.parse(stoppedAt) - Date.parse(startedAt)) / 1000))
}

/**
 * 统一事件折叠：覆盖锚点和批次撤销先由 foldedEvents 处理。
 * 撤销一条旧停止事件后，后来的开始事件会在其开始时刻隐式收束旧段，
 * 保证重放后仍至多一个 active，且不把两段重叠时间重复计入。
 */
export function foldTimerEvents(events: readonly Event[]): TimerState {
  const configs = new Map<string, boolean>()
  const sessions: TimerSession[] = []
  let active: TimerActive | null = null

  const stopActive = (stoppedAt: string): void => {
    if (active === null) return
    sessions.push({ ...active, stoppedAt, elapsedSeconds: elapsedSeconds(active.startedAt, stoppedAt) })
    active = null
  }

  for (const event of events) {
    if (event.type === TIMER_CONFIGURED_TYPE) {
      const payload = event.payload as TimerConfiguredPayload
      configs.set(payload.taskId, payload.enabled)
    } else if (event.type === TIMER_STARTED_TYPE) {
      const payload = event.payload as TimerStartedPayload
      stopActive(event.occurredAt)
      active = {
        sessionId: event.id,
        taskId: payload.taskId,
        occurrenceKey: payload.occurrenceKey,
        startedAt: event.occurredAt,
      }
    } else if (event.type === TIMER_STOPPED_TYPE) {
      const payload = event.payload as TimerStoppedPayload
      if (active?.sessionId === payload.sessionId && active.taskId === payload.taskId) {
        stopActive(event.occurredAt)
      }
    }
  }

  return {
    active,
    tasks: [...configs].map(([taskId, enabled]) => ({ taskId, enabled })).sort((a, b) =>
      a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    sessions,
  }
}

function stateOf(db: Db, accountId: string): TimerState {
  return foldTimerEvents(foldedEvents(readAccountEvents(db, accountId)))
}

/** 启动命令已校验过的当前运行实例；只接受同账号精确匹配的任务与轮次。 */
export function isActiveTimerOccurrence(
  db: Db,
  accountId: string,
  taskId: string,
  occurrenceKey: DayKey,
): boolean {
  const active = stateOf(db, accountId).active
  return active?.taskId === taskId && active.occurrenceKey === occurrenceKey
}

/** 只从本账号事件读取，运行中的片段跨刷新、日界与浏览器标签页保持。 */
export function timerSnapshot(db: Db, accountId: string, now: Date): TimerSnapshot {
  const settings = loadAccountSettings(db, accountId)
  return { serverNow: toIsoInZone(now, settings.timeZone), ...stateOf(db, accountId) }
}

function taskOf(db: Db, accountId: string, taskId: string) {
  const task = readTaskRows(db, accountId).find((row) => row.id === taskId)
  if (task === undefined || task.deletedAt !== null) throw notFound(`任务不存在（${taskId}）`)
  return task
}

function draftOf<P>(db: Db, accountId: string, now: Date, type: string, payload: P): EventDraft<P> {
  const settings = loadAccountSettings(db, accountId)
  // dayKey 交给 appendEvents 依同一设置折算；归属日只标记动作，不限制计时跨日。
  return { type, payload, occurredAt: toIsoInZone(now, settings.timeZone) }
}

/** 在任务完成、放弃、删除或关闭计时的同一批次中追加。调用方负责事务。 */
export function stopDraftForTask(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  occurrenceKey?: DayKey,
): EventDraft<TimerStoppedPayload> | null {
  const active = stateOf(db, accountId).active
  if (active === null || active.taskId !== taskId) return null
  if (occurrenceKey !== undefined && active.occurrenceKey !== occurrenceKey) return null
  return draftOf(db, accountId, now, TIMER_STOPPED_TYPE, { taskId, sessionId: active.sessionId })
}

export function configureTimer(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  enabled: boolean,
): TimerSnapshot {
  assertInTransaction(db, '配置任务计时')
  taskOf(db, accountId, taskId)
  const state = stateOf(db, accountId)
  const current = state.tasks.find((row) => row.taskId === taskId)?.enabled ?? false
  if (current === enabled) return timerSnapshot(db, accountId, now)

  const stop = enabled ? null : stopDraftForTask(db, accountId, now, taskId)
  appendEvents(db, accountId, [draftOf(db, accountId, now, TIMER_CONFIGURED_TYPE, { taskId, enabled })])
  // 用户以后撤销配置更改时，已结束的实际计时片段仍保持结束。
  if (stop !== null) appendEvents(db, accountId, [stop])
  return timerSnapshot(db, accountId, now)
}

export function startTimer(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  occurrenceKey: DayKey,
): TimerSnapshot {
  assertInTransaction(db, '开始任务计时')
  const task = taskOf(db, accountId, taskId)
  const state = stateOf(db, accountId)
  if (state.active?.taskId === taskId && state.active.occurrenceKey === occurrenceKey) {
    return timerSnapshot(db, accountId, now)
  }
  if (state.active !== null) {
    throw conflict('conflict/timer-running', '当前账号已有任务正在计时，请先暂停')
  }
  if (!(state.tasks.find((row) => row.taskId === taskId)?.enabled ?? false)) {
    throw conflict('conflict/timer-disabled', '请先为这项任务启用番茄计时')
  }

  const settings = loadAccountSettings(db, accountId)
  const today = accountToday(timeContextOf(settings), now)
  const sources = loadTaskSources(db, accountId)
  const round = roundsOf(task, occurrenceEventsOf(sources.events), today)
    .find((row) => row.originalPlannedDate === occurrenceKey)
  if (round === undefined) throw notFound(`实例不存在（任务 ${taskId} 没有原计划日期为 '${occurrenceKey}' 的轮次）`)
  if (task.status === 'abandoned') throw conflict('conflict/task-not-completable', '已放弃的任务不能计时')
  if (round.status === 'completed') {
    throw conflict('conflict/occurrence-already-completed', '已完成的轮次不能计时')
  }

  const drafts: EventDraft[] = []
  if (task.recurrence === null && task.status === 'not_started') {
    drafts.push(draftOf(db, accountId, now, taskStatusChangedDefinition.type, { taskId, to: 'in_progress' }))
  }
  drafts.push(draftOf(db, accountId, now, TIMER_STARTED_TYPE, { taskId, occurrenceKey }))
  appendEvents(db, accountId, drafts)
  return timerSnapshot(db, accountId, now)
}

export function pauseTimer(db: Db, accountId: string, now: Date, sessionId: string): TimerSnapshot {
  assertInTransaction(db, '暂停任务计时')
  const state = stateOf(db, accountId)
  const active = state.active
  if (active?.sessionId === sessionId) {
    appendEvents(db, accountId, [
      draftOf(db, accountId, now, TIMER_STOPPED_TYPE, { taskId: active.taskId, sessionId }),
    ])
  } else if (!state.sessions.some((session) => session.sessionId === sessionId)) {
    throw notFound(`计时片段不存在（${sessionId}）`)
  }
  return timerSnapshot(db, accountId, now)
}
