import { expect, test, type Browser, type Page } from '@playwright/test'
import { addDays } from '@shared/time'
import { createProject, listTasks, seedOwner } from './harness/api'
import { expectScreen, gotoHash, HASH } from './harness/routes'
import { signInAs } from './harness/session'
import { useStack } from './harness/stack'

const rows = (page: Page) => page.locator('[data-project-sort-id]')
const names = (page: Page) => rows(page).locator('.ta-tasks__sideTruncate')
async function hold(page: Page, name: string) {
  const button = page.getByRole('navigation', { name: '我的项目', exact: true }).getByRole('button', { name, exact: true })
  await button.scrollIntoViewIfNeeded()
  const box = await button.boundingBox()
  if (box === null) throw new Error('项目不在视口内')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 6)
  await expect(page.locator('.ta-tasks__sortableProject--dragging')).toHaveCount(1)
}

test.describe.serial('项目长按排序', () => {
  const stackOf = useStack()
  let browser: Browser
  let token: string
  let today: string
  test.beforeAll(async ({ browser: fixtureBrowser }) => {
    browser = fixtureBrowser
    token = (await seedOwner(stackOf())).token
    today = (await listTasks(stackOf(), token, 'all')).today
    for (let index = 1; index <= 3; index++) {
      await createProject(stackOf(), token, { projectId: `0198c000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        name: `排序项目${index}`, startsOn: today, endsOn: addDays(today, 30) })
    }
  })
  async function visit() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    await signInAs(page, token)
    await gotoHash(page, stackOf().baseUrl, HASH.tasks)
    await expectScreen(page, 'tasks')
    await expect(rows(page)).toHaveCount(3)
    return page
  }

  test('短按打开、长按拖动保存并刷新恢复，键盘排序与失败回退', async () => {
    const page = await visit()
    try {
      const initial = await names(page).allTextContents()
      await rows(page).first().click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(initial[0]!)
      const firstBox = await rows(page).first().boundingBox()
      if (firstBox === null) throw new Error('找不到项目')
      await hold(page, initial[2]!)
      await page.mouse.move(firstBox.x + 60, firstBox.y + 2, { steps: 8 })
      const saved = page.waitForResponse((response) => response.url().endsWith('/api/projects/order') && response.request().method() === 'PUT')
      await page.mouse.up()
      expect((await saved).status()).toBe(200)
      const reordered = [initial[2]!, initial[0]!, initial[1]!]
      await expect(names(page)).toHaveText(reordered)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(initial[0]!)
      await page.reload()
      await expect(names(page)).toHaveText(reordered)
      await rows(page).first().focus()
      await page.keyboard.press('Alt+ArrowDown')
      await expect(names(page)).toHaveText([initial[0]!, initial[2]!, initial[1]!])
      await expect(page.getByLabel('项目排序', { exact: true })).toHaveAttribute('aria-busy', 'false')
      await page.route('**/api/projects/order', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server/internal-error', message: '模拟保存失败' } }) }))
      await rows(page).first().focus()
      await page.keyboard.press('Alt+ArrowDown')
      await expect(page.getByRole('alert')).toContainText('排序保存失败')
      await expect(names(page)).toHaveText([initial[0]!, initial[2]!, initial[1]!])
    } finally { await page.close() }
  })

  test('触屏长按可拖动且不会误打开项目', async () => {
    const page = await visit()
    const touch = await page.context().newCDPSession(page)
    try {
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      const initial = await names(page).allTextContents()
      const first = await rows(page).first().boundingBox()
      const last = await rows(page).last().boundingBox()
      if (first === null || last === null) throw new Error('找不到项目')
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: last.x + 60, y: last.y + last.height / 2 }] })
      await expect(page.locator('.ta-tasks__sortableProject--dragging')).toHaveCount(1)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: first.x + 60, y: first.y + 2 }] })
      await expect(page.locator('.ta-tasks__projectDragGhost')).toBeVisible()
      const saved = page.waitForResponse((response) => response.url().endsWith('/api/projects/order') && response.request().method() === 'PUT')
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      expect((await saved).status()).toBe(200)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('我的一天')
      await page.reload()
      await expect(names(page)).toHaveText([initial[2]!, initial[0]!, initial[1]!])
    } finally { await touch.detach(); await page.close() }
  })

  test('Escape 取消拖动不保存；长列表在边缘自动滚动', async () => {
    const page = await visit()
    try {
      let writes = 0
      page.on('request', (request) => { if (request.url().endsWith('/api/projects/order') && request.method() === 'PUT') writes++ })
      const initial = await names(page).allTextContents()
      await hold(page, initial[0]!)
      const lastBox = await rows(page).last().boundingBox()
      if (lastBox === null) throw new Error('找不到项目')
      await page.mouse.move(lastBox.x + 50, lastBox.y + lastBox.height - 2)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(names(page)).toHaveText(initial)
      expect(writes).toBe(0)
      for (let index = 4; index <= 16; index++) {
        await createProject(stackOf(), token, { projectId: `0198c000-0000-7000-8000-${String(index).padStart(12, '0')}`,
          name: `排序项目${index}`, startsOn: today, endsOn: addDays(today, 30) })
      }
      await page.reload()
      await expect(rows(page)).toHaveCount(16)
      const firstName = (await names(page).allTextContents())[0]!
      await hold(page, firstName)
      const list = page.getByLabel('项目排序', { exact: true })
      const box = await list.boundingBox()
      if (box === null) throw new Error('找不到项目列表')
      await page.mouse.move(box.x + 60, box.y + box.height - 2)
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(150)
      await page.mouse.up()
      await expect(list).toHaveAttribute('aria-busy', 'false')
      const result = await names(page).allTextContents()
      expect(result.indexOf(firstName)).toBeGreaterThan(3)
      expect(writes).toBe(1)
      await page.reload()
      await expect(names(page)).toHaveText(result)
    } finally { await page.close() }
  })
})
