/**
 * 统一错误信封（ADR-008 §1）：
 *   { "error": { "code": "...", "message": "..." } }
 * code 为稳定的机器可读串（前端据它分流），message 为面向用户的中文文案。
 *
 * 状态码约定（ADR-008 §1）：
 *   400 请求结构非法 / 语义非法
 *   401 无令牌、令牌无效、令牌过期
 *   403 已认证但角色不足
 *   404 资源不存在，**以及跨账号访问他人资源**
 *   409 冲突（用户名已存在、邀请码已被使用）
 *   429 登录失败次数达阈值
 */

export type ErrorCode =
  | 'validation/invalid-input'
  | 'auth/missing-token'
  | 'auth/invalid-token'
  | 'auth/invalid-credentials'
  | 'auth/forbidden'
  | 'auth/locked'
  | 'conflict/owner-exists'
  | 'conflict/username-taken'
  | 'conflict/invite-used'
  | 'invite/invalid'
  | 'not-found'
  | 'server/internal-error'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode

  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export const invalidInput = (message = '请求参数不合法'): ApiError =>
  new ApiError(400, 'validation/invalid-input', message)

export const missingToken = (): ApiError => new ApiError(401, 'auth/missing-token', '请先登录')

export const invalidToken = (): ApiError =>
  new ApiError(401, 'auth/invalid-token', '登录状态已失效，请重新登录')

export const invalidCredentials = (): ApiError =>
  new ApiError(401, 'auth/invalid-credentials', '用户名或密码不正确')

export const forbidden = (): ApiError => new ApiError(403, 'auth/forbidden', '没有权限执行此操作')

export const locked = (retryAfterSeconds: number): ApiError =>
  new ApiError(429, 'auth/locked', `登录失败次数过多，请 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试`)

/**
 * 跨账号访问与「资源不存在」返回同一个响应（ADR-008 §1）：
 * 403 会泄露「该资源存在但不属于你」，404 让越权探测无法区分两者。
 */
export const notFound = (message = '资源不存在'): ApiError => new ApiError(404, 'not-found', message)

export const conflict = (code: ErrorCode, message: string): ApiError => new ApiError(409, code, message)

/** 邀请码不存在 / 已过期：400（语义非法），不区分两者以免成为探测手段。 */
export const inviteInvalid = (message = '邀请码无效或已过期'): ApiError =>
  new ApiError(400, 'invite/invalid', message)

export const internalError = (): ApiError =>
  new ApiError(500, 'server/internal-error', '服务器内部错误')
