import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { MEMBER, OWNER } from './harness/api'
import { expectScreen, HASH, waitForScreen } from './harness/routes'
import { readStoredToken } from './harness/session'
import { useStack } from './harness/stack'

/**
 * 阶段 1 第一条验收标准（03 §3）的完整链路，全程走界面、不打 API：
 *
 *   owner 首启 → 签发邀请码 → 另一账号凭码注册 → 登录 → 登出
 *
 * 这条链是**串行**的：每一步都依赖上一步的结果（邀请码只显示一次，拿不到就断了），
 * 因此用 describe.serial，失败时后面的步骤直接跳过，而不是每条都报一个看不懂的错。
 *
 * owner 的会话跨步骤保留：登录态在 localStorage 里，而 Playwright 默认给每条用例
 * 发一个**全新上下文**（等同于换一台设备）。所以这里显式建一个共享上下文，
 * 每条用例在它里面开新标签页——「同一个人接着往下做」才成立。
 */

test.describe.serial('验收链路', () => {
  const stackOf = useStack()

  let ownerContext: BrowserContext
  let inviteCode = ''

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({ locale: 'zh-CN' })
  })

  test.afterAll(async () => {
    await ownerContext?.close()
  })

  /** 在共享上下文里开一页（保持 owner 的登录态） */
  async function ownerPage(): Promise<Page> {
    return ownerContext.newPage()
  }

  test('1. owner 首启：空库上出现的是首启引导', async () => {
    const page = await ownerPage()
    await page.goto(`${stackOf().baseUrl}/`)
    await expectScreen(page, 'setup')
    await expect(page.locator('#auth-title')).toHaveText('首次启动')
    await page.close()
  })

  test('2. owner 建号后直接进入工作台', async () => {
    const page = await ownerPage()
    await page.goto(`${stackOf().baseUrl}/`)
    await waitForScreen(page, 'setup')

    await page.getByLabel('用户名', { exact: true }).fill(OWNER.username)
    await page.getByLabel('显示名', { exact: true }).fill(OWNER.displayName)
    await page.getByLabel('密码', { exact: true }).fill(OWNER.password)
    await page.getByRole('button', { name: '创建 owner 并进入' }).click()

    await expectScreen(page, 'home')
    await expect(page.locator('#home-heading')).toHaveText(`欢迎回来，${OWNER.displayName}`)
    await expect(page.locator('.ta-shell__account')).toHaveText(`@${OWNER.username}`)
    await expect(page.locator('.ta-shell__actions .ta-badge')).toHaveText('owner')
    await page.close()
  })

  test('3. owner 从导航进邀请码页并签发一枚码', async () => {
    const page = await ownerPage()
    await page.goto(`${stackOf().baseUrl}/`)
    await expectScreen(page, 'home')

    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '邀请码' }).click()
    await expectScreen(page, 'invites')

    // 刚建号，还没签发过任何码
    await expect(page.locator('.ta-invites__list')).toContainText('还没有签发过邀请码。')

    await page.getByRole('button', { name: '签发邀请码' }).click()

    const issued = page.locator('.ta-invites__issued')
    await expect(issued).toBeVisible()
    await expect(issued).toContainText('此码只显示这一次，请立即复制。离开本页后将无法再次查看。')

    const code = (await page.locator('.ta-invites__code').textContent()) ?? ''
    expect(code.trim().length, '签发出来的码不应为空').toBeGreaterThan(0)
    inviteCode = code.trim()
    await page.close()
  })

  test('4. 刷新后签发记录仍在，且状态为待使用', async () => {
    const page = await ownerPage()
    await page.goto(`${stackOf().baseUrl}/`)
    await waitForScreen(page, 'home')
    await page.goto(`${stackOf().baseUrl}/${HASH.invites}`)
    await expectScreen(page, 'invites')

    await expect(page.locator('.ta-invites__item')).toHaveCount(1)
    await expect(page.locator('.ta-invites__item')).toContainText('待使用')
    await page.close()
  })

  test('5. 另一账号凭码注册，落地即登录', async ({ browser }) => {
    expect(inviteCode, '上一步没拿到邀请码').not.toBe('')

    // 全新上下文：没有任何令牌，等同于另一台设备上的人
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()

    await page.goto(`${stackOf().baseUrl}/`)
    await expectScreen(page, 'login') // 已有 owner，未登录只能到登录页

    await page.getByRole('button', { name: '注册新账号' }).click()
    await expectScreen(page, 'register')

    await page.getByLabel('邀请码', { exact: true }).fill(inviteCode)
    await page.getByLabel('用户名', { exact: true }).fill(MEMBER.username)
    await page.getByLabel('显示名', { exact: true }).fill(MEMBER.displayName)
    await page.getByLabel('密码', { exact: true }).fill(MEMBER.password)
    await page.getByRole('button', { name: '注册并进入' }).click()

    await expectScreen(page, 'home')
    await expect(page.locator('#home-heading')).toHaveText(`欢迎回来，${MEMBER.displayName}`)
    await expect(page.locator('.ta-shell__actions .ta-badge')).toHaveText('成员')

    // 注册即持令牌（ADR-008 §2：响应里有 token，不要求再登录一次）
    expect(await readStoredToken(page)).not.toBeNull()

    await context.close()
  })

  test('6. 登出后回到登录页，本地令牌被清掉', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()

    // 用刚注册的账号走一遍真正的登录表单（验收链路里的「登录」一步）
    await page.goto(`${stackOf().baseUrl}/`)
    await expectScreen(page, 'login')

    await page.getByLabel('用户名', { exact: true }).fill(MEMBER.username)
    await page.getByLabel('密码', { exact: true }).fill(MEMBER.password)
    await page.getByRole('button', { name: '登录' }).click()

    await expectScreen(page, 'home')
    await expect(page.locator('#home-heading')).toHaveText(`欢迎回来，${MEMBER.displayName}`)
    expect(await readStoredToken(page)).not.toBeNull()

    await page.getByRole('button', { name: '登出' }).click()

    await expectScreen(page, 'login')
    expect(await readStoredToken(page), '登出后本地不该再留着令牌').toBeNull()

    await context.close()
  })

  test('7. 回到 owner：那枚码已被使用，并显示使用者', async () => {
    const page = await ownerPage()
    await page.goto(`${stackOf().baseUrl}/${HASH.invites}`)
    await expectScreen(page, 'invites')

    const row = page.locator('.ta-invites__item')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('已使用')
    await expect(row).toContainText(`${MEMBER.displayName}（@${MEMBER.username}）`)
    await page.close()
  })
})
