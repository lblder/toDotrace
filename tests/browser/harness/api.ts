import { expect } from '@playwright/test'
import type { Stack } from './stack'

/**
 * 直接打 API 的小工具。
 *
 * 用途是**把界面推到某个状态**（建 owner、发码、注册成员），
 * 从而让浏览器端的用例只测它真正关心的那一段。断言优先走界面；
 * 这里只负责把前置条件铺好，以及为错误分流用例制造真实的失败响应。
 *
 * 契约见 ADR-008 §1：`/api` 前缀、Bearer 令牌、错误信封 { error: { code, message } }。
 */

export interface User {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: 'owner' | 'member'
}

export interface AuthPayload {
  readonly user: User
  readonly token: string
}

export interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

/** 发一个请求并原样返回状态码与解析后的响应体，**不因状态码抛错**。 */
export async function call<T>(
  stack: Stack,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`

  const response = await fetch(`${stack.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

  const text = await response.text()
  const body = text.length === 0 ? undefined : (JSON.parse(text) as T)
  return { status: response.status, body: body as T }
}

/** 同上，但要求 2xx——前置条件铺错时立刻失败，而不是让后面的界面断言报出怪错。 */
async function ok<T>(
  stack: Stack,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const { status, body } = await call<T>(stack, path, options)
  expect(status, `${options.method ?? 'GET'} ${path} 应当成功`).toBe(200)
  return body
}

export function getSetupStatus(stack: Stack): Promise<{ needsOwner: boolean }> {
  return ok<{ needsOwner: boolean }>(stack, '/api/setup/status')
}

export function createOwner(
  stack: Stack,
  input: { username: string; displayName: string; password: string },
): Promise<AuthPayload> {
  return ok<AuthPayload>(stack, '/api/setup/owner', { method: 'POST', body: input })
}

export function login(
  stack: Stack,
  input: { username: string; password: string },
): Promise<AuthPayload> {
  return ok<AuthPayload>(stack, '/api/auth/login', { method: 'POST', body: input })
}

export function register(
  stack: Stack,
  input: { inviteCode: string; username: string; displayName: string; password: string },
): Promise<AuthPayload> {
  return ok<AuthPayload>(stack, '/api/auth/register', { method: 'POST', body: input })
}

export function issueInvite(
  stack: Stack,
  token: string,
  expiresInDays?: number,
): Promise<{ invite: { id: string; code: string; expiresAt: string } }> {
  return ok(stack, '/api/invites', {
    method: 'POST',
    token,
    body: expiresInDays === undefined ? {} : { expiresInDays },
  })
}

export function logout(stack: Stack, token: string): Promise<void> {
  return ok<void>(stack, '/api/auth/logout', { method: 'POST', token })
}

/* ---------------------------------------------------------------------------
   预置账号：名字固定，失败时日志里能一眼看出是谁
   --------------------------------------------------------------------------- */

export interface Account {
  readonly username: string
  readonly displayName: string
  readonly password: string
}

export const OWNER: Account = {
  username: 'owner_alpha',
  displayName: '首席记录员',
  password: 'owner-pass-1234',
}

export const MEMBER: Account = {
  username: 'member_beta',
  displayName: '实验员乙',
  password: 'member-pass-1234',
}

/**
 * 建好 owner 并返回令牌。
 * 前置：库里还没有 owner（每个测试文件一套空库，所以这条总是成立）。
 */
export async function seedOwner(stack: Stack): Promise<AuthPayload> {
  return createOwner(stack, OWNER)
}

/**
 * owner 已就位后的第二名成员：签发邀请码 → 凭码注册。
 * 返回成员令牌与那枚邀请码（码只在这一步拿得到）。
 */
export async function seedMember(
  stack: Stack,
  ownerToken: string,
  account: Account = MEMBER,
): Promise<{ member: AuthPayload; inviteCode: string }> {
  const issued = await issueInvite(stack, ownerToken, 7)
  const member = await register(stack, {
    inviteCode: issued.invite.code,
    username: account.username,
    displayName: account.displayName,
    password: account.password,
  })
  return { member, inviteCode: issued.invite.code }
}
