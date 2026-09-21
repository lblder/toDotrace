/**
 * 主题：可切换、可持久化，初始跟随系统偏好（需求文档 §4）。
 *
 * 实现要点：
 *  - 只改 `document.documentElement.dataset.theme`，色值全部由 tokens.css 里
 *    `[data-theme="dark"]` / `[data-theme="light"]` 两份定义给出——
 *    JS 里不出现任何颜色（架构文档 §6 / 开发文档 §7）；
 *  - 属性在 main.tsx 渲染前落好，首帧不白闪；
 *  - 系统偏好变化只在「未显式选择过」时生效。
 */

export type ThemePreference = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

export interface ThemeState {
  readonly preference: ThemePreference
  readonly resolved: ResolvedTheme
}

/**
 * 存储键的运行期来源按优先级只有一条规则：
 *
 *  1. `<html data-theme-key>` —— 由 `public/theme-init.js` 在首帧之前写入。
 *     **脚本在场时以脚本为准**：那个文件是 classic script（CSP 不允许内联脚本），
 *     不能 import 本模块，所以键的字面量放在它那里、由它宣告出来。
 *     两边因此不可能各说各话——DOM 赢，没有第二种可能。
 *  2. 脚本缺席时的兜底常量。它不与脚本"并行维护"：
 *     脚本一旦在场就完全被忽略，只用于 `<script>` 被删掉/被拦下的情况，
 *     免得主题持久化整个失效。
 *
 * 兜底值与脚本里的键必须一致——这条不靠人盯，由测试核对
 * （/tmp/ta-check/theme.mts 的「0. 存储键单一来源」一节直接读脚本源码比对）。
 */
const FALLBACK_STORAGE_KEY = 'todoagent.theme'

function storageKey(): string {
  if (typeof document === 'undefined') return FALLBACK_STORAGE_KEY
  const value = document.documentElement.dataset.themeKey
  return value === undefined || value === '' ? FALLBACK_STORAGE_KEY : value
}

const listeners = new Set<() => void>()

let media: MediaQueryList | null = null

function getMedia(): MediaQueryList | null {
  if (media !== null) return media
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  media = window.matchMedia('(prefers-color-scheme: dark)')
  return media
}

function readPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(storageKey())
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw
  } catch {
    // 存储不可用 → 跟随系统
  }
  return 'system'
}

function writePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(storageKey(), preference)
  } catch {
    // 存不下就只在本次会话内生效
  }
}

function systemPrefersDark(): boolean {
  const mql = getMedia()
  return mql === null ? true : mql.matches
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return preference
}

/**
 * 快照必须是稳定引用，否则 useSyncExternalStore 会无限重渲染。
 * 因此只在取值真的变化时才换对象。
 */
let state: ThemeState = { preference: 'system', resolved: 'dark' }

function apply(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  // color-scheme 由 tokens.css 随主题一并声明（原生控件配色），此处只落属性
  document.documentElement.dataset.theme = resolved
}

function refresh(): void {
  const preference = readPreference()
  const resolved = resolve(preference)
  if (preference === state.preference && resolved === state.resolved) return
  state = { preference, resolved }
  apply(resolved)
  for (const listener of listeners) listener()
}

/** 在 React 挂载前调用一次：落属性、订阅系统偏好。 */
export function initTheme(): void {
  const preference = readPreference()
  state = { preference, resolved: resolve(preference) }
  apply(state.resolved)

  const mql = getMedia()
  if (mql !== null) {
    mql.addEventListener('change', refresh)
  }
  if (typeof window !== 'undefined') {
    // 多标签页之间同步：另一个标签改了主题，这边跟上
    window.addEventListener('storage', refresh)
  }
}

/** 显式选择主题并持久化。选过之后系统偏好不再覆盖它。 */
export function setTheme(theme: ResolvedTheme): void {
  writePreference(theme)
  refresh()
}

export function getThemeState(): ThemeState {
  return state
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
