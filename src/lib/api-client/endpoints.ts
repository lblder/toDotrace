/**
 * 服务端入口 —— 一一对应 ADR-008 §2 的路由清单。
 *
 * ADR-008 的约束：**本 ADR 未列出的路由不得实现**（避免范围蔓延）。
 * 阶段 1 用到的就是这八条：六条账号路由，加 owner 管理面的邀请码两条；
 * `GET /api/members` 只为把邀请码的「被谁使用」翻成可读的名字。
 */

import { request } from './client'
import type {
  AuthPayload,
  CreateInvitePayload,
  CreateOwnerInput,
  InviteListPayload,
  IssueInviteInput,
  LoginInput,
  MemberListPayload,
  MePayload,
  RegisterInput,
  SetupStatus,
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
} as const

export type Api = typeof api
