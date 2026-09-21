/**
 * 登录防爆破：同一用户名连续失败 5 次 → 锁定 15 分钟（ADR-008 §5）。
 *
 * 单进程内存计数即可（架构文档 §3.2 明示）。进程重启计数清零——
 * 对本项目的威胁模型（本机/局域网个人工具）是可接受的取舍。
 */

export interface ThrottleState {
  failures: number
  lockedUntilMs: number | null
}

export interface LoginThrottleOptions {
  maxFailures: number
  lockMs: number
}

export class LoginThrottle {
  private readonly attempts = new Map<string, ThrottleState>()
  private readonly maxFailures: number
  private readonly lockMs: number

  constructor(options: LoginThrottleOptions) {
    this.maxFailures = options.maxFailures
    this.lockMs = options.lockMs
  }

  /**
   * 计数键：用户名 trim 后**原样**（保持大小写，ADR-008 §8 补遗 3）。
   *
   * 不能转小写：登录查询是大小写敏感的，`Alice` 与 `alice` 是两个可共存的账号，
   * 合并成一个桶会让「对 Alice 故意失败 5 次」连带锁死 alice。
   * 而转小写本要防的「换大小写绕过锁定」在大小写敏感的账号模型下不成立——
   * 换个大小写就是在打另一个账号。
   */
  private key(username: string): string {
    return username.trim()
  }

  /** 锁定中返回剩余毫秒数；未锁定返回 null（并顺带清掉已过期的锁）。 */
  lockedForMs(username: string, nowMs: number = Date.now()): number | null {
    const state = this.attempts.get(this.key(username))
    if (!state || state.lockedUntilMs === null) return null
    if (state.lockedUntilMs <= nowMs) {
      this.attempts.delete(this.key(username))
      return null
    }
    return state.lockedUntilMs - nowMs
  }

  /** 记一次失败；达到阈值即上锁。返回是否因此次失败而锁定。 */
  recordFailure(username: string, nowMs: number = Date.now()): boolean {
    const key = this.key(username)
    const state = this.attempts.get(key) ?? { failures: 0, lockedUntilMs: null }
    state.failures += 1
    if (state.failures >= this.maxFailures) {
      state.lockedUntilMs = nowMs + this.lockMs
    }
    this.attempts.set(key, state)
    return state.lockedUntilMs !== null
  }

  /** 成功登录后清零（ADR-008 §5：锁定解除）。 */
  recordSuccess(username: string): void {
    this.attempts.delete(this.key(username))
  }

  /** 仅供测试与运维观察。 */
  peek(username: string): ThrottleState | undefined {
    return this.attempts.get(this.key(username))
  }
}
