import { expect, test, type Page } from '@playwright/test'
import { issueInvite, OWNER, seedMember, seedOwner } from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { useStack } from './harness/stack'

/**
 * 服务端错误码 → 界面落点（ADR-008 §8 的稳定 code）。
 *
 * 注册页有一张映射表：能归因到字段的错误贴在该输入框下并聚焦过去，
 * 其余走表单级横幅。两条分支都要用**真实的服务端响应**来喂，
 * 所以在库里造出真实的冲突——重名、无效码、已用过的码。
 */

const stackOf = useStack()

let ownerToken = ''
/** 一枚已经被消耗掉的码（seedMember 注册时用掉了它） */
let usedCode = ''

test.beforeAll(async () => {
  const owner = await seedOwner(stackOf())
  ownerToken = owner.token
  usedCode = (await seedMember(stackOf(), ownerToken)).inviteCode
})

/** 某个 label 对应的输入框下方的字段级错误 */
function fieldError(page: Page, label: string) {
  return page
    .locator('.ta-field')
    .filter({ has: page.locator('.ta-field__label', { hasText: label }) })
    .locator('.ta-field__error')
}

const banner = (page: Page) => page.locator('.ta-banner--error')

async function openRegister(page: Page): Promise<void> {
  await gotoHash(page, stackOf().baseUrl, HASH.register)
  await expectScreen(page, 'register')
}

interface RegisterValues {
  inviteCode: string
  username: string
  displayName: string
  password: string
}

async function submitRegister(page: Page, values: RegisterValues): Promise<void> {
  await page.getByLabel('邀请码', { exact: true }).fill(values.inviteCode)
  await page.getByLabel('用户名', { exact: true }).fill(values.username)
  await page.getByLabel('显示名', { exact: true }).fill(values.displayName)
  await page.getByLabel('密码', { exact: true }).fill(values.password)
  await page.getByRole('button', { name: '注册并进入' }).click()
}

test.describe('注册页：错误落到字段上', () => {
  test('conflict/username-taken → 用户名字段', async ({ page }) => {
    // 用一枚**全新有效**的码：这样若这次失败，原因只可能是重名
    const fresh = await issueInvite(stackOf(), ownerToken, 7)

    await openRegister(page)
    await submitRegister(page, {
      inviteCode: fresh.invite.code,
      username: OWNER.username, // 与已存在的 owner 同名
      displayName: '重名的人',
      password: 'brand-new-pass-1',
    })

    await expect(fieldError(page, '用户名')).toContainText('用户名已被占用')
    await expect(page.getByLabel('用户名', { exact: true })).toBeFocused()
    // 不是字段问题的错误才走横幅；这条不该同时出现横幅
    await expect(banner(page)).toHaveCount(0)
    // 也不该顺手把错贴到别的字段上
    await expect(fieldError(page, '邀请码')).toHaveCount(0)

    // 一编辑就把旧错误撤掉（否则「改完了错还在」）
    await page.getByLabel('用户名', { exact: true }).fill('fresh_name_here')
    await expect(fieldError(page, '用户名')).toHaveCount(0)
  })

  test('invite/invalid → 邀请码字段', async ({ page }) => {
    await openRegister(page)
    await submitRegister(page, {
      inviteCode: 'definitely-not-a-real-code',
      username: 'member_gamma',
      displayName: '实验员丙',
      password: 'brand-new-pass-2',
    })

    await expect(fieldError(page, '邀请码')).toContainText('邀请码无效或已过期')
    await expect(page.getByLabel('邀请码', { exact: true })).toBeFocused()
    await expect(banner(page)).toHaveCount(0)
    await expect(fieldError(page, '用户名')).toHaveCount(0)
  })

  test('conflict/invite-used → 邀请码字段', async ({ page }) => {
    expect(usedCode, 'beforeAll 没拿到已用过的码').not.toBe('')

    await openRegister(page)
    await submitRegister(page, {
      inviteCode: usedCode,
      username: 'member_delta',
      displayName: '实验员丁',
      password: 'brand-new-pass-3',
    })

    await expect(fieldError(page, '邀请码')).toContainText('邀请码已被使用')
    await expect(page.getByLabel('邀请码', { exact: true })).toBeFocused()
    await expect(banner(page)).toHaveCount(0)
  })
})

test.describe('登录页：无法归因的错误走横幅', () => {
  test('auth/invalid-credentials → 表单级横幅，不贴字段', async ({ page }) => {
    await gotoHash(page, stackOf().baseUrl, HASH.login)
    await expectScreen(page, 'login')

    await page.getByLabel('用户名', { exact: true }).fill(OWNER.username)
    await page.getByLabel('密码', { exact: true }).fill('definitely-the-wrong-password')
    await page.getByRole('button', { name: '登录' }).click()

    // 401 的文案由服务端给出，前端原样显示；登录页不猜是用户名错了还是口令错了
    await expect(banner(page)).toContainText('用户名或密码不正确')
    await expect(page.locator('.ta-field__error')).toHaveCount(0)
  })
})
