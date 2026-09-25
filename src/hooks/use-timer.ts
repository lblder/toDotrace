import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import type { PauseTimerInput, StartTimerInput, TimerSnapshot } from '@shared/timer'
import { api } from '../lib/api-client'
import { queryKeys } from './query-keys'

export const TIMER_QUERY_KEY = ['timer', 'snapshot'] as const
const RUNNING_REFETCH_MS = 10_000
const IDLE_REFETCH_MS = 30_000

interface SyncedTimer {
  readonly snapshot: TimerSnapshot
  /** 服务端时间减去浏览器时间；请求往返取中点，避免按响应结束时刻高估偏移。 */
  readonly serverOffsetMs: number
}

async function withServerClock(request: () => Promise<TimerSnapshot>): Promise<SyncedTimer> {
  const sentAt = Date.now()
  const snapshot = await request()
  const receivedAt = Date.now()
  return {
    snapshot,
    serverOffsetMs: Date.parse(snapshot.serverNow) - (sentAt + receivedAt) / 2,
  }
}

type TimerMutation<TInput> = UseMutationResult<SyncedTimer, Error, TInput>

export interface TimerActions {
  readonly start: TimerMutation<StartTimerInput>
  readonly pause: TimerMutation<PauseTimerInput>
  readonly configure: TimerMutation<{ taskId: string; enabled: boolean }>
}

interface TimerContextValue {
  readonly synced: SyncedTimer | null
  readonly isLoading: boolean
  readonly isError: boolean
  readonly error: unknown
  readonly refetch: () => void
  readonly actions: TimerActions
}

const TimerContext = createContext<TimerContextValue | null>(null)

/** 全应用只挂一次，避免每条任务行各自轮询 /api/timer。 */
export function TimerProvider({ children }: { readonly children: ReactNode }) {
  const client = useQueryClient()
  const query = useQuery<SyncedTimer>({
    queryKey: TIMER_QUERY_KEY,
    queryFn: ({ signal }) => withServerClock(() => api.getTimer(signal)),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (current) => current.state.data?.snapshot.active ? RUNNING_REFETCH_MS : IDLE_REFETCH_MS,
    refetchIntervalInBackground: false,
  })
  const { refetch } = query

  // React Query 处理 visibility；额外监听原生 focus 以覆盖切回桌面窗口的情形。
  useEffect(() => {
    const refresh = () => { void refetch() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch])

  function accept(payload: SyncedTimer): void {
    client.setQueryData(TIMER_QUERY_KEY, payload)
    void client.invalidateQueries({ queryKey: queryKeys.trace })
  }
  const start = useMutation<SyncedTimer, Error, StartTimerInput>({
    mutationFn: (input) => withServerClock(() => api.startTimer(input)),
    onError: () => { void client.invalidateQueries({ queryKey: TIMER_QUERY_KEY }) },
    onSuccess: (payload) => {
      accept(payload)
      // 开始计时由后端显式把普通任务标记“进行中”；其他任务视图需立刻重读。
      void client.invalidateQueries({ queryKey: queryKeys.tasks })
      void client.invalidateQueries({ queryKey: ['tasks', 'detail'] })
    },
  })
  const pause = useMutation<SyncedTimer, Error, PauseTimerInput>({
    mutationFn: (input) => withServerClock(() => api.pauseTimer(input)),
    onSuccess: accept,
  })
  const configure = useMutation<SyncedTimer, Error, { taskId: string; enabled: boolean }>({
    mutationFn: ({ taskId, enabled }) => withServerClock(() => api.configureTimer(taskId, enabled)),
    onSuccess: accept,
  })

  const value: TimerContextValue = {
    synced: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => { void refetch() },
    actions: { start, pause, configure },
  }
  return createElement(TimerContext.Provider, { value }, children)
}

function timerContext(): TimerContextValue {
  const value = useContext(TimerContext)
  if (value === null) throw new Error('计时控件需要放在 TimerProvider 内')
  return value
}

export function useTimer() {
  const context = timerContext()
  return {
    snapshot: context.synced?.snapshot ?? null,
    serverOffsetMs: context.synced?.serverOffsetMs ?? 0,
    isLoading: context.isLoading,
    isError: context.isError,
    error: context.error,
    refetch: context.refetch,
  }
}

export function useTimerActions(): TimerActions {
  return timerContext().actions
}

/** 只让真正运行的控件每秒更新；暂停任务的用时是服务端固化的值。 */
export function useTimerClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [running])
  return now
}

/** 配置缺省关闭。开关作用于任务定义，历史时长仍按轮次保留。 */
export function getTimerTaskConfig(snapshot: TimerSnapshot | null, taskId: string): { enabled: boolean; explicit: boolean } {
  const config = snapshot?.tasks.find((item) => item.taskId === taskId)
  return { enabled: config?.enabled ?? false, explicit: config !== undefined }
}

export function timerElapsedSeconds(
  snapshot: TimerSnapshot | null,
  taskId: string,
  occurrenceKey: string,
  serverNowMs: number,
): number {
  if (snapshot === null) return 0
  let total = 0
  for (const session of snapshot.sessions) {
    if (session.taskId === taskId && session.occurrenceKey === occurrenceKey) {
      total += Math.max(0, session.elapsedSeconds)
    }
  }
  const active = snapshot.active
  if (active?.taskId === taskId && active.occurrenceKey === occurrenceKey) {
    total += Math.max(0, Math.floor((serverNowMs - Date.parse(active.startedAt)) / 1_000))
  }
  return total
}

export function timerHasRecord(snapshot: TimerSnapshot | null, taskId: string, occurrenceKey: string): boolean {
  return (snapshot?.active?.taskId === taskId && snapshot.active.occurrenceKey === occurrenceKey)
    || (snapshot?.sessions.some((item) => item.taskId === taskId && item.occurrenceKey === occurrenceKey) === true)
}
