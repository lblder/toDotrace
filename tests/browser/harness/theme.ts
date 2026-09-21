import type { Page } from '@playwright/test'

/**
 * 主题首帧的测量工具。
 *
 * 要防的回归具体是这一条：**样式表生效之后、React 启动之前**那一帧，
 * 页面应当已经是用户该看到的主题。`public/theme-init.js` 就是为这一帧存在的
 * （CSP 是 script-src 'self'，内联脚本写不了，所以是个 classic 文件）。
 *
 * 两个颜色来自 tokens.css 的 --c-bg（暗 #0b111a / 亮 #f5f2ea），
 * 由 body 的 background-color 解析成 rgb() 后落在计算样式里。
 * 这里写的是**解析后的结果**，不是令牌名——测的是「用户眼睛看到什么」。
 */

/** 存储键。theme-init.js 里的 KEY 与 src/lib/theme.ts 的兜底值都必须等于它。 */
export const THEME_KEY = 'todoagent.theme'

export const DARK_BG = 'rgb(11, 17, 26)' // #0b111a 铁胆墨底
export const LIGHT_BG = 'rgb(245, 242, 234)' // #f5f2ea 纸白底

export type ColorScheme = 'dark' | 'light'

/** 三种存储状态：显式暗、显式亮、跟随系统；以及「从未存过」。 */
export type StoredPreference = 'dark' | 'light' | 'system' | 'none'

export interface FirstFrame {
  /** <html data-theme> 的值；属性缺失时为 null */
  readonly theme: string | null
  /** <html data-theme-key> 的值——脚本宣告的存储键 */
  readonly themeKey: string | null
  /** body 的计算背景色（rgb(...)） */
  readonly bodyBackground: string
  /** location.hash 的原始值，用来确认「首帧没有被守卫改写地址」 */
  readonly hash: string
}

declare global {
  interface Window {
    __themeHistory?: (string | null)[]
  }
}

/**
 * 记录 data-theme 的每一次取值。
 *
 * 用 MutationObserver 盯 document 的子树：theme-init.js 是「设置」而非「改」属性，
 * 但 null → 'dark' 也是一次属性变更，所以即使观察器早于 <html> 存在也不会漏。
 * 结果是「本次加载里属性出现过的值序列」——长度为 1 即等于全程没有翻转。
 */
const HISTORY_INIT = `
  window.__themeHistory = []
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var target = records[i].target
      if (target && target.nodeType === 1) {
        var value = target.getAttribute('data-theme')
        var history = window.__themeHistory
        if (history[history.length - 1] !== value) history.push(value)
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] })
`

/**
 * 在页面任何脚本之前：写存储偏好（'none' 表示清空），并开始记录主题历史。
 * 顺序要紧——localStorage 必须在 theme-init.js 读它之前写好。
 */
export async function primeTheme(
  page: Page,
  options: { scheme: ColorScheme; stored: StoredPreference },
): Promise<void> {
  await page.emulateMedia({ colorScheme: options.scheme })
  await page.addInitScript(
    ([key, stored]) => {
      try {
        if (stored === 'none') window.localStorage.removeItem(key as string)
        else window.localStorage.setItem(key as string, stored as string)
      } catch {
        // 存储被禁用时用例会走「跟随系统」分支，交给断言去说
      }
    },
    [THEME_KEY, options.stored] as const,
  )
  await page.addInitScript(HISTORY_INIT)
}

/** 读取首帧（样式已生效、React 未启动）的主题状态。 */
export async function readFirstFrame(page: Page): Promise<FirstFrame> {
  return page.evaluate(() => {
    const root = document.documentElement
    return {
      theme: root.getAttribute('data-theme'),
      themeKey: root.getAttribute('data-theme-key'),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      hash: window.location.hash,
    }
  })
}

/** 整个加载过程中 data-theme 出现过的值（去重、保序）。 */
export async function themeHistory(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => window.__themeHistory ?? [])
}

/**
 * 「React 还没启动」的这一帧怎么拿到：把打包出来的入口 JS 拦掉。
 *
 * dist 的产物是 /assets/index-<hash>.js；CSS 是 head 里的 <link>，
 * 不受影响。theme-init.js 在 public/ 下、路径是 /theme-init.js，
 * 这个 glob 不会命中它。
 *
 * 为什么不用 dev server 做这件事：dev 下 CSS 由模块脚本注入，
 * 拦掉 JS 之后页面上根本没有样式，那一帧量不出任何东西。
 */
export const REACT_BUNDLE_GLOB = '**/assets/*.js'

/** 把入口 bundle 拦下，得到一个确定的「React 启动前」页面。 */
export async function blockReactBundle(page: Page): Promise<void> {
  await page.route(REACT_BUNDLE_GLOB, (route) => route.abort())
}

/**
 * 期望值：给定「系统偏好 × 存储值」，首帧该是什么主题、什么底色。
 * 这是 theme-init.js 的取值规则（与 src/lib/theme.ts 的 resolve() 一致）：
 * 存了 dark/light 就用它，其余（system / none）跟随系统。
 */
export function expectedTheme(
  scheme: ColorScheme,
  stored: StoredPreference,
): { theme: ColorScheme; background: string } {
  const resolved: ColorScheme = stored === 'dark' || stored === 'light' ? stored : scheme
  return { theme: resolved, background: resolved === 'dark' ? DARK_BG : LIGHT_BG }
}
