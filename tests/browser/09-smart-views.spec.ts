import { expect, test, type Browser, type Page } from '@playwright/test'
import { addDays, dayStartInstant, toIsoInZone, weekStart } from '@shared/time'
import { openDatabase } from '../../server/db/index'
import { appendEvents } from '../../server/events/append'
import { loadAccountSettings, timeContextOf } from '../../server/events/settings'
import { call, createProject, createTask, itemByTitle, listTasks, seedOwner } from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'

function rowOf(page: Page, title: string) {
  return page.locator('.ta-tasks__row').filter({ hasText: title })
}

async function visit(page: Page, baseUrl: string, token: string): Promise<void> {
  await signInAs(page, token)
  await gotoHash(page, baseUrl, HASH.tasks)
  await expectScreen(page, 'tasks')
}

async function openView(page: Page, name: '我的一天' | '计划' | '全部任务' | '已完成'): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
}

async function quickAdd(page: Page, title: string): Promise<void> {
  await page.getByLabel('写点什么').fill(title)
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByTestId('quick-add-feedback')).toContainText('已添加')
}

test.describe.serial('智能视图与我的一天', () => {
  const stackOf = useStack()
  let browser: Browser
  let token = ''
  let ownerId = ''
  let today = ''

  test.beforeAll(async ({ browser: fixtureBrowser }) => {
    browser = fixtureBrowser
    const owner = await seedOwner(stackOf())
    token = owner.token
    ownerId = owner.user.id
    today = (await listTasks(stackOf(), token, 'all')).today
  })

  test('我的一天直接新增无日期任务；移出后任务仍在全部', async () => {
    const page = await browser.newPage({ locale: 'zh-CN' })
    try {
      await visit(page, stackOf().baseUrl, token)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('我的一天')
      await quickAdd(page, '无日期的今日选择')
      await expect(rowOf(page, '无日期的今日选择')).toHaveCount(1)
      await expect(page.getByLabel('我的一天进度')).toContainText('0 / 1')
      const taskRow = rowOf(page, '无日期的今日选择')
      await expect(taskRow.getByRole('checkbox')).toHaveCount(1)
      await expect(taskRow.getByRole('checkbox', { name: '完成《无日期的今日选择》', exact: true })).toBeVisible()
      await taskRow.getByRole('button', { name: '查看《无日期的今日选择》详情' }).click()
      await taskRow.getByRole('button', { name: '将《无日期的今日选择》标为重要' }).click()
      await expect(taskRow.getByRole('button', { name: '取消《无日期的今日选择》的重要标记' })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('button', { name: '取消重要标记', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await openView(page, '全部任务')
      await expect(rowOf(page, '无日期的今日选择')).toHaveCount(1)
      await rowOf(page, '无日期的今日选择').getByRole('button', { name: '取消《无日期的今日选择》的重要标记' }).click()
      await expect(rowOf(page, '无日期的今日选择').getByRole('button', { name: '将《无日期的今日选择》标为重要' })).toBeVisible()
      await openView(page, '我的一天')
      await expect(rowOf(page, '无日期的今日选择')).toHaveCount(1)
      await page.getByRole('button', { name: '批量选择', exact: true }).click()
      await expect(taskRow.getByRole('checkbox')).toHaveCount(1)
      await expect(taskRow.getByRole('checkbox', { name: /^选中/ })).toBeVisible()
      await page.getByRole('button', { name: '退出批量选择', exact: true }).click()
      await expect(taskRow.getByRole('checkbox', { name: '完成《无日期的今日选择》', exact: true })).toBeVisible()
      await page.screenshot({ path: 'docs/mockups/todo-smart-views-desktop.png', fullPage: true })

      const item = itemByTitle(await listTasks(stackOf(), token, 'all'), '无日期的今日选择')
      expect(item.plannedDate).toBeNull()
      expect(item.plannedWeek).toBeNull()
      expect(item.dueDate).toBeNull()

      await rowOf(page, '无日期的今日选择').getByRole('button', { name: '从我的一天移除《无日期的今日选择》' }).click()
      await expect(rowOf(page, '无日期的今日选择')).toHaveCount(0)
      await openView(page, '全部任务')
      await expect(rowOf(page, '无日期的今日选择')).toHaveCount(1)
      await openView(page, '计划')
      await page.getByRole('group', { name: '计划时间筛选' }).getByRole('button', { name: '未安排' }).click()
      await expect(rowOf(page, '无日期的今日选择')).toHaveCount(1)
    } finally { await page.close() }
  })

  test('加入我的一天首次失败后重试只补关系，不重复创建任务', async () => {
    const page = await browser.newPage({ locale: 'zh-CN' })
    let createRequests = 0
    let focusAttempts = 0
    try {
      await visit(page, stackOf().baseUrl, token)
      await page.route('**/api/tasks', async (route) => {
        if (route.request().method() === 'POST') createRequests += 1
        await route.continue()
      })
      await page.route('**/api/focus/today/**', async (route) => {
        if (route.request().method() !== 'PUT') return route.continue()
        focusAttempts += 1
        if (focusAttempts === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
            error: { code: 'server/internal-error', message: '模拟聚焦写入失败' },
          }) })
        } else await route.continue()
      })

      await page.getByLabel('写点什么').fill('重试只补今日选择')
      await page.getByRole('button', { name: '添加', exact: true }).click()
      await expect(page.getByTestId('quick-add-feedback')).toContainText('已创建，但加入我的一天失败')
      await expect(rowOf(page, '重试只补今日选择')).toHaveCount(0)
      expect(createRequests).toBe(1)
      expect((await listTasks(stackOf(), token, 'all')).items.filter((item) => item.title === '重试只补今日选择')).toHaveLength(1)

      await page.getByRole('button', { name: '重试加入' }).click()
      await expect(page.getByTestId('quick-add-feedback')).toContainText('已加入我的一天')
      await expect(rowOf(page, '重试只补今日选择')).toHaveCount(1)
      expect(createRequests).toBe(1)
      expect(focusAttempts).toBe(2)
    } finally { await page.close() }
  })

  test('新建星标保存重要性且不再提供重要视图', async () => {
    const page = await browser.newPage({ locale: 'zh-CN' })
    try {
      await visit(page, stackOf().baseUrl, token)
      await openView(page, '全部任务')
      await expect(page.getByRole('button', { name: '重要', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click()
      await page.getByLabel('写点什么').fill('需要优先处理')
      await page.getByRole('button', { name: '标为重要', exact: true }).click()
      await page.getByRole('button', { name: '添加', exact: true }).click()
      await expect(rowOf(page, '需要优先处理').locator('.ta-tasks__star')).toBeVisible()
      await openView(page, '全部任务')
      await expect(rowOf(page, '需要优先处理')).toHaveCount(1)
      expect((await listTasks(stackOf(), token, 'all')).items.filter((item) => item.title === '需要优先处理')).toHaveLength(1)
    } finally { await page.close() }
  })

  test('计划本周上下文新增使用计划周，不伪装成计划日', async () => {
    const page = await browser.newPage({ locale: 'zh-CN' })
    try {
      await visit(page, stackOf().baseUrl, token)
      await openView(page, '计划')
      const periods = page.getByRole('group', { name: '计划时间筛选' })
      await periods.getByRole('button', { name: '本周' }).click()
      await quickAdd(page, '整理资料归档')
      await expect(rowOf(page, '整理资料归档')).toHaveCount(1)
      const item = itemByTitle(await listTasks(stackOf(), token, 'all'), '整理资料归档')
      expect(item.plannedWeek).toBe(weekStart(today))
      expect(item.plannedDate).toBeNull()
      await periods.getByRole('button', { name: '今天' }).click()
      await expect(rowOf(page, '整理资料归档')).toHaveCount(0)
    } finally { await page.close() }
  })

  test('完成日不会进入计划；未来重复预览不可完成、勾步骤或加入我的一天', async () => {
    const completedId = '0198b000-0000-7000-8000-000000000001'
    await createTask(stackOf(), token, { taskId: completedId, title: '无计划但今日完成' })
    const created = itemByTitle(await listTasks(stackOf(), token, 'all'), '无计划但今日完成')
    const complete = await call(stackOf(), `/api/tasks/${completedId}/occurrences/${created.occurrenceKey}/complete`, { method: 'POST', token })
    expect(complete.status).toBe(200)

    const futureId = '0198b000-0000-7000-8000-000000000002'
    const startsOn = addDays(today, 10)
    const future = await call(stackOf(), '/api/tasks', { method: 'POST', token, body: {
      taskId: futureId, title: '未来重复预览',
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn },
      steps: [{ id: '0198b000-0000-7000-8000-0000000000a1', title: '预览步骤' }],
    } })
    expect(future.status).toBe(200)

    const page = await browser.newPage({ locale: 'zh-CN' })
    try {
      await visit(page, stackOf().baseUrl, token)
      await openView(page, '计划')
      const periods = page.getByRole('group', { name: '计划时间筛选' })
      await periods.getByRole('button', { name: '今天' }).click()
      await expect(rowOf(page, '无计划但今日完成')).toHaveCount(0)
      await periods.getByRole('button', { name: '已安排' }).click()
      await expect(rowOf(page, '无计划但今日完成')).toHaveCount(0)
      await periods.getByRole('button', { name: '以后' }).click()
      const preview = rowOf(page, '未来重复预览')
      await expect(preview).toHaveCount(1)
      await expect(preview).toContainText('下一轮')
      await expect(preview.getByTestId(/^bucket-/)).toHaveText('以后')
      await expect(preview.getByTestId(/^bucket-/)).not.toHaveText('无日期')
      await expect(preview.getByRole('checkbox', { name: '完成《未来重复预览》' })).toBeDisabled()
      await preview.getByRole('button', { name: '详情', exact: true }).click()
      await expect(page.getByRole('region', { name: '任务步骤' }).getByRole('checkbox', { name: /预览步骤/ })).toBeDisabled()
      await expect(preview.getByRole('button', { name: '将《未来重复预览》加入我的一天' })).toBeDisabled()
    } finally { await page.close() }
  })

  test('已完成专用视图列出重复任务全部有效轮次', async () => {
    const taskId = '0198b000-0000-7000-8000-000000000003'
    const keys = [addDays(today, -2), addDays(today, -1), today]
    const created = await call(stackOf(), '/api/tasks', { method: 'POST', token, body: {
      taskId, title: '连续三轮完成', recurrence: {
        rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'extend', startsOn: keys[0],
      },
    } })
    expect(created.status).toBe(200)
    // 轮次推导只保留截至今天的最后一个待完成日。借 harness 临时库导入两条
    // 已固化的历史事件，再通过真实 API 完成今天这一轮；绝不触碰真实数据库。
    const db = openDatabase(stackOf().dbPath)
    try {
      const settings = loadAccountSettings(db, ownerId)
      db.transaction(() => appendEvents(db, ownerId, keys.slice(0, 2).map((key, index) => {
        const instant = new Date(dayStartInstant(key, timeContextOf(settings)).getTime() + 4 * 60 * 60 * 1000)
        return {
          type: 'task/occurrence-completed' as const,
          occurredAt: toIsoInZone(instant, settings.timeZone),
          dayKey: key,
          dayStartHour: settings.dayStartHour,
          payload: {
            taskId, originalPlannedDate: key, completedDayKey: key,
            next: { date: keys[index + 1]!, mode: 'extend' as const },
          },
        }
      })))()
    } finally { db.close() }
    const finalRound = await call(stackOf(), `/api/tasks/${taskId}/occurrences/${today}/complete`, { method: 'POST', token })
    expect(finalRound.status).toBe(200)

    const page = await browser.newPage({ locale: 'zh-CN' })
    try {
      await visit(page, stackOf().baseUrl, token)
      await openView(page, '已完成')
      const rows = rowOf(page, '连续三轮完成')
      await expect(rows).toHaveCount(3)
      expect(await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-occurrence-key')).sort())).toEqual([...keys].sort())
    } finally { await page.close() }
  })

  test('375px 可以到达四个智能视图、具体项目和已完成', async () => {
    const projectId = '0198b000-0000-7000-8000-000000000004'
    await createProject(stackOf(), token, { projectId, name: '移动端项目', startsOn: today, endsOn: addDays(today, 30) })
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 375, height: 812 } })
    try {
      await visit(page, stackOf().baseUrl, token)
      const picker = page.getByRole('combobox', { name: '切换任务视图' })
      await expect(picker).toBeVisible()
      for (const [value, heading] of [
        ['focus', '我的一天'], ['planned', '计划'],
        ['all', '全部任务'], [`project:${projectId}`, '移动端项目'], ['completed', '已完成'],
      ] as const) {
        await picker.selectOption(value)
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
        if (value === 'planned') await page.screenshot({ path: 'docs/mockups/todo-smart-views-mobile.png', fullPage: true })
      }
    } finally { await page.close() }
  })
  test('今天安排自动加入；手动移出持久生效，星号不改排期', async () => {
    const page = await browser.newPage({ locale: 'zh-CN' })
    try {
      await visit(page, stackOf().baseUrl, token)
      await openView(page, '全部任务')
      await quickAdd(page, '今天 自动纳入日计划')
      await openView(page, '我的一天')
      const row = rowOf(page, '自动纳入日计划')
      await expect(row).toHaveCount(1)
      const before = itemByTitle(await listTasks(stackOf(), token, 'all'), '自动纳入日计划')
      expect(before.plannedDate).toBe(today)
      await row.getByRole('button', { name: '将《自动纳入日计划》标为重要' }).click()
      await expect(row.getByRole('button', { name: '取消《自动纳入日计划》的重要标记' })).toHaveAttribute('aria-pressed', 'true')
      const after = itemByTitle(await listTasks(stackOf(), token, 'all'), '自动纳入日计划')
      expect(after.plannedDate).toBe(before.plannedDate)
      expect(after.occurrenceKey).toBe(before.occurrenceKey)
      await row.getByRole('button', { name: '从我的一天移除《自动纳入日计划》' }).click()
      await expect(row).toHaveCount(0)
      await page.reload()
      await expect(row).toHaveCount(0)
      await openView(page, '全部任务')
      await row.getByRole('button', { name: '将《自动纳入日计划》加入我的一天' }).click()
      await openView(page, '我的一天')
      await expect(row).toHaveCount(1)
      await row.getByRole('checkbox', { name: '完成《自动纳入日计划》', exact: true }).click()
      await expect(row.getByRole('checkbox', { name: '取消完成《自动纳入日计划》', exact: true })).toBeChecked()
      expect(itemByTitle(await listTasks(stackOf(), token, 'all'), '自动纳入日计划').importance).toBe('high')
      await openView(page, '已完成')
      await expect(row).toHaveCount(1)
    } finally { await page.close() }
  })

})
