import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, dayStartInstant, toIsoInZone } from '@shared/time'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import {
  api,
  createMemberAccount,
  createOwnerAccount,
  createTaskViaApi,
  startTestServer,
  todayKey,
  type Account,
  type TestContext,
} from './helpers.js'

let ctx: TestContext
let owner: Account
let seq = 0

beforeAll(async () => {
  ctx = await startTestServer()
  owner = await createOwnerAccount(ctx)
})

afterAll(async () => {
  await ctx.close()
})

async function freshAccount(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `completed${seq}`)
}

function completedList(account: Account) {
  return api(ctx, 'GET', '/api/tasks?scope=completed', { token: account.token })
}

describe('GET /api/tasks?scope=completed', () => {
  it('当前账号的普通任务完成后仅一行，另一账号看不到；撤销批次后消失', async () => {
    const a = await freshAccount()
    const b = await freshAccount()
    const task = await createTaskViaApi(ctx, a.token)
    const done = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: a.token,
    })
    expect(done.status).toBe(200)
    const listA = await completedList(a)
    expect(listA.status).toBe(200)
    expect(listA.body.items).toHaveLength(1)
    expect(listA.body.items[0]).toMatchObject({
      taskId: task.taskId,
      occurrenceKey: task.indexDate,
      scheduledOccurrenceDate: null,
    })
    expect(listA.body.items[0].completedAt).not.toBeNull()
    expect((await completedList(b)).body.items).toEqual([])

    const completion = readAccountEvents(ctx.db, a.id).find((event) => event.type === 'task/occurrence-completed')!
    const undo = await api(ctx, 'POST', '/api/undo', {
      token: a.token,
      body: { batchId: completion.batchId },
    })
    expect(undo.status).toBe(200)
    expect((await completedList(a)).body.items).toEqual([])
  })

  it('重复任务移除规则后保留多个有效历史轮次；仅本账号可取消，旧键不可重新完成', async () => {
    const account = await freshAccount()
    const yesterday = addDays(todayKey(), -1)
    const task = await createTaskViaApi(ctx, account.token, {
      title: '每日复盘',
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: yesterday,
      },
    })
    const settings = loadAccountSettings(ctx.db, account.id)
    const historicInstant = new Date(dayStartInstant(yesterday, timeContextOf(settings)).getTime() + 4 * 60 * 60 * 1000)
    ctx.db.transaction(() => appendEvents(ctx.db, account.id, [{
      type: 'task/occurrence-completed',
      occurredAt: toIsoInZone(historicInstant, settings.timeZone),
      dayKey: yesterday,
      dayStartHour: settings.dayStartHour,
      payload: {
        taskId: task.taskId,
        originalPlannedDate: yesterday,
        completedDayKey: yesterday,
        next: { date: todayKey(), mode: 'catch_up' },
      },
    }]))()

    const todayDone = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${todayKey()}/complete`, {
      token: account.token,
    })
    expect(todayDone.status).toBe(200)
    const abandoned = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    expect(abandoned.status).toBe(200)

    const list = await completedList(account)
    expect(list.status).toBe(200)
    expect(list.body.items.map((item: any) => item.occurrenceKey)).toEqual([todayKey(), yesterday])
    expect(list.body.items.every((item: any) => item.taskId === task.taskId && item.status === 'abandoned')).toBe(true)
    expect(list.body.items[0].completedAt).not.toBeNull()
    expect(list.body.items[1].completedAt).not.toBeNull()

    const removedRule = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}`, {
      token: account.token,
      body: { recurrence: null },
    })
    expect(removedRule.status).toBe(200)
    expect(removedRule.body.task.recurring).toBe(false)
    expect((await completedList(account)).body.items.map((item: any) => item.occurrenceKey))
      .toEqual([todayKey(), yesterday])

    const anotherAccount = await freshAccount()
    const foreignCorrection = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${yesterday}/uncomplete`, {
      token: anotherAccount.token,
    })
    expect(foreignCorrection.status).toBe(404)

    const corrected = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${yesterday}/uncomplete`, {
      token: account.token,
    })
    expect(corrected.status).toBe(200)
    expect((await completedList(account)).body.items.map((item: any) => item.occurrenceKey)).toEqual([todayKey()])

    const invalidReplay = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${yesterday}/complete`, {
      token: account.token,
    })
    expect(invalidReplay.status).toBe(404)
  })

  it('未来才开始的重复任务返回真实未来排期，不把 indexDate 或未来轮次当成已完成', async () => {
    const account = await freshAccount()
    const start = addDays(todayKey(), 4)
    const task = await createTaskViaApi(ctx, account.token, {
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: start,
      },
    })
    const all = await api(ctx, 'GET', '/api/tasks?scope=all', { token: account.token })
    expect(all.status).toBe(200)
    expect(all.body.items[0]).toMatchObject({
      taskId: task.taskId,
      occurrenceKey: task.indexDate,
      scheduledOccurrenceDate: start,
      pending: false,
    })
    expect((await completedList(account)).body.items).toEqual([])
  })
})
