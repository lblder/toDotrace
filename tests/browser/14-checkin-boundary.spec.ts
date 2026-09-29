import { expect, test } from '@playwright/test'
import { useStack } from './harness/stack'
import { call, seedOwner } from './harness/api'
import { signInAs } from './harness/session'
import { addDays, toDayKey, dayStartInstant, toIsoInZone } from '../../shared/time'
import { openMigratedDatabase } from '../../server/db/index'
import { appendEvents } from '../../server/events/append'

test.describe('日界收尾与修正', () => {
  const stackOf = useStack()
  test('过期到访自动结束，时间环拖动、手动输入、保存后今日仍可打卡', async ({ page }) => {
    const stack = stackOf()
    const owner = await seedOwner(stack)
    const ctx = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }
    const yesterday = addDays(toDayKey(new Date(), ctx), -1)
    const arrival = new Date(dayStartInstant(yesterday, ctx).getTime() + 6 * 3600000)
    const db = openMigratedDatabase(stack.dbPath)
    db.transaction(() => appendEvents(db, owner.user.id, [
      { type: 'settings/updated', occurredAt: toIsoInZone(arrival, ctx.timeZone), payload: ctx },
      { type: 'checkin/arrived', occurredAt: toIsoInZone(arrival, ctx.timeZone), payload: {} },
    ]))()
    db.close()
    await signInAs(page, owner.token)
    await page.goto(`${stack.baseUrl}/#/checkin`)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`${yesterday} 未在日界前记录离开`)
    await dialog.getByRole('button', { name: '修正时间' }).click()
    const ring = dialog.getByRole('slider', { name: '离开时间' })
    await ring.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(ring).toHaveAttribute('aria-valuetext', /03:59$/)
    const box = (await ring.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(ring).toHaveAttribute('aria-valuetext', /18:00$/)
    await page.screenshot({ path: '/tmp/todoagent-departure-ring.png' })
    await dialog.getByLabel('离开日期与时间').fill(`${yesterday}T18:30`)
    await dialog.getByRole('button', { name: '保存修正' }).click()
    await expect(dialog).toHaveCount(0)
    const days = await call<{ days: { arrivedAt: string; leftAt: string }[] }>(stack, `/api/checkin/days?from=${yesterday}&to=${yesterday}`, { token: owner.token })
    expect(days.body.days[0]?.arrivedAt).toBe(toIsoInZone(arrival, ctx.timeZone))
    expect(days.body.days[0]?.leftAt).toBe(`${yesterday}T18:30:00+08:00`)
    await page.getByRole('button', { name: '到达实验室', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂离实验室', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
