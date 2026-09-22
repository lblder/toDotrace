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

/* -------------------------------------------------------------------------
   打卡（ADR-012 §3）—— 契约只有那四条路由，字段照抄，不假设别的
   ------------------------------------------------------------------------- */

/**
 * 一天的打卡记录（ADR-012 §2 的 `days` 行）。
 *
 * `leftAt` 可空：无离开记录 = 时长未知（01 FR1），界面**不得**替它猜一个值。
 * 每一行都必有 `arrivedAt`——这是 §2 的结构保证，故「无行 ⇔ 无到达」恒成立。
 */
export interface DayRow {
  /** 归属日 'YYYY-MM-DD'，写入时按 `shared/time` 固化；凌晨到达归前一天 */
  readonly dayKey: string
  readonly arrivedAt: string
  readonly leftAt: string | null
}

/**
 * POST /api/checkin/arrive、`/api/checkin/leave` 的响应（ADR-012 §3）。
 *
 * `created: false` 表示**这次请求没有写入新记录**，服务端把既有状态原样返回
 * （幂等语义：重复到达 / 重复离开都不写第二条事件）。界面据此必须说
 * 「你今天 9:12 已经打过卡了」，而不是假装刚打上——`day.arrivedAt` 就是那次
 * 真实到达的时刻，`created: false` 时尤其不能拿当前时间来顶替它。
 */
export interface CheckinResult {
  readonly day: DayRow
  readonly created: boolean
}

/**
 * GET /api/checkin/today。
 *
 * `day === null` ⇔ 今天还没有到达记录 ⇔ 休息日（ADR-012 §5），
 * 界面呈现为「今天偷偷懒」，不计入打卡天数——**不是错误态、不是缺失态**。
 * 响应里没有 `isRestDay` 字段：它完全由 `day === null` 决定（v1.1 删去了这个冗余）。
 */
export interface TodayCheckin {
  readonly day: DayRow | null
  readonly streak: number
}
