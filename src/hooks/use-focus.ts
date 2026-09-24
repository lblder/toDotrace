import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { DayKey } from '@shared/time'
import { api } from '../lib/api-client'
import { request } from '../lib/api-client/client'
import { queryKeys } from './query-keys'

export interface FocusItem {
  readonly taskId: string
  readonly occurrenceKey: DayKey
}

export interface FocusPayload {
  readonly dayKey: DayKey
  readonly items: readonly FocusItem[]
}

/** 今日集合包含当天安排、当天到期及手动加入，扣除当天明确移除；日期由服务端返回。 */
export function useTodayFocus() {
  const query = useQuery<FocusPayload>({
    queryKey: queryKeys.focusToday,
    queryFn: ({ signal }) => request<FocusPayload>({ method: 'GET', path: '/api/focus/today', auth: true, signal }),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
  })
  const { refetch } = query
  useEffect(() => {
    const refresh = () => { void refetch() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch])

  return {
    dayKey: query.data?.dayKey ?? null,
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}

export function useFocusActions() {
  const client = useQueryClient()
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: queryKeys.focusToday })
  }
  const add = useMutation<FocusPayload, Error, FocusItem>({
    mutationFn: ({ taskId, occurrenceKey }) => request<FocusPayload>({
      method: 'PUT',
      path: `/api/focus/today/${encodeURIComponent(taskId)}/${encodeURIComponent(occurrenceKey)}`,
      auth: true,
    }),
    onSuccess: (payload) => client.setQueryData(queryKeys.focusToday, payload),
    onSettled: invalidate,
  })
  const remove = useMutation<FocusPayload, Error, FocusItem>({
    mutationFn: ({ taskId, occurrenceKey }) => request<FocusPayload>({
      method: 'DELETE',
      path: `/api/focus/today/${encodeURIComponent(taskId)}/${encodeURIComponent(occurrenceKey)}`,
      auth: true,
    }),
    onSuccess: (payload) => client.setQueryData(queryKeys.focusToday, payload),
    onSettled: invalidate,
  })
  return { add, remove }
}

/** 列表只给重复任务的下一轮；聚焦里选中的已完成轮次需从任务详情读取。 */
export function useFocusedHistory(items: readonly FocusItem[], currentKeys: ReadonlySet<string>) {
  const missing = items.filter((item) => !currentKeys.has(`${item.taskId}:${item.occurrenceKey}`))
  const queries = useQueries({
    queries: missing.map((item) => ({
      queryKey: queryKeys.taskDetail(item.taskId),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.getTask(item.taskId, signal),
      retry: false,
    })),
  })

  return missing.map((item, index) => {
    const query = queries[index]
    const detail = query?.data ?? null
    const round = detail?.occurrences.find((candidate) => candidate.originalPlannedDate === item.occurrenceKey) ?? null
    return {
      item,
      title: detail?.task.title ?? null,
      round,
      isLoading: query?.isLoading ?? true,
      isError: query?.isError ?? false,
      error: query?.error,
    }
  })
}
