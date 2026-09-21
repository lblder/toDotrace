/** React Query 的键集中在此，避免各处拼字符串导致失效范围对不上。 */

export const queryKeys = {
  /** 首启状态：是否需要创建 owner */
  setupStatus: ['setup', 'status'] as const,
  /** 当前会话：GET /api/auth/me 的结果，或登录/注册/首启成功后直接写入 */
  session: ['auth', 'session'] as const,
  /** 本账号签发过的邀请码（owner 专属，不含明文 code） */
  invites: ['invites', 'list'] as const,
  /** 成员列表（owner 专属，只为把邀请码的 usedBy 翻成显示名） */
  members: ['members', 'list'] as const,
} as const
