import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TracePayload, TracePeriod } from '@shared/trace/types'
import { request } from '../lib/api-client/client'
import { queryKeys } from './query-keys'

export interface TraceQueryInput {
  period: TracePeriod
  projectId?: string
  goalMinutes: number
}

/** Trace 缓存以参数为键；窗口回前台时重取服务端 today（跨日边界不由浏览器判断）。 */
export function useTrace(query: TraceQueryInput, enabled = true) {
  const result = useQuery<TracePayload>({
    queryKey: queryKeys.traceView(query.period, query.projectId ?? '', query.goalMinutes),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ period: query.period, goalMinutes: String(query.goalMinutes) })
      if (query.projectId !== undefined) params.set('projectId', query.projectId)
      return request<TracePayload>({ method: 'GET', path: `/api/trace?${params}`, auth: true, signal })
    },
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  })
  const refetchRef = useRef(result.refetch)
  refetchRef.current = result.refetch
  useEffect(() => {
    const onFocus = () => { void refetchRef.current() }
    const onVisible = () => { if (document.visibilityState === 'visible') void refetchRef.current() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return { ...result, refetch: () => { void result.refetch() } }
}
