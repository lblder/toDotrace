/**
 * 服务端入口 —— 一一对应 ADR-008 §2 的路由清单。
 *
 * ADR-008 的约束：**本 ADR 未列出的路由不得实现**（避免范围蔓延）。
 * 阶段 1 用到的就是这八条：六条账号路由，加 owner 管理面的邀请码两条；
 * `GET /api/members` 只为把邀请码的「被谁使用」翻成可读的名字。
 * 阶段 3 加了 ADR-012 §3 的打卡三条（见文件末尾）。
 */

import { request } from './client'
import type {
  AuthPayload,
  CheckinResult,
  CreateInvitePayload,
  CreateOwnerInput,
  InviteListPayload,
  IssueInviteInput,
  LoginInput,
  MemberListPayload,
  MePayload,
  RegisterInput,
  SetupStatus,
  TodayCheckin,
} from './types'

export const api = {
  /** GET /api/setup/status —— 无鉴权，前端据此决定是否进首启引导 */
  getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    return request<SetupStatus>({
      method: 'GET',
      path: '/api/setup/status',
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** POST /api/setup/owner —— 仅在无 owner 时可用；已有 owner 时 409 */
  createOwner(input: CreateOwnerInput): Promise<AuthPayload> {
    return request<AuthPayload>({ method: 'POST', path: '/api/setup/owner', body: input })
  },

  /** POST /api/auth/login */
  login(input: LoginInput): Promise<AuthPayload> {
    return request<AuthPayload>({ method: 'POST', path: '/api/auth/login', body: input })
  },

  /** POST /api/auth/logout —— 需要令牌，作废当前令牌，204 无响应体 */
  logout(): Promise<void> {
    return request<void>({ method: 'POST', path: '/api/auth/logout', auth: true })
  },

  /** GET /api/auth/me —— 需要令牌，前端启动时校验会话 */
  me(signal?: AbortSignal): Promise<MePayload> {
    return request<MePayload>({
      method: 'GET',
      path: '/api/auth/me',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** POST /api/auth/register —— 无鉴权，凭邀请码 */
  register(input: RegisterInput): Promise<AuthPayload> {
    return request<AuthPayload>({ method: 'POST', path: '/api/auth/register', body: input })
  },

  /* ---------------------------------------------------------------------
     owner 专属（ADR-008 §2）：服务端对非 owner 一律 403，前端据此做显隐
     --------------------------------------------------------------------- */

  /**
   * POST /api/invites —— 签发邀请码。
   * 响应里的 `invite.code` 是**明文唯一一次出现**；列表接口不会再有它。
   */
  createInvite(input: IssueInviteInput): Promise<CreateInvitePayload> {
    return request<CreateInvitePayload>({
      method: 'POST',
      path: '/api/invites',
      body: input,
      auth: true,
    })
  },

  /** GET /api/invites —— 本账号签发过的邀请码元信息（不含 code） */
  listInvites(signal?: AbortSignal): Promise<InviteListPayload> {
    return request<InviteListPayload>({
      method: 'GET',
      path: '/api/invites',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** GET /api/members —— 只为把 usedBy 的 uuid 翻成显示名 */
  listMembers(signal?: AbortSignal): Promise<MemberListPayload> {
    return request<MemberListPayload>({
      method: 'GET',
      path: '/api/members',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /* ---------------------------------------------------------------------
     打卡（ADR-012 §3）—— 全部需鉴权，响应只含本账号的数据
     --------------------------------------------------------------------- */

  /**
   * POST /api/checkin/arrive —— 记录「今日到达」。
   *
   * **不带请求体**（§3：两个 POST 都不接受请求体）。发生时刻由服务端取 `now`、
   * 归属日由 `shared/time` 折算——客户端指定时刻等于开放「补记任意历史打卡」，
   * 01 FR1 没有要求这个能力，所以客户端这边连表达它的方式都不留。
   */
  arriveCheckin(): Promise<CheckinResult> {
    return request<CheckinResult>({ method: 'POST', path: '/api/checkin/arrive', auth: true })
  },

  /**
   * POST /api/checkin/leave —— 闭合最近一次到达（同样不带请求体）。
   *
   * 分流键是「**有无到达**」而不是「有无未闭合的到达」（ADR-012 §5，v1.2 的裁决）：
   *   · 账户从无到达 → `409 conflict/not-arrived`（没有可配对的到达，也就无从知道记哪一天）；
   *   · 最近那条到达已闭合 → **200，`created: false`，返回该行**——重复点击与网络重试
   *     都走幂等而不是报错，界面据此如实说出第一次记录的时刻。
   * 这两种情形在投影上本是同一个状态，只有换掉分流键才能让幂等与 409 同时成立。
   */
  leaveCheckin(): Promise<CheckinResult> {
    return request<CheckinResult>({ method: 'POST', path: '/api/checkin/leave', auth: true })
  },

  /**
   * GET /api/checkin/today —— 今日状态与连续天数。
   *
   * `streak` 由服务端按 `shared/checkin` 的口径算好（ADR-012 §6），
   * 前端**不再自己算一遍**：同一个数字两个实现就是两个真相，
   * 而 §5 删掉 `isRestDay` 字段正是为了这个理由。
   */
  getTodayCheckin(signal?: AbortSignal): Promise<TodayCheckin> {
    return request<TodayCheckin>({
      method: 'GET',
      path: '/api/checkin/today',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /*
   * ADR-012 §3 的第四条 `GET /api/checkin/days?from=&to=` 本阶段不在此实现：
   * 它服务的用例（范围统计、热力图）分别属阶段 6 与后续阶段，而本阶段界面
   * 只用得到 /today。契约里 `from`/`to` 均必填、返回升序这类约定是服务端
   * 必须满足的，不是「客户端先备着」的理由——留到真正调用它的那一阶段再加。
   */
} as const

export type Api = typeof api
