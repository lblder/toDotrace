import { expect, test, type Page } from '@playwright/test'
import type { TimerSnapshot } from '@shared/timer'
import { call, listTasks, seedOwner } from './harness/api'
import { gotoHash, HASH } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'

const rowOf = (page: Page, title: string) => page.locator('.ta-tasks__row').filter({ hasText: title })

test.describe.serial('右侧任务详情与番茄计时', () => {
  const stackOf = useStack()
  let token = ''
  test.beforeAll(async () => { token = (await seedOwner(stackOf())).token })

  async function snapshot(): Promise<TimerSnapshot> {
    const response = await call<TimerSnapshot>(stackOf(), '/api/timer', { token })
    expect(response.status).toBe(200)
    return response.body
  }

  test('右侧创建、运行互斥、刷新恢复、暂停续计、完成保存用时', async ({ page }) => {
    await signInAs(page, token)
    await gotoHash(page, stackOf().baseUrl, HASH.tasks)
    await expect(page.locator('.ta-tasks__center #quick-add-input')).toHaveCount(0)
    const panel = page.getByRole('complementary', { name: '任务详情与辅助信息' })
    await panel.getByLabel('写点什么').fill('阅读计时验证')
    await panel.getByRole('checkbox', { name: /番茄计时/ }).check()
    await panel.getByRole('button', { name: '添加', exact: true }).click()
    const row = rowOf(page, '阅读计时验证')
    await expect(row).toHaveCount(1)
    const task = (await listTasks(stackOf(), token, 'all')).items.find((item) => item.title === '阅读计时验证')!
    expect((await snapshot()).tasks.find((item) => item.taskId === task.taskId)?.enabled).toBe(true)
    await row.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect.poll(async () => (await snapshot()).active?.taskId).toBe(task.taskId)
    const sessionId = (await snapshot()).active!.sessionId
    await expect(row.getByRole('button', { name: '暂停', exact: true })).toBeVisible()

    const second = await call<{ task: { taskId: string; indexDate: string } }>(stackOf(), '/api/tasks', { method: 'POST', token, body: {
      taskId: '0198c000-0000-7000-8000-000000000010', title: '另一项计时任务', pomodoroEnabled: true,
    } })
    expect(second.status).toBe(200)
    const conflict = await call(stackOf(), '/api/timer/start', { method: 'POST', token, body: {
      taskId: second.body.task.taskId, occurrenceKey: second.body.task.indexDate,
    } })
    expect(conflict.status).toBe(409)
    expect((await snapshot()).active?.sessionId).toBe(sessionId)

    await page.getByRole('link', { name: '学习轨迹', exact: true }).click()
    await expect(page.getByTestId('timer-dock')).toContainText('阅读计时验证')
    await expect(page.getByTestId('timer-dock').getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await page.getByRole('link', { name: '待办', exact: true }).click()
    await page.reload()
    await expect(row.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    expect((await snapshot()).active?.sessionId).toBe(sessionId)
    await expect.poll(async () => {
      const state = await snapshot()
      return Date.parse(state.serverNow) - Date.parse(state.active!.startedAt)
    }).toBeGreaterThanOrEqual(1000)
    await row.getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(async () => (await snapshot()).active).toBeNull()
    const stopped = (await snapshot()).sessions.find((session) => session.sessionId === sessionId)!
    expect(stopped.elapsedSeconds).toBeGreaterThanOrEqual(1)
    await row.getByRole('button', { name: '继续', exact: true }).click()
    await expect.poll(async () => (await snapshot()).active?.sessionId).not.toBe(sessionId)
    await row.getByRole('button', { name: '查看《阅读计时验证》详情', exact: true }).click()
    await expect(panel.getByRole('progressbar', { name: '当前番茄计时目标' })).toBeVisible()
    await page.screenshot({ path: 'docs/mockups/todo-timer-running.png', fullPage: true })
    await row.getByRole('button', { name: '完成任务', exact: true }).click()
    await expect.poll(async () => (await snapshot()).active).toBeNull()
    const final = await snapshot()
    const sessions = final.sessions.filter((session) => session.taskId === task.taskId)
    expect(sessions).toHaveLength(2)
    expect(sessions.reduce((total, session) => total + session.elapsedSeconds, 0)).toBeGreaterThanOrEqual(stopped.elapsedSeconds)
    await expect(row.getByRole('checkbox', { name: '取消完成《阅读计时验证》' })).toBeChecked()
    await expect(row.getByRole('button', { name: '开始任务', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '已完成', exact: true }).click()
    await expect(row.getByTestId('timer-elapsed')).toBeVisible()
    await page.screenshot({ path: 'docs/mockups/todo-timer-completed.png', fullPage: true })
  })

  test('手机新建抽屉可勾选计时；普通短任务保持直接完成', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await signInAs(page, token)
    await gotoHash(page, stackOf().baseUrl, HASH.tasks)
    await page.getByRole('button', { name: /新建任务/ }).click()
    const panel = page.getByRole('complementary', { name: '任务详情与辅助信息' })
    await expect(panel).toBeVisible()
    await panel.getByLabel('写点什么').fill('普通短任务')
    await expect(panel.getByRole('checkbox', { name: /番茄计时/ })).not.toBeChecked()
    await panel.getByRole('button', { name: '添加', exact: true }).click()
    await expect(panel.getByTestId('quick-add-feedback')).toContainText('已添加')
    await page.getByRole('button', { name: '关闭侧栏' }).click()
    const row = rowOf(page, '普通短任务')
    await expect(row).toBeVisible()
    await expect(row.getByRole('button', { name: '开始任务', exact: true })).toHaveCount(0)
    await row.getByRole('checkbox', { name: '完成《普通短任务》' }).click()
    await expect(row.getByRole('checkbox', { name: '取消完成《普通短任务》' })).toBeChecked()
  })
})
