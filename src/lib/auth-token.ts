/**
 * 会话令牌的本地持有者。
 *
 * ADR-008 §1：认证走 `Authorization: Bearer <token>`，不使用 Cookie。
 * 因此令牌必须由前端保存在某处——这里是**唯一**读写它的模块；
 * 组件不碰存储细节（架构文档 §6 分层），只经 hooks 间接使用。
 *
 * 存储介质是 localStorage：会话令牌是持久的（30 天滑动），
 * 关掉标签页再回来不该要求重新登录。存储不可用时（隐私模式等）
 * 退化为「仅本次会话内存中有效」，不抛错、不阻塞登录。
 */

const STORAGE_KEY = 'todoagent.session.token'

/** 内存副本：避免每次渲染都打 localStorage，也让存储不可用时仍能工作 */
let cached: string | null = null
let loaded = false

function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage !== null
  } catch {
    // 某些浏览器在禁用存储时访问 localStorage 本身就会抛
    return false
  }
}

function load(): string | null {
  if (!canUseStorage()) return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** 读取当前令牌。无令牌返回 null。 */
export function readToken(): string | null {
  if (!loaded) {
    cached = load()
    loaded = true
  }
  return cached
}

export function hasToken(): boolean {
  const token = readToken()
  return token !== null && token.length > 0
}

/** 登录 / 注册 / 首启成功时调用，明文令牌仅在响应中出现这一次。 */
export function writeToken(token: string): void {
  cached = token
  loaded = true
  if (canUseStorage()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, token)
    } catch {
      // 存不下就只在内存里有效，不影响本次使用
    }
  }
}

/** 登出、或收到 401 时调用。 */
export function clearToken(): void {
  cached = null
  loaded = true
  if (canUseStorage()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 忽略
    }
  }
}
