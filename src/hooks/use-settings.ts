import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type { DayNotePayload, SettingsPayload, UpdateSettingsInput } from '../lib/api-client'
import { queryKeys } from './query-keys'

/**
 * 账号设置（ADR-017 §1.5 / §7）：时区与 `dayStartHour`。
 *
 * ⚠️ **`affectsFrom` 必须显示给用户**（ADR-017 §7）：改 `dayStartHour` **只影响此后写入的
 * 事件**，历史事件的 `day_key` 已固化、永不重算（ADR-001 §4）。界面拿 `affectsFrom`
 * 渲染出具体日期（「此设置自 9月22日 起生效」），比一句抽象的「不影响历史」
 * 更能让用户相信自己没看错。
 *
 * **不提供「重算历史」的选项**——FR1 已裁决不追溯，提供选项等于把它变成一个
 * 可以搞坏数据的开关。
 */
export function useSettings() {
  const result = useQuery<SettingsPayload>({
    queryKey: queryKeys.settings,
    queryFn: async ({ signal }) => api.getSettings(signal),
    retry: false,
    // 日界与「今天」直接相关：这里也走 ADR-017 §10 的节奏
    staleTime: 5 * 60 * 1000,
  })
  return {
    settings: result.data ?? null,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
  }
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()
  return useMutation<SettingsPayload, Error, UpdateSettingsInput>({
    mutationFn: (input) => api.patchSettings(input),
    onSuccess: (payload) => {
      // 响应就是权威的新值，直接落缓存；再作废任务列表——归属日可能已经变了
      queryClient.setQueryData(queryKeys.settings, payload)
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
    },
  })
}

/**
 * 某一天的备注（ADR-017 §1.4 / §6）。
 *
 * **无到达也可以备注**（§6 的裁决）：FR1 有「休息日」，而人恰恰在没去实验室的日子
 * 才更需要写一句。故这里**不看打卡状态**，只按 `dayKey` 读写。
 * 空串即清除——不引入 `null`（能用一个值表示的状态不要用两个，ADR-013 §6）。
 */
export function useDayNote(dayKey: string | null) {
  const result = useQuery<DayNotePayload>({
    queryKey: queryKeys.dayNote(dayKey ?? ''),
    queryFn: async ({ signal }) => api.getDayNote(dayKey ?? '', signal),
    enabled: dayKey !== null,
    retry: false,
  })
  return {
    note: result.data?.text ?? '',
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
  }
}

export function useSaveDayNote() {
  const queryClient = useQueryClient()
  return useMutation<DayNotePayload, Error, { dayKey: string; text: string }>({
    mutationFn: ({ dayKey, text }) => api.putDayNote(dayKey, text),
    onSuccess: (payload) => {
      queryClient.setQueryData(queryKeys.dayNote(payload.dayKey), payload)
    },
  })
}
