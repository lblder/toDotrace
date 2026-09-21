/**
 * 请求封装 —— 带令牌、同源、JSON。
 *
 * 对照 ADR-008 §1 的通用约定：
 *   · 路由前缀 /api，认证走 `Authorization: Bearer <token>`，不用 Cookie；
 *   · 请求与响应均 application/json; charset=utf-8；204 无响应体；
 *   · 错误信封唯一形态 `{ error: { code, message } }`，
 *     code 稳定可分流，message 直接是面向用户的中文文案。
 *
 * 不假设 ADR-008 未列出的东西：不读 Retry-After、不读自定义响应头、
 * 不猜 429 的剩余时长（信封里没有这个字段）。
 */

import { clearToken, readToken } from '../auth-token'
import type { ErrorEnvelope } from './types'

export type ApiErrorKind =
  | 'network'
  | 'invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'locked'
  | 'server'
  | 'malformed'
  | 'unknown'

export interface ApiErrorInit {
  readonly status: number
  readonly kind: ApiErrorKind
  readonly code: string
  readonly message: string
  readonly cause?: unknown
}

/** 服务端返回的错误。`message` 已是中文用户文案，界面直接显示。 */
export class ApiError extends Error {
  readonly status: number
  readonly kind: ApiErrorKind
  readonly code: string

  constructor(init: ApiErrorInit) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.kind = init.kind
    this.code = init.code
    if (init.cause !== undefined) this.cause = init.cause
  }

  /** 是否需要用户重新登录 */
  get isAuthFailure(): boolean {
    return this.kind === 'unauthorized'
  }
}

/** 把任意抛出物转成可显示的中文文案 */
export function errorMessage(value: unknown): string {
  if (value instanceof ApiError) return value.message
  if (value instanceof Error && value.message.length > 0) return value.message
  return '发生了未知错误，请重试'
}

/* -------------------------------------------------------------------------
   401 广播：令牌被服务端判定无效 / 过期时，会话缓存需要立刻失效
   ------------------------------------------------------------------------- */

type UnauthorizedListener = () => void

const unauthorizedListeners = new Set<UnauthorizedListener>()

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener()
}

/* -------------------------------------------------------------------------
   状态码 → 语义（ADR-008 §1 的状态码表）
   ------------------------------------------------------------------------- */

const KIND_BY_STATUS: Readonly<Record<number, ApiErrorKind>> = {
  400: 'invalid',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  429: 'locked',
}

function kindOf(status: number): ApiErrorKind {
  const known = KIND_BY_STATUS[status]
  if (known !== undefined) return known
  if (status >= 500) return 'server'
  return 'unknown'
}

/** 信封缺失或不可解析时的兜底 code（服务端正常时不会走到） */
const FALLBACK_CODE: Readonly<Record<ApiErrorKind, string>> = {
  network: 'network/unreachable',
  malformed: 'response/malformed',
  invalid: 'request/invalid',
  unauthorized: 'auth/unauthorized',
  forbidden: 'auth/forbidden',
  'not-found': 'resource/not-found',
  conflict: 'resource/conflict',
  locked: 'auth/locked',
  server: 'server/error',
  unknown: 'request/failed',
}

const FALLBACK_MESSAGE: Readonly<Record<ApiErrorKind, string>> = {
  network: '无法连接到服务，请确认后端已启动后重试',
  malformed: '服务返回了无法解析的内容',
  invalid: '请求内容不合法',
  unauthorized: '登录状态已失效，请重新登录',
  forbidden: '当前账号没有权限执行该操作',
  'not-found': '请求的资源不存在',
  conflict: '该操作与现有数据冲突',
  locked: '尝试次数过多，请稍后再试',
  server: '服务内部错误，请稍后重试',
  unknown: '请求失败，请重试',
}

function fallback(kind: ApiErrorKind): { code: string; message: string } {
  return { code: FALLBACK_CODE[kind], message: FALLBACK_MESSAGE[kind] }
}

/* -------------------------------------------------------------------------
   请求核心
   ------------------------------------------------------------------------- */

function readEnvelope(payload: unknown): { code: string; message: string } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const envelope = (payload as Partial<ErrorEnvelope>).error
  if (typeof envelope !== 'object' || envelope === null) return null
  const { code, message } = envelope as { code?: unknown; message?: unknown }
  if (typeof code !== 'string' || typeof message !== 'string') return null
  return { code, message }
}

interface RequestOptions {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
  /** 是否附带 Authorization 头（ADR-008：除首启与登录注册外均需要） */
  readonly auth?: boolean
  readonly signal?: AbortSignal
}

export async function request<T>(options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }

  if (options.auth === true) {
    const token = readToken()
    if (token === null || token.length === 0) {
      // 本地已知没有令牌，不必白跑一趟；语义与 401 一致
      notifyUnauthorized()
      throw new ApiError({
        status: 401,
        kind: 'unauthorized',
        code: 'auth/missing-token',
        message: '尚未登录',
      })
    }
    headers['Authorization'] = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetch(options.path, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // ADR-008 §1：不使用 Cookie，因此显式不携带凭证
      credentials: 'omit',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (options.signal?.aborted === true) throw cause
    const fb = fallback('network')
    throw new ApiError({
      status: 0,
      kind: 'network',
      code: fb.code,
      message: fb.message,
      cause,
    })
  }

  // 204 无响应体（ADR-008：登出）
  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  let payload: unknown = null
  let parseFailed = false
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      parseFailed = true
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      // 令牌无效或已过期：本地立即失效，并通知会话层
      clearToken()
      notifyUnauthorized()
    }
    const kind = kindOf(response.status)
    const envelope = parseFailed ? null : readEnvelope(payload)
    const fb = fallback(kind)
    throw new ApiError({
      status: response.status,
      kind,
      code: envelope?.code ?? fb.code,
      message: envelope?.message ?? fb.message,
    })
  }

  if (payload === null) {
    const fb = fallback('malformed')
    throw new ApiError({
      status: response.status,
      kind: 'malformed',
      code: fb.code,
      message: fb.message,
    })
  }

  return payload as T
}
