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
   打卡（ADR-012 §3）—— 两个 POST **不带请求体**
   --------------------------------------------------------------------------- */

export interface DayRow {
  readonly dayKey: string
  readonly arrivedAt: string
  readonly leftAt: string | null
}

export interface CheckinResult {
  readonly day: DayRow
  readonly created: boolean
}

/** POST /api/checkin/arrive —— 不带 body（服务端取 now 并折算归属日） */
export function arriveCheckin(stack: Stack, token: string): Promise<CheckinResult> {
  return ok<CheckinResult>(stack, '/api/checkin/arrive', { method: 'POST', token })
}

/** POST /api/checkin/leave */
export function leaveCheckin(stack: Stack, token: string): Promise<CheckinResult> {
  return ok<CheckinResult>(stack, '/api/checkin/leave', { method: 'POST', token })
}

export function todayCheckin(
  stack: Stack,
  token: string,
): Promise<{ day: DayRow | null; streak: number }> {
  return ok(stack, '/api/checkin/today', { token })
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

/* ---------------------------------------------------------------------------
   任务（ADR-017 §1.1 / §1.2）

   用途与上面那段一样：**把界面推到某个状态**（建一条带步骤的任务、
   造一条落在项目区间外的任务），从而让浏览器端的用例只测它真正关心的那一段。
   断言仍优先走界面；这里不做「界面应当做的事」。
   --------------------------------------------------------------------------- */

/** `TodoItem` 里本套用例会断言到的字段（其余照服务端原样收着，不重写整份契约） */
export interface TaskItem {
  readonly taskId: string
  readonly occurrenceKey: string
  readonly title: string
  readonly status: 'not_started' | 'in_progress' | 'abandoned'
  readonly completedAt: string | null
  readonly completedDayKey: string | null
  readonly pending: boolean
  readonly recurring: boolean
  readonly overdue: boolean
  readonly plannedDate: string | null
  readonly plannedWeek: string | null
  readonly dueDate: string | null
  readonly projectId: string | null
  readonly tags: readonly string[]
  readonly reasons: readonly string[]
  readonly steps: readonly {
    readonly id: string
    readonly title: string
    readonly checkedAt: string | null
  }[]
}

export interface TaskListPayload {
  /** 服务端回带的今日归属日——**前端不得自己算它**（ADR-015 §6） */
  readonly today: string
  readonly items: readonly TaskItem[]
}

export function listTasks(
  stack: Stack,
  token: string,
  scope: 'today' | 'week' | 'all' = 'today',
): Promise<TaskListPayload> {
  return ok<TaskListPayload>(stack, `/api/tasks?scope=${scope}`, { token })
}

export function listProjectTasks(
  stack: Stack,
  token: string,
  projectId: string,
): Promise<TaskListPayload> {
  return ok<TaskListPayload>(stack, `/api/tasks?scope=project&projectId=${projectId}`, { token })
}

/** 建一条任务。`taskId` 按 ADR-017 §5 由**调用方**生成——这里是夹具，给一个确定的值 */
export function createTask(
  stack: Stack,
  token: string,
  input: {
    taskId: string
    title: string
    plannedDate?: string
    plannedWeek?: string
    dueDate?: string
    projectId?: string
    tags?: readonly string[]
    steps?: readonly { readonly id: string; readonly title: string }[]
  },
): Promise<{ task: { id: string }; created: boolean }> {
  return ok(stack, '/api/tasks', { method: 'POST', token, body: input })
}

export function setTaskStatus(
  stack: Stack,
  token: string,
  taskId: string,
  to: 'not_started' | 'in_progress' | 'abandoned',
): Promise<{ task: { id: string } }> {
  return ok(stack, `/api/tasks/${taskId}/status`, { method: 'POST', token, body: { to } })
}

export function deleteTask(
  stack: Stack,
  token: string,
  taskId: string,
): Promise<{ taskId: string; batchId: string }> {
  return ok(stack, `/api/tasks/${taskId}`, { method: 'DELETE', token })
}

/** 撤销一个批次（ADR-017 §8）——删除与批量顺延各产生一个批次 */
export function undoBatch(
  stack: Stack,
  token: string,
  batchId: string,
): Promise<{ batchId: string; revoked: true }> {
  return ok(stack, '/api/undo', { method: 'POST', token, body: { batchId } })
}

/** 从列表里按标题找一行；找不到就抛错，免得后面的断言报出看不懂的东西 */
export function itemByTitle(payload: TaskListPayload, title: string): TaskItem {
  const found = payload.items.find((item) => item.title === title)
  if (found === undefined) {
    const titles = payload.items.map((item) => item.title).join('、')
    throw new Error(`列表里没有标题为「${title}」的任务。当前有：${titles || '（空）'}`)
  }
  return found
}

/* ---------------------------------------------------------------------------
   项目（ADR-017 §1.3）与设置（§1.5）
   --------------------------------------------------------------------------- */

export function createProject(
  stack: Stack,
  token: string,
  input: { projectId: string; name: string; startsOn: string; endsOn: string },
): Promise<{ project: { id: string } }> {
  return ok(stack, '/api/projects', { method: 'POST', token, body: input })
}

export interface SettingsPayload {
  readonly timeZone: string
  readonly dayStartHour: number
  readonly updatedAt: string
  /** 新设置**开始生效**的归属日（= 该账号当前的 today，ADR-017 §7） */
  readonly affectsFrom: string
}

export function getSettings(stack: Stack, token: string): Promise<SettingsPayload> {
  return ok<SettingsPayload>(stack, '/api/settings', { token })
}

export function patchSettings(
  stack: Stack,
  token: string,
  input: { readonly timeZone?: string; readonly dayStartHour?: number },
): Promise<SettingsPayload> {
  return ok<SettingsPayload>(stack, '/api/settings', { method: 'PATCH', token, body: input })
}
