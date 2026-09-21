import { expect, test } from '@playwright/test'
import { seedOwner } from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { useStack } from './harness/stack'

/**
 * 路由安全：恶意 hash 不产生注入。
 *
 * 架构文档 §6 的要求是「白名单匹配，**原始 hash 不进 DOM**」。
 * 这条要求是可证伪的：把用户可控的字符串渲染出去的任何一条路径，
 * 都会在这里留下痕迹——元素、事件处理器属性、标题、或者真的弹一个框。
 *
 * 注意这些 payload 是**地址栏里的内容**，不是「用户填进表单的内容」——
 * 前者是任何人可以做成链接发给别人的东西。
 */

declare global {
  interface Window {
    __cspViolations?: string[]
  }
}

const stackOf = useStack()

test.beforeAll(async () => {
  await seedOwner(stackOf())
})

/** 登录页的标题（白名单文案）；恶意 hash 不该出现在这里 */
const LOGIN_TITLE = '登录 · TodoAgent · 每日打卡工作台'

const PAYLOADS: readonly { label: string; hash: string }[] = [
  { label: 'img onerror', hash: '#/<img src=x onerror=alert(1)>' },
  { label: 'svg onload', hash: '#/<svg onload=alert(1)>' },
  { label: '编码后的 img onerror', hash: '#/%3Cimg%20src=x%20onerror=alert(1)%3E' },
  { label: '引号闭合 + script', hash: '#/"><script>alert(1)</script>' },
  { label: 'script 闭合逃逸', hash: '#/</script><script>alert(1)</script>' },
  { label: '路径里夹带标签', hash: '#/invites%22%3E%3Cb%3E' },
  { label: 'javascript: 伪协议', hash: '#/javascript:alert(1)' },
  { label: '目录穿越', hash: '#/../../etc/passwd' },
  { label: '超长路径（越过白名单长度上限）', hash: `#/${'a'.repeat(64)}` },
  { label: '合法字符但不在白名单', hash: '#/admin' },
]

for (const payload of PAYLOADS) {
  test(`${payload.label} 不产生注入`, async ({ page }) => {
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message())
      void dialog.dismiss()
    })

    // CSP 违规是「有人试图执行注入内容」的旁证（script-src 'self' 会拦下内联脚本）
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__cspViolations?.push(event.violatedDirective)
      })
    })

    await page.goto(`${stackOf().baseUrl}/${payload.hash}`)

    // 正向条件：应用**确实渲染了**。否则下面每一条都会因为「页面是空的」而通过
    await expect(page.locator('#auth-title')).toBeVisible()

    // 原始 hash 被收回到白名单路径（地址栏本身也不留恶意串）
    await expect(page).toHaveURL(/#\/login$/)

    // 原始 hash 不进 DOM：元素、事件处理器属性、脚本体，一个都不该有
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onload')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('alert(')
    expect(html).not.toContain('javascript:')

    expect(await page.locator('img').count(), '页面里不该有 img 元素').toBe(0)
    expect(await page.locator('#root script').count(), '不该有脚本被塞进挂载点').toBe(0)

    // 标题只取白名单文案
    expect(await page.title()).toBe(LOGIN_TITLE)

    expect(dialogs, '不该有任何对话框').toEqual([])
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
  })
}

test('正向对照：白名单内的深链接照常工作', async ({ page }) => {
  // 上面那组若要靠「什么都拒绝」通过，这条会失败
  await gotoHash(page, stackOf().baseUrl, HASH.register)
  await expectScreen(page, 'register')
  expect(await page.title()).toBe('注册 · TodoAgent · 每日打卡工作台')
})
