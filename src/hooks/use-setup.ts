import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type { CreateOwnerInput, SetupStatus, User } from '../lib/api-client'
import { writeToken } from '../lib/auth-token'
import { queryKeys } from './query-keys'

/**
 * 首启状态：GET /api/setup/status（ADR-008 §2，无鉴权）。
 * 结果在一次进程生命周期内不会自己变（owner 建了就建了），
 * 因此 staleTime 无限；创建成功后由 useCreateOwner 直接改写缓存。
 */
export function useSetupStatus() {
  return useQuery<SetupStatus, Error>({
    queryKey: queryKeys.setupStatus,
    queryFn: ({ signal }) => api.getSetupStatus(signal),
    staleTime: Infinity,
    retry: 1,
  })
}

/** 首启引导：POST /api/setup/owner —— 成功即视为已登录（响应含 token） */
export function useCreateOwner() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateOwnerInput) => api.createOwner(input),
    onSuccess: (payload) => {
      writeToken(payload.token)
      queryClient.setQueryData<User>(queryKeys.session, payload.user)
      queryClient.setQueryData<SetupStatus>(queryKeys.setupStatus, { needsOwner: false })
    },
  })
}
