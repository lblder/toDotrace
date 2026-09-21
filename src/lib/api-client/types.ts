/**
 * 服务端契约类型 —— **逐条对照 ADR-008**，不假设未列出的字段。
 *
 * ADR-008 的后果一节写得很明确：
 *   「`src/` 据此写 api client 与 hooks，**不得**假设本 ADR 未列出的字段存在」
 * 因此这里没有 `passwordHash` 一类东西——`user` 对象就只有 ADR-008 §2
 * 列出的四个字段。
 *
 * 邀请码与成员列表是 ADR-008 §2 路由表里明列的 owner 专属资源，
 * 字段照 §2 与 §8 补遗抄录：**列表接口不返回明文 code**（只在签发响应里出现一次）。
 */

export type Role = 'owner' | 'member'

/** ADR-008 §2：登录 / 注册 / me 三处形态一致 */
export interface User {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
}

/** POST /api/setup/owner、/api/auth/login、/api/auth/register 的响应 */
export interface AuthPayload {
  readonly user: User
  readonly token: string
}

/** GET /api/setup/status */
export interface SetupStatus {
  readonly needsOwner: boolean
}

/** GET /api/auth/me */
export interface MePayload {
  readonly user: User
}

/** ADR-008 §1：错误信封的唯一形态 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

/** POST /api/setup/owner 的请求体 */
export interface CreateOwnerInput {
  readonly username: string
  readonly password: string
  readonly displayName: string
}

/** POST /api/auth/login 的请求体 */
export interface LoginInput {
  readonly username: string
  readonly password: string
}

/** POST /api/auth/register 的请求体 */
export interface RegisterInput {
  readonly username: string
  readonly password: string
  readonly displayName: string
  readonly inviteCode: string
}

/* -------------------------------------------------------------------------
   owner 专属：邀请码与成员（ADR-008 §2）
   ------------------------------------------------------------------------- */

/** POST /api/invites 的响应体。**明文 code 只在这里出现一次**，此后无法再取回。 */
export interface IssuedInvite {
  readonly id: string
  readonly code: string
  readonly expiresAt: string
}

/** POST /api/invites 的请求体；不传 expiresInDays 即服务端默认 7 天（§8 补遗） */
export interface IssueInviteInput {
  readonly expiresInDays?: number
}

export interface CreateInvitePayload {
  readonly invite: IssuedInvite
}

/** GET /api/invites 的列表项 —— 注意**没有** code 字段 */
export interface InviteSummary {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly usedBy: string | null
  readonly usedAt: string | null
}

export interface InviteListPayload {
  readonly invites: readonly InviteSummary[]
}

/** GET /api/members 的列表项：只有身份与活跃时间，不含任何成员的数据内容 */
export interface MemberSummary {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
  readonly createdAt: string
  readonly lastSeenAt: string | null
}

export interface MemberListPayload {
  readonly members: readonly MemberSummary[]
}
