import type { Page } from '@playwright/test'

/**
 * 会话预置：让页面带着一枚真实令牌启动。
 *
 * 为什么直接写 localStorage 而不是每条用例都走一遍登录表单：
 * 路由守卫的用例要穷举「四种状态 × 五个地址」，走界面登录会把 20 条用例
 * 变成 40 次表单交互，失败时也分不清是守卫坏了还是表单坏了。
 * **真的从表单登录**由 03-acceptance-chain 覆盖一次，两条路都留着。
 *
 * 键名与 src/lib/auth-token.ts 的 STORAGE_KEY 一致（ADR-008 §1：令牌由前端持有，不用 Cookie）。
 */
export const SESSION_TOKEN_KEY = 'todoagent.session.token'

/** 页面任何脚本之前写入令牌——效果等同于「上次登录过，这次带着令牌回来」。 */
export async function signInAs(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string)
      } catch {
        // 存储不可用的话，用例会在「未登录」分支上失败——这正是我们要知道的
      }
    },
    [SESSION_TOKEN_KEY, token] as const,
  )
}

/** 读出页面当前持有的令牌（登出用例据此断言本地令牌已清）。 */
export async function readStoredToken(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }, SESSION_TOKEN_KEY)
}
