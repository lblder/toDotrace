import { expect, test, type Locator, type Page } from '@playwright/test'
import { seedOwner } from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { useStack } from './harness/stack'

/**
 * 无障碍回归（需求文档 §4）。
 *
 * 两条都是**真的量计算样式**，不是看类名：
 *   1. 键盘焦点环可见——曾经用「14% 透明度的柔光」顶替焦点环，
 *      计算出来的 outline-style 是 none，环根本不存在（WCAG 2.2 SC 2.4.11）；
 *   2. prefers-reduced-motion 下时长令牌归零——动效是加分项，
 *      对前庭敏感的人是减分项，系统说了关就得关。
 */

const stackOf = useStack()

test.beforeAll(async () => {
  await seedOwner(stackOf())
})

/** 暗色下的焦点环颜色（tokens.css --c-focus:#d9a441） */
const DARK_FOCUS = 'rgb(217, 164, 65)'

async function outlineOf(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
    }
  })
}

/** 把 '0s' / '0ms' / '220ms' / '0.22s' 一律化成毫秒数 */
function toMs(value: string): number {
  const trimmed = value.trim()
  if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed)
  if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) * 1000
  return Number.NaN
}

const DURATION_TOKENS = [
  '--dur-instant',
  '--dur-fast',
  '--dur-base',
  '--dur-slow',
  '--dur-stamp',
] as const

async function durationTokens(page: Page): Promise<Record<string, number>> {
  const raw = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement)
    return names.map((name) => style.getPropertyValue(name))
  }, DURATION_TOKENS as unknown as string[])
  return Object.fromEntries(DURATION_TOKENS.map((name, index) => [name, toMs(raw[index] ?? '')]))
}

test.describe('焦点可见性', () => {
  test('键盘焦点落在输入框上时，焦点环真的画出来了', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await gotoHash(page, stackOf().baseUrl, HASH.login)
    await expectScreen(page, 'login')

    const input = page.getByLabel('用户名', { exact: true })
    await expect(input).toBeVisible()

    // 基线：焦点移开时不该有环（否则「有环」这件事无法证伪）
    await page.locator('#auth-title').click()
    const idle = await outlineOf(input)
    expect(idle.style, '未聚焦时不该有轮廓').toBe('none')

    // 用键盘把焦点送回去——这保证命中的是 :focus-visible 而不是 :focus
    await page.keyboard.press('Tab')
    await expect(input).toBeFocused()

    const focused = await outlineOf(input)
    expect(focused.style, '焦点环必须存在（outline-style 不能是 none）').toBe('solid')
    expect(focused.width, '焦点环宽度').toBe('2px')
    expect(focused.color, '焦点环用的是 --c-focus 令牌').toBe(DARK_FOCUS)
  })

  test('焦点环随主题换色，不是写死的黄铜', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await gotoHash(page, stackOf().baseUrl, HASH.login)
    await expectScreen(page, 'login')

    await page.locator('#auth-title').click()
    await page.keyboard.press('Tab')
    const input = page.getByLabel('用户名', { exact: true })
    await expect(input).toBeFocused()

    const focused = await outlineOf(input)
    expect(focused.style).toBe('solid')
    // 亮色下 --c-focus:#8a6212——若哪天有人把颜色写死在组件里，这条会失败
    expect(focused.color).toBe('rgb(138, 98, 18)')
  })
})

test.describe('prefers-reduced-motion', () => {
  test('系统要求减少动效时，五个时长令牌全部归零', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoHash(page, stackOf().baseUrl, HASH.login)
    await expectScreen(page, 'login')

    const durations = await durationTokens(page)
    for (const [name, ms] of Object.entries(durations)) {
      expect(ms, `${name} 在 reduced-motion 下应为 0`).toBe(0)
    }
  })

  test('减少动效时，实际过渡时长也是 0', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoHash(page, stackOf().baseUrl, HASH.login)
    await expectScreen(page, 'login')

    // body 的 background-color/color 过渡是主题切换的动效来源
    const duration = await page.evaluate(() => getComputedStyle(document.body).transitionDuration)
    expect(duration, 'body 本来就带过渡（对照组证明）').not.toBe('')
    for (const part of duration.split(',')) {
      expect(toMs(part), `transition-duration 的每一段都应为 0（实际 ${duration}）`).toBe(0)
    }
  })

  test('对照组：没有该偏好时时长令牌非零', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await gotoHash(page, stackOf().baseUrl, HASH.login)
    await expectScreen(page, 'login')

    const durations = await durationTokens(page)
    // tokens.css §7：微交互 140–220ms，复杂过渡 ≤360ms
    expect(durations['--dur-base']).toBe(220)
    expect(durations['--dur-instant']).toBe(80)
    expect(durations['--dur-slow']).toBe(360)
  })
})
