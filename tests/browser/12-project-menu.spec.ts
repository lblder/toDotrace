import { expect, test, type Browser, type Page } from '@playwright/test'
import { addDays } from '@shared/time'
import { call, createProject, createTask, listTasks, seedOwner } from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'

test.describe.serial('项目菜单与归档', () => {
  const stackOf = useStack()
  let browser: Browser
  let token: string
  const projectId = '0198d000-0000-7000-8000-000000000001'
  const nav = (page: Page) => page.getByRole('navigation', { name: '我的项目', exact: true })
  test.beforeAll(async ({ browser: fixtureBrowser }) => {
    browser = fixtureBrowser
    token = (await seedOwner(stackOf())).token
    const today = (await listTasks(stackOf(), token, 'all')).today
    await createProject(stackOf(), token, { projectId, name: '菜单测试项目', startsOn: today, endsOn: addDays(today, 30) })
    await createTask(stackOf(), token, { taskId: '0198d000-0000-7000-8000-000000000002', title: '归档后保留的任务', projectId })
  })
  async function visit() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    await signInAs(page, token)
    await gotoHash(page, stackOf().baseUrl, HASH.tasks)
    await expectScreen(page, 'tasks')
    return page
  }
  test('右键重命名、归档后隐藏且任务保留，刷新后可恢复', async () => {
    const page = await visit()
    try {
      await nav(page).getByRole('button', { name: '菜单测试项目', exact: true }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '重命名项目' }).click()
      const dialog = page.getByRole('dialog', { name: '重命名项目' })
      await dialog.getByRole('textbox', { name: '项目名称' }).fill('重命名后的项目')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const project = nav(page).getByRole('button', { name: '重命名后的项目', exact: true })
      await expect(project).toBeVisible()
      await project.click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('重命名后的项目')
      await expect(page.locator('.ta-tasks__row').filter({ hasText: '归档后保留的任务' })).toContainText('重命名后的项目')
      await project.click({ button: 'right' })
      await page.screenshot({ path: 'docs/mockups/project-context-menu.png', fullPage: true })
      await page.getByRole('menuitem', { name: '归档项目' }).click()
      await expect(project).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('全部任务')
      await expect(page.locator('.ta-tasks__row').filter({ hasText: '归档后保留的任务' })).toBeVisible()
      await page.reload()
      await expect(project).toHaveCount(0)
      await page.getByRole('button', { name: '管理项目', exact: true }).click()
      await expect(page.getByRole('button', { name: '设为当前', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^删除项目/ })).toHaveCount(0)
      await page.getByText('已归档项目', { exact: true }).click()
      await page.getByRole('button', { name: '项目「重命名后的项目」的操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '恢复项目' }).click()
      await expect(project).toBeVisible()
      const projects = await call<{ projects: { projectId: string; archived: boolean }[] }>(stackOf(), '/api/projects', { token })
      expect(projects.body.projects.find((item) => item.projectId === projectId)?.archived).toBe(false)
      const tasks = await listTasks(stackOf(), token, 'all')
      expect(tasks.items.find((item) => item.title === '归档后保留的任务')?.projectId).toBe(projectId)
    } finally { await page.close() }
  })
  test('键盘菜单与重命名失败保持输入，可取消退出', async () => {
    const page = await visit()
    try {
      const project = nav(page).getByRole('button', { name: '重命名后的项目', exact: true })
      await project.focus()
      await page.keyboard.press('Shift+F10')
      await expect(page.getByRole('menu')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(project).toBeFocused()
      await nav(page).getByRole('button', { name: '项目「重命名后的项目」的操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '重命名项目' }).click()
      await page.route(`**/api/projects/${projectId}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server/internal-error', message: '模拟重命名失败' } }) }))
      const dialog = page.getByRole('dialog', { name: '重命名项目' })
      await dialog.getByRole('textbox', { name: '项目名称' }).fill('暂未保存的名称')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog.getByRole('alert')).toContainText('模拟重命名失败')
      await expect(dialog.getByRole('textbox')).toHaveValue('暂未保存的名称')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(project).toBeVisible()
    } finally { await page.close() }
  })
})
