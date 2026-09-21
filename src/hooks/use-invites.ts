import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type { CreateInvitePayload, InviteSummary, IssueInviteInput, MemberSummary } from '../lib/api-client'
import { queryKeys } from './query-keys'

/**
 * 邀请码列表（GET /api/invites，owner 专属）。
 * 列表里**没有明文 code**——服务端只存 SHA-256，签发时那一次之后就再也拿不到了。
 */
export function useInvites() {
  const query = useQuery<readonly InviteSummary[]>({
    queryKey: queryKeys.invites,
    queryFn: async ({ signal }) => (await api.listInvites(signal)).invites,
    retry: false,
  })

  return {
    invites: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  }
}

/**
 * 签发邀请码（POST /api/invites，owner 专属）。
 *
 * 成功后刷新列表，好让新签发的那条立刻出现在历史里；
 * **明文 code 由调用方就地持有**（只此一次），不进任何缓存——
 * 缓存活得比这次交互久，把明文塞进去等于把它留在了内存里。
 */
export function useCreateInvite() {
  const queryClient = useQueryClient()

  return useMutation<CreateInvitePayload, Error, IssueInviteInput>({
    mutationFn: (input) => api.createInvite(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.invites })
    },
  })
}

/**
 * 成员列表（GET /api/members，owner 专属），只用来把 `usedBy` 的 uuid
 * 翻成可读的显示名——列表接口给的是 id，不是名字。
 * `enabled` 由调用方控制：没有任何已使用的邀请码时不必问服务端。
 */
export function useMembers(enabled: boolean) {
  const query = useQuery<readonly MemberSummary[]>({
    queryKey: queryKeys.members,
    queryFn: async ({ signal }) => (await api.listMembers(signal)).members,
    enabled,
    retry: false,
  })

  const byId = new Map<string, MemberSummary>()
  for (const member of query.data ?? []) byId.set(member.id, member)

  return { memberById: byId }
}
