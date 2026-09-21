import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type { LoginInput, RegisterInput, User } from '../lib/api-client'
import { clearToken, writeToken } from '../lib/auth-token'
import { queryKeys } from './query-keys'

/** 登录：POST /api/auth/login（ADR-008 §2） */
export function useLogin() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: LoginInput) => api.login(input),
    onSuccess: (payload) => {
      writeToken(payload.token)
      queryClient.setQueryData<User>(queryKeys.session, payload.user)
    },
  })
}

/**
 * 注册：POST /api/auth/register（凭邀请码，无鉴权）。
 * 与登录一样，成功即持令牌进入。
 */
export function useRegister() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: RegisterInput) => api.register(input),
    onSuccess: (payload) => {
      writeToken(payload.token)
      queryClient.setQueryData<User>(queryKeys.session, payload.user)
    },
  })
}

/**
 * 登出：POST /api/auth/logout（需要令牌，204）。
 *
 * 服务端无论成功与否，本地一律清令牌并清空缓存——缓存里是上一个账号的数据，
 * 多账号场景下必须清干净（02 §3.2 隔离原则：A 在任何入口拿不到 B 的数据）。
 * 首启状态是公开信息、与账号无关，保留它的缓存以免退出时白屏一下。
 *
 * **顺序要紧**（真实浏览器里复现过）：先 setQueryData 把会话置空，再 removeQueries。
 * 反过来写的话，removeQueries 会把 session 这个 query 连同它的观察者一起销毁，
 * 之后 setQueryData 建的是一个**没人订阅**的新 query——于是没有任何东西通知
 * App 重算路由，登出后界面就永远停在「正在载入账号」上，只剩刷新一条路。
 */
export function useLogout() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      clearToken()
      // 先置空会话：此刻观察者还挂在 session 上，能立刻收到通知
      queryClient.setQueryData<User | null>(queryKeys.session, null)
      // 再清其余缓存；setup（公开信息）与 session（刚置空）保留
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey[0] !== 'setup' && query.queryKey[0] !== 'session',
      })
    },
  })
}
