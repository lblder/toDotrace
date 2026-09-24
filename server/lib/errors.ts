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
  | 'conflict/not-arrived'
  // ── 阶段 4 新增的六个（ADR-017 §2）——**全部沿用既有状态码语义**（409 冲突）。
  // 它们的判据各有唯一一份实现：前五个取自 `shared/tasks/state.ts` 的裁决
  //（ADR-013 §后果 明令「前端据此禁用非法按钮，服务端据同一份判据产出 409」），
  // 第六个（`batch-not-revocable`）取自 ADR-006 的批次语义。
  /** 完成一个**已放弃或已删除**的任务（ADR-013 §2） */
  | 'conflict/task-not-completable'
  /** 重复完成同一实例（未先取消）（ADR-013 §4.6） */
  | 'conflict/occurrence-already-completed'
  /** 取消一个**本就未完成**的实例（ADR-013 §4.7） */
  | 'conflict/occurrence-not-completed'
  | 'conflict/timer-running'
  | 'conflict/timer-disabled'
  /** 对**重复任务**调 `/reschedule`（ADR-013 §3.2） */
  | 'conflict/date-driven-by-rule'
  /** 非法状态迁移（如重复任务转「进行中」，ADR-013 §2） */
  | 'conflict/status-transition'
  /** 撤销一个不存在、属他人、**或本身就是撤销事件**的批次（ADR-006 / ADR-017 §8） */
  | 'conflict/batch-not-revocable'
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

/**
 * **账户从无到达**却要记录离开（ADR-012 §3 失败路径表 / §5 分流表，
 * 码已登记进 ADR-008 §8 错误码清单）。
 *
 * 它是**状态约束**而非「此操作被禁止」：离开必须配对一次到达，
 * 没有可配对的到达时服务端无法知道该把这次离开记在哪一天
 * （归属日取自所配对的到达，§5）——凭空记一天就是伪造事实。
 *
 * 分流键是「**有无到达**」而不是「有无未闭合的到达」：已经有到达、只是已闭合，
 * 那是重试/重复点击，走幂等（`created: false`），**不报这个错**。
 */
export const notArrived = (): ApiError =>
  new ApiError(409, 'conflict/not-arrived', '当前账号还没有任何到达记录，无法记录离开')

/**
 * 阶段 4 的五个 409（ADR-017 §2）——**文案一律由 `shared/tasks/state.ts` 的裁决给出**
 * （`TaskActionVerdict.message`），不在这里另写一句。
 *
 * 为什么把文案做成入参而不是常量：判据与理由是同一件事的两半，判据在 `shared/`
 * 只有一份，文案自然也该跟着它走——两处各写一份的后果是「界面禁用按钮时说的是 A、
 * 服务端 409 说的是 B」，而用户看到的是 B，于是他不知道界面为什么禁用。
 */
export const taskNotCompletable = (message: string): ApiError =>
  new ApiError(409, 'conflict/task-not-completable', message)

export const occurrenceAlreadyCompleted = (message: string): ApiError =>
  new ApiError(409, 'conflict/occurrence-already-completed', message)

export const occurrenceNotCompleted = (message: string): ApiError =>
  new ApiError(409, 'conflict/occurrence-not-completed', message)

export const dateDrivenByRule = (message: string): ApiError =>
  new ApiError(409, 'conflict/date-driven-by-rule', message)

export const statusTransition = (message: string): ApiError =>
  new ApiError(409, 'conflict/status-transition', message)

/**
 * 撤销一个**不可撤销**的批次（ADR-017 §2 / §8）。
 *
 * 触发它的只有一种情形——**批次本身包含 `system/revoke` 事件**：
 * 「撤销撤销」的语义是「让它复活」，而 ADR-006 未定义它，**不允许凭直觉实现**。
 *
 * ⚠️ 「批次不存在」与「批次属于他人」**不走这个码，也不在这里**：两者在投影上
 * 完全同形（批次只是事件行的列，没有独立的表），区分它们就是泄露存在性。
 * 服务层对两者一律 `404 not-found`（ADR-017 §8）。
 */
export const batchNotRevocable = (message: string): ApiError =>
  new ApiError(409, 'conflict/batch-not-revocable', message)

/** 邀请码不存在 / 已过期：400（语义非法），不区分两者以免成为探测手段。 */
export const inviteInvalid = (message = '邀请码无效或已过期'): ApiError =>
  new ApiError(400, 'invite/invalid', message)

export const internalError = (): ApiError =>
  new ApiError(500, 'server/internal-error', '服务器内部错误')
