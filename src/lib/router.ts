/**
 * hash 路由（架构文档 §6）：可深链、可后退；**路由名走白名单匹配，
 * 原始 hash 不进 DOM**。
 *
 * 「不进 DOM」的落实方式：本模块对外只暴露 `RouteName` 这个联合类型，
 * 读到的 hash 先经过字符集白名单正则、再经路径→路由名的查表；
 * 命中不了就落到默认路由。任何组件拿到的都是枚举值，
 * 不存在把用户可控字符串渲染出去的路径（也就没有 XSS / 文案注入面）。
 */

export const ROUTE_NAMES = [
  'home',
  'checkin',
  'tasks',
  'trace',
  'setup',
  'login',
  'register',
  'invites',
] as const

export type RouteName = (typeof ROUTE_NAMES)[number]

export const DEFAULT_ROUTE: RouteName = 'home'

/** 路由 → 地址。navigate 只用这一张表，反向拼串不存在。 */
const ROUTE_PATHS: Record<RouteName, string> = {
  home: '/',
  checkin: '/checkin',
  tasks: '/tasks',
  trace: '/trace',
  setup: '/setup',
  login: '/login',
  register: '/register',
  invites: '/invites',
}

/** 页面标题也走白名单，避免把地址栏内容带进 document.title */
const ROUTE_TITLES: Record<RouteName, string> = {
  home: '工作台',
  checkin: '打卡',
  tasks: '待办',
  trace: '学习轨迹',
  setup: '首次启动',
  login: '登录',
  register: '注册',
  invites: '邀请码',
}

const APP_TITLE = 'TodoAgent · 每日打卡工作台'

const PATH_TO_ROUTE: ReadonlyMap<string, RouteName> = new Map(
  ROUTE_NAMES.map((name) => [ROUTE_PATHS[name], name] as const),
)

/** 只接受最短的必要字符集；不满足即视为无效地址，落默认路由 */
const SAFE_HASH = /^#\/[A-Za-z0-9_-]{0,32}$|^#$/

function normalize(path: string): string {
  if (path === '/') return '/'
  return path.replace(/\/+$/, '')
}

/** 读取当前路由。永远返回白名单内的枚举值。 */
export function readRoute(): RouteName {
  if (typeof window === 'undefined') return DEFAULT_ROUTE
  const raw = window.location.hash
  if (!SAFE_HASH.test(raw)) return DEFAULT_ROUTE
  const path = normalize(raw.slice(1))
  return PATH_TO_ROUTE.get(path) ?? DEFAULT_ROUTE
}

/** 路由 → 可直接放进 href 的地址（含 #）。地址拼接只在 router 内发生。 */
export function routeHref(name: RouteName): string {
  return `#${ROUTE_PATHS[name]}`
}

/** 跳转到白名单内的路由。 */
export function navigate(name: RouteName): void {
  if (typeof window === 'undefined') return
  const next = `#${ROUTE_PATHS[name]}`
  if (window.location.hash === next) return
  window.location.hash = ROUTE_PATHS[name]
}

export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener('hashchange', listener)
  return () => {
    window.removeEventListener('hashchange', listener)
  }
}

/** 把当前路由写进 document.title（同样只取白名单文案）。 */
export function applyRouteTitle(name: RouteName): void {
  if (typeof document === 'undefined') return
  document.title = `${ROUTE_TITLES[name]} · ${APP_TITLE}`
}

/** 登录后才可达的白名单（不在此表的一律回工作台）；角色限制在下面单独判 */
const AUTHED_ROUTES: readonly RouteName[] = ['home', 'checkin', 'tasks', 'trace', 'invites']

/**
 * 路由守卫的纯函数形态：给定「是否存在 owner」「是否已登录」「是否 owner」，
 * 算出此刻真正该显示的路由。App 用它做渲染与地址同步，
 * 因此重定向是确定的，不依赖 effect 时序。
 *
 * 注意 `isOwner` 只管**显隐**，不是安全边界：邀请码页藏起来只是省得 member
 * 点进一个必然报错的页面，真正的关口是服务端的 403（ADR-008 §2）。
 */
export function resolveRoute(
  requested: RouteName,
  options: { needsOwner: boolean; authenticated: boolean; isOwner: boolean },
): RouteName {
  if (options.needsOwner) return 'setup'
  if (!options.authenticated) {
    // 未登录时只放行注册页（其余一律回登录页）
    return requested === 'register' ? 'register' : 'login'
  }
  if (!AUTHED_ROUTES.includes(requested)) return 'home'
  if (requested === 'invites' && !options.isOwner) return 'home'
  return requested
}
