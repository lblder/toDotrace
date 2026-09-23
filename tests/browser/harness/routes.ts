import { expect, type Page } from '@playwright/test'

/**
 * 每个路由的「白名单地址 + 落地地标」。
 *
 * 断言分两步，顺序不能反：
 *   1. 先等地标出现——它是「App 已经判断完该显示哪一屏」的证据；
 *   2. 再断言地址栏等于白名单路径。
 *
 * 只断言地址的话，在守卫还没跑之前就通过了（那时地址当然还是原样）；
 * 只断言地标的话，测不出重定向是否**落到地址栏**（深链接要靠地址可分享）。
 */

export type RouteName = 'home' | 'checkin' | 'tasks' | 'setup' | 'login' | 'register' | 'invites'

export const HASH: Readonly<Record<RouteName, string>> = {
  home: '#/',
  checkin: '#/checkin',
  tasks: '#/tasks',
  setup: '#/setup',
  login: '#/login',
  register: '#/register',
  invites: '#/invites',
}

/**
 * 地址栏该长什么样。
 *
 * 首页有一条特殊：用裸地址 `http://host/` 打开时，hash 是**空串**，
 * 而 readRoute() 把空串也认作首页（DEFAULT_ROUTE），此时 route === effective，
 * 守卫没有理由改写地址——于是地址栏就停在没有 # 的样子。
 * 这不是 bug：默认路由本来就该能被裸地址打开，且裸地址永远可分享。
 * 所以首页接受「以 / 结尾」的两种形态，其余路由仍要求精确的白名单 hash。
 */
const URL_PATTERN: Readonly<Record<RouteName, RegExp>> = {
  home: /\/$/,
  checkin: /#\/checkin$/,
  tasks: /#\/tasks$/,
  setup: /#\/setup$/,
  login: /#\/login$/,
  register: /#\/register$/,
  invites: /#\/invites$/,
}

/** 路由 → 只有该屏才有的选择器与文案 */
const LANDMARK: Readonly<Record<RouteName, { selector: string; text: string }>> = {
  setup: { selector: '#auth-title', text: '首次启动' },
  login: { selector: '#auth-title', text: '登录' },
  register: { selector: '#auth-title', text: '注册' },
  home: { selector: '#home-heading', text: '欢迎回来' },
  checkin: { selector: '#checkin-heading', text: '今日打卡' },
  tasks: { selector: '#tasks-heading', text: '任务' },
  invites: { selector: '#invites-heading', text: '邀请码' },
}

/** 等这一屏真的出现（不涉及地址栏）。 */
export async function waitForScreen(page: Page, route: RouteName): Promise<void> {
  const mark = LANDMARK[route]
  await expect(page.locator(mark.selector)).toContainText(mark.text)
}

/**
 * 等这一屏出现，并断言地址栏就是它的白名单路径。
 *
 * `hashOnly` 为 true 时只比对 hash 部分（默认整条 URL——本地栈是 http://127.0.0.1:port，
 * 没有别的可变部分，整条比对更严格）。
 */
export async function expectScreen(page: Page, route: RouteName): Promise<void> {
  await waitForScreen(page, route)
  await expect(page).toHaveURL(URL_PATTERN[route])
}

/**
 * 记录地址栏的每一次变化（含首帧的原值）。
 *
 * 用来证明「深链接从头到尾没被改写过」——只看最终地址的话，
 * 一条「先去 #/login 再被弹回 #/invites」的路径也能蒙混过关，
 * 而那正是用户会看到闪一下的 bug。
 */
export async function trackHashTrail(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trail: string[] = [window.location.hash]
    window.addEventListener('hashchange', () => {
      trail.push(window.location.hash)
    })
    ;(window as unknown as { __hashTrail?: string[] }).__hashTrail = trail
  })
}

export async function hashTrail(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __hashTrail?: string[] }).__hashTrail ?? [],
  )
}

/**
 * 把地址栏设成某个 hash 并等页面稳定下来。
 *
 * 用 `page.goto(baseUrl + hash)` 而不是 `page.evaluate(() => location.hash = ...)`：
 * goto 是**整页加载**，走的正是「深链接 / 刷新」这条路——
 * 路由守卫的时序 bug（首启状态没回来就把地址改掉）只在这条路上出现，
 * 客户端跳转（hashchange）不会重新走一遍启动流程。
 */
export async function gotoHash(page: Page, baseUrl: string, hash: string): Promise<void> {
  await page.goto(`${baseUrl}/${hash}`)
}
