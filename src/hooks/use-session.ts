import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, onUnauthorized, type Role, type User } from '../lib/api-client'
import { hasToken } from '../lib/auth-token'
import { queryKeys } from './query-keys'

export interface SessionApi {
  /** 已登录用户；未登录为 null */
  readonly user: User | null
  /** 正在用令牌向服务端核对会话（启动时的一次） */
  readonly isLoading: boolean
  readonly isAuthenticated: boolean
  /** 当前角色；未登录为 null。路由守卫据此挡下 owner 专属页面 */
  readonly role: Role | null
  readonly isOwner: boolean
}

/**
 * 当前会话（ADR-008 §2：GET /api/auth/me，前端启动时校验）。
 *
 * 三种进入方式都直接写入同一份缓存，不再重复请求：
 *   · 页面加载时本地有令牌 → 发 /api/auth/me 核对；
 *   · 登录 / 注册 / 首启成功 → 响应自带 user，由各 mutation 写入；
 *   · 任意请求收到 401 → api client 清令牌并广播，这里把会话置空。
 */
export function useSession(): SessionApi {
  const queryClient = useQueryClient()

  const query = useQuery<User | null>({
    queryKey: queryKeys.session,
    queryFn: async ({ signal }) => (await api.me(signal)).user,
    // 本地没有令牌就不必问服务端，直接判定未登录（避免无谓的 401）
    enabled: hasToken(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(
    () =>
      onUnauthorized(() => {
        queryClient.setQueryData<User | null>(queryKeys.session, null)
      }),
    [queryClient],
  )

  const user = query.data ?? null

  // 「已登录」= 本地有令牌 **且** 缓存里有账号。两个条件都要：
  // enabled: hasToken() 会让查询在无令牌时停摆，此时缓存里的 user 是上一轮的残留，
  // 只看 user 会把已登出的状态误判成已登录。角色也走同一个闸门，
  // 否则登出后残留的 owner 还会把「邀请码」入口留在导航里。
  const role: Role | null = user === null || !hasToken() ? null : user.role

  return {
    user,
    isLoading: query.isLoading,
    isAuthenticated: role !== null,
    role,
    isOwner: role === 'owner',
  }
}
