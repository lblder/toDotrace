import { expect, test } from '@playwright/test'
import { seedOwner } from './harness/api'
import { gotoHash, HASH, expectScreen } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'
import {
  blockReactBundle,
  DARK_BG,
  expectedTheme,
  primeTheme,
  readFirstFrame,
  THEME_KEY,
  themeHistory,
  type ColorScheme,
  type StoredPreference,
} from './harness/theme'

/**
 * 主题首帧 —— `public/theme-init.js` 的回归线。
 *
 * 这一条最要紧的地方在于**时机**：样式表已经生效、React 还没启动的那一帧，
 * 页面必须已经是用户该看到的主题。晚一帧就是白闪/黑闪，
 * 而「最后一帧是对的」这种断言全然抓不到它。
 *
 * 所以有两组：
 *   A. 首帧测量  —— 拦掉入口 bundle，量确定性的「React 启动前」那一帧；
 *   B. 全程无翻转 —— 装 MutationObserver，量整个加载过程中 data-theme 变过几次。
 * A 能抓住「首帧错」，B 能抓住「首帧对但随后翻了一下」。
 */

const stackOf = useStack()
const SCHEMES: readonly ColorScheme[] = ['dark', 'light']
const STORED: readonly StoredPreference[] = ['dark', 'light', 'system', 'none']

let ownerToken = ''

test.beforeAll(async () => {
  ownerToken = (await seedOwner(stackOf())).token
})

/* ---------------------------------------------------------------------------
   A. React 启动前那一帧
   --------------------------------------------------------------------------- */

test.describe('React 启动前那一帧', () => {
  for (const scheme of SCHEMES) {
    for (const stored of STORED) {
      test(`系统 ${scheme} × 存储 ${stored}`, async ({ page }) => {
        const expected = expectedTheme(scheme, stored)

        await primeTheme(page, { scheme, stored })
        await blockReactBundle(page)
        await page.goto(`${stackOf().baseUrl}/#/`)

        const frame = await readFirstFrame(page)

        // 属性必须被写死：tokens.css 在没有 data-theme 时落进 :root:not([data-theme])，
        // 那是一套固定暗色、不看系统偏好——「不设置属性，交给 CSS 兜底」是行不通的
        expect(frame.theme, '首帧的 data-theme').toBe(expected.theme)
        expect(frame.bodyBackground, '首帧的 body 背景色').toBe(expected.background)
        // 脚本把存储键宣告在 DOM 上，src/lib/theme.ts 从这里读回去
        expect(frame.themeKey, '首帧的 data-theme-key').toBe(THEME_KEY)
      })
    }
  }

  test('拦下的确实是入口 bundle，而 theme-init.js 照常执行', async ({ page }) => {
    // 对照组：这一条守的是上面那组的有效性——
    // 如果 glob 写错、把 page 整个拦成空白，上面 8 条会「通过」但什么都没测到。
    await primeTheme(page, { scheme: 'dark', stored: 'none' })
    await blockReactBundle(page)
    await page.goto(`${stackOf().baseUrl}/#/`)

    const root = page.locator('#root')
    await expect(root).toBeEmpty() // React 没跑起来
    expect((await readFirstFrame(page)).theme).toBe('dark') // 但主题属性已经落了
  })

  test('对照：theme-init.js 缺席时，系统 light 也会渲染成固定暗色', async ({ page }) => {
    // 这条是 A 组的反证：它证明 A 组的断言「对脚本是否存在」是敏感的。
    // tokens.css 在没有 data-theme 时落到 :root:not([data-theme]) —— 一套固定暗色、
    // 不看系统偏好。所以若哪天 theme-init.js 不再总是写这个属性，
    // A 组里「系统 light × 存储 none → 亮色」那一条必然失败。
    await page.route('**/theme-init.js', (route) => route.abort())
    await primeTheme(page, { scheme: 'light', stored: 'none' })
    await blockReactBundle(page)
    await page.goto(`${stackOf().baseUrl}/#/`)

    const frame = await readFirstFrame(page)
    expect(frame.theme, '没有脚本就没有属性').toBeNull()
    expect(frame.bodyBackground, '没有属性就是固定暗色').toBe(DARK_BG)
  })
})

/* ---------------------------------------------------------------------------
   B. 启动全程只出现一个主题值
   --------------------------------------------------------------------------- */

test.describe('启动全程不翻转', () => {
  for (const scheme of SCHEMES) {
    for (const stored of STORED) {
      test(`系统 ${scheme} × 存储 ${stored}`, async ({ page }) => {
        const expected = expectedTheme(scheme, stored)

        await primeTheme(page, { scheme, stored })
        await page.goto(`${stackOf().baseUrl}/#/`)
        // 等到账号页真的渲染出来，说明 React 已经跑完第一轮
        await expect(page.locator('#auth-title')).toBeVisible()

        // 长度为 1：首帧就是这个值，中途没有翻过
        expect(await themeHistory(page)).toEqual([expected.theme])
      })
    }
  }

  test('对照：人为制造一次翻转时，历史记录抓得到', async ({ page }) => {
    // 这条是 B 组的反证：证明 themeHistory 不是永远只有一个值的摆设。
    // DOMContentLoaded 在模块脚本之后触发，所以这一下确实发生在应用启动之后。
    await primeTheme(page, { scheme: 'dark', stored: 'none' })
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.setAttribute('data-theme', 'light')
      })
    })
    await page.goto(`${stackOf().baseUrl}/#/`)
    await expect(page.locator('#auth-title')).toBeVisible()

    const history = await themeHistory(page)
    expect(history[0]).toBe('dark')
    expect(history).toContain('light')
    expect(history.length).toBeGreaterThan(1)
  })
})

/* ---------------------------------------------------------------------------
   C. 存储键的单一来源
   ---------------------------------------------------------------------------
   theme-init.js 宣告键、src/lib/theme.ts 用它；脚本缺席时 theme.ts 用自己的兜底常量。
   两个值必须一致——下面两条用行为核对，而不是靠人盯两处字面量。
   --------------------------------------------------------------------------- */

test.describe('存储键', () => {
  test('切换主题写回脚本宣告的那个键', async ({ page }) => {
    await primeTheme(page, { scheme: 'dark', stored: 'none' })
    await signInAs(page, ownerToken)
    await gotoHash(page, stackOf().baseUrl, HASH.home)
    await expectScreen(page, 'home')

    const declared = await page.evaluate(() => document.documentElement.dataset.themeKey)
    expect(declared).toBe(THEME_KEY)
    expect(await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY)).toBeNull()

    await page.getByRole('button', { name: '切换到亮色主题' }).click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY)).toBe('light')
  })

  test('theme-init.js 缺席时，兜底常量仍写同一个键', async ({ page }) => {
    // 拦掉首帧脚本：页面上就没有 data-theme-key，
    // src/lib/theme.ts 只能用 FALLBACK_STORAGE_KEY——它必须与脚本里的 KEY 相等。
    await page.route('**/theme-init.js', (route) => route.abort())
    await primeTheme(page, { scheme: 'dark', stored: 'none' })
    await signInAs(page, ownerToken)
    await gotoHash(page, stackOf().baseUrl, HASH.home)
    await expectScreen(page, 'home')

    const declared = await page.evaluate(() => document.documentElement.dataset.themeKey)
    expect(declared, '脚本被拦下后不该再有宣告').toBeUndefined()

    await page.getByRole('button', { name: '切换到亮色主题' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY),
      '兜底常量与 theme-init.js 的 KEY 必须一致',
    ).toBe('light')
  })
})

