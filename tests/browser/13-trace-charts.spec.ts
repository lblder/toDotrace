import { expect, test } from '@playwright/test'
import type { TracePayload } from '@shared/trace/types'
import { addDays } from '@shared/time'
import { call, seedOwner } from './harness/api'
import { gotoHash } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'

test.describe('Trace ECharts 时长图表', () => {
  const stackOf = useStack()
  test('日期读数、项目图例联动、主题与手机布局', async ({ page }) => {
    const token = (await seedOwner(stackOf())).token
    const response = await call<TracePayload>(stackOf(), '/api/trace?period=week&goalMinutes=360', { token })
    const data = response.body
    const values = [null, 210, 370, 120, 480, 330, 549]
    data.days = values.map((value, index) => ({ dayKey: addDays(data.today, index - 6), future: false, created: 0, completed: 0, completions: [], arrival: value === null ? null : `${addDays(data.today, index - 6)}T08:00:00+08:00`, left: value === null ? null : `${addDays(data.today, index - 6)}T18:00:00+08:00`, durationMinutes: value, durationNeedsReview: false, focusSeconds: 0 }))
    data.totals.totalDurationMinutes = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    data.totals.totalFocusSeconds = 14400
    data.focusProjects = [{ projectId: 'research', name: '论文阅读与实验', seconds: 7200 }, { projectId: 'code', name: '项目开发', seconds: 5400 }, { projectId: null, name: '未归属项目', seconds: 1800 }]
    await page.route('**/api/trace?*', route => route.fulfill({ json: data }))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await signInAs(page, token)
    await gotoHash(page, stackOf().baseUrl, '#/trace')
    const attendance = page.getByRole('region', { name: '在场时长', exact: true })
    const focus = page.getByRole('region', { name: '专注时长', exact: true })
    await expect(attendance.locator('svg')).toBeVisible()
    await expect(focus.locator('svg')).toBeVisible()
    await expect(attendance).toContainText('9h9m')
    await expect(attendance.locator('.ta-trace__dayReadout')).toContainText('9 小时 9 分')
    await page.getByLabel('查看日期的在场时长').selectOption(data.days[0]!.dayKey)
    await expect(attendance.locator('.ta-trace__dayReadout')).toContainText('未打卡')
    const project = page.getByRole('button', { name: /论文阅读与实验/ })
    await project.click()
    await expect(project).toHaveAttribute('aria-pressed', 'true')
    await expect(focus.locator('.ta-trace__donutCenter')).toContainText('50.0%')
    await expect(focus.locator('.ta-trace__donutCenter')).toContainText('2 小时 0 分')
    await expect(page.getByLabel('项目专注时长明细')).toContainText('37.5%')
    await attendance.scrollIntoViewIfNeeded()
    await page.locator('.ta-trace__supportGrid').screenshot({ path: test.info().outputPath('trace-charts-desktop.png') })
    await page.getByRole('button', { name: /切换到(亮色|暗色)主题/ }).click()
    await expect(attendance.locator('svg')).toBeVisible()
    await page.locator('.ta-trace__supportGrid').screenshot({ path: test.info().outputPath('trace-charts-theme.png') })
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(focus.locator('svg')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.locator('.ta-trace__supportGrid').screenshot({ path: test.info().outputPath('trace-charts-mobile.png') })
    expect(errors).toEqual([])
  })
})
