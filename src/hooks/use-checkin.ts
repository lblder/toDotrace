import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type { CheckinResult, DayRow, TodayCheckin } from '../lib/api-client'
import { TIMER_QUERY_KEY } from './use-timer'
import { queryKeys } from './query-keys'

export interface CheckinApi {
  /** 今日记录，或跨日尚未结束的最近一次到达。 */
  readonly day: DayRow | null
  /** 连续打卡天数，**由服务端按 shared/checkin 的口径算好**（ADR-012 §6） */
  readonly streak: number
  readonly totalDays: number
  readonly isLoading: boolean
  readonly isError: boolean
  readonly error: unknown
  readonly refetch: () => void
  /** 记录到达；带 `created` 标志，界面据此区分「刚打上」与「早就打过了」 */
  readonly arrive: CheckinMutation
  /** 记录离开（可选动作） */
  readonly leave: CheckinMutation
  readonly away: CheckinMutation
  readonly resume: CheckinMutation
}

/** 打卡动作的 mutation 形态（两个动作完全同形，界面里也对称处理） */
export type CheckinMutation = UseMutationResult<CheckinResult, Error, void>

/**
 * 今日打卡状态（ADR-012 §3：GET /api/checkin/today）。
 *
 * `day === null` 是**正常状态**（休息日），不是缺失也不是错误——
 * 因此这里不把它折算成空对象，`null` 原样交给界面去区分。
 *
 * 打上卡之后不在客户端累加天数：POST 的响应里没有统计值，
 * 编一个出来就是第二个真相。改为让 day 立刻更新（服务端刚返回的就是权威状态），
 * 同时失效重取，把连续与累计天数交给服务端计算。
 */
export function useCheckin(): CheckinApi {
  const queryClient = useQueryClient()

  const query = useQuery<TodayCheckin>({
    queryKey: queryKeys.checkinToday,
    queryFn: async ({ signal }) => api.getTodayCheckin(signal),
    retry: false,
  })

  /**
   * 打卡响应落地：
   *   · `day` 直接写缓存——它是服务端刚算出来的权威状态，不必等第二次往返；
   *   · 统计沿用缓存里的旧值并立即失效重取，不在客户端重复计数。
   * 缓存里还没有数据时什么都不写，让重取去填。
   */
  function applyResult(result: CheckinResult): void {
    const previous = queryClient.getQueryData<TodayCheckin>(queryKeys.checkinToday)
    if (previous !== undefined && previous.activeDay === undefined) {
      queryClient.setQueryData<TodayCheckin>(queryKeys.checkinToday, {
        ...previous,
        day: result.day,
      })
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.checkinToday })
    void queryClient.invalidateQueries({ queryKey: queryKeys.trace })
    void queryClient.invalidateQueries({ queryKey: TIMER_QUERY_KEY })
  }

  const arrive = useMutation<CheckinResult, Error, void>({
    mutationFn: () => api.arriveCheckin(),
    onSuccess: applyResult,
  })

  const leave = useMutation<CheckinResult, Error, void>({
    mutationFn: () => api.leaveCheckin(),
    onSuccess: applyResult,
  })

  const away = useMutation<CheckinResult, Error, void>({
    mutationFn: () => api.awayCheckin(), onSuccess: applyResult,
  })
  const resume = useMutation<CheckinResult, Error, void>({
    mutationFn: () => api.returnCheckin(), onSuccess: applyResult,
  })

  return {
    day: query.data?.activeDay ?? query.data?.day ?? null,
    streak: query.data?.streak ?? 0,
    totalDays: query.data?.totalDays ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch()
    },
    arrive,
    leave,
    away,
    resume,
  }
}
