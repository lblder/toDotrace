import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, weekStart } from '@shared/time'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { rebuildProjection } from '../events/rebuild.js'
import { readProjection } from '../events/projection-store.js'
import { addToFocusToday, focusToday } from '../focus/service.js'
import {
  api,
  countEventsOfType,
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
  return createMemberAccount(ctx, owner.token, `focus${seq}`)
}

function path(taskId: string, occurrenceKey: string): string {
  return `/api/focus/today/${taskId}/${occurrenceKey}`
}

describe('今日聚焦：事件派生的任务实例集合', () => {
  it('自动收录今天计划或今天到期的普通任务，排除周计划、逾期及昨日已完成项', async () => {
    const account = await freshAccount()
    const other = await freshAccount()
    const today = todayKey()
    const planned = await createTaskViaApi(ctx, account.token, { title: '今天计划', plannedDate: today })
    const due = await createTaskViaApi(ctx, account.token, { title: '今天到期', dueDate: today })
    const both = await createTaskViaApi(ctx, account.token, { plannedDate: today, dueDate: today })
    await createTaskViaApi(ctx, account.token, { plannedWeek: weekStart(today) })
    await createTaskViaApi(ctx, account.token, { plannedDate: addDays(today, -1) })
    await createTaskViaApi(ctx, account.token, { dueDate: addDays(today, 1) })
    const doneYesterday = await createTaskViaApi(ctx, account.token, { dueDate: today })
    const yesterday = addDays(today, -1)
    ctx.db.transaction(() => appendEvents(ctx.db, account.id, [{
      type: 'task/occurrence-completed',
      occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
      dayKey: yesterday,
      dayStartHour: 4,
      payload: {
        taskId: doneYesterday.taskId,
        originalPlannedDate: doneYesterday.indexDate,
        completedDayKey: yesterday,
        next: null,
      },
    }]))()

    const before = (await api(ctx, 'GET', `/api/tasks/${planned.taskId}`, { token: account.token })).body.task
    const focus = await api(ctx, 'GET', '/api/focus/today', { token: account.token })
    expect(focus.status).toBe(200)
    expect(focus.body.items).toEqual(expect.arrayContaining([
      { taskId: planned.taskId, occurrenceKey: planned.indexDate },
      { taskId: due.taskId, occurrenceKey: due.indexDate },
      { taskId: both.taskId, occurrenceKey: both.indexDate },
    ]))
    expect(focus.body.items).toHaveLength(3)
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(0)
    expect((await api(ctx, 'GET', `/api/tasks/${planned.taskId}`, { token: account.token })).body.task)
      .toEqual(before)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: other.token })).body.items).toEqual([])

    const completed = await api(ctx, 'POST', `/api/tasks/${planned.taskId}/occurrences/${planned.indexDate}/complete`, {
      token: account.token,
    })
    expect(completed.status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .toContainEqual({ taskId: planned.taskId, occurrenceKey: planned.indexDate })
  })

  it('自动任务移出后本日保持排除，重新加入可恢复完成项；撤销移除与次日重置', async () => {
    const account = await freshAccount()
    const today = todayKey()
    const task = await createTaskViaApi(ctx, account.token, {
      plannedDate: today,
      dueDate: addDays(today, 1),
    })
    const focusPath = path(task.taskId, task.indexDate)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .toContainEqual({ taskId: task.taskId, occurrenceKey: task.indexDate })
    const removed = await api(ctx, 'DELETE', focusPath, { token: account.token })
    expect(removed.status).toBe(200)
    expect(removed.body.items).toEqual([])
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items).toEqual([])
    expect((await api(ctx, 'DELETE', focusPath, { token: account.token })).body.items).toEqual([])
    expect(countEventsOfType(ctx, account.id, 'task/focus-removed')).toBe(1)

    const firstRemoval = readAccountEvents(ctx.db, account.id)
      .find((event) => event.type === 'task/focus-removed')!
    expect((await api(ctx, 'POST', '/api/undo', {
      token: account.token,
      body: { batchId: firstRemoval.batchId },
    })).status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .toContainEqual({ taskId: task.taskId, occurrenceKey: task.indexDate })
    expect((await api(ctx, 'DELETE', focusPath, { token: account.token })).body.items).toEqual([])

    const completed = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: account.token,
    })
    expect(completed.status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items).toEqual([])
    const restored = await api(ctx, 'PUT', focusPath, { token: account.token })
    expect(restored.status).toBe(200)
    expect(restored.body.items).toEqual([{ taskId: task.taskId, occurrenceKey: task.indexDate }])
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(1)

    await api(ctx, 'DELETE', focusPath, { token: account.token })
    const lastRemoval = readAccountEvents(ctx.db, account.id)
      .filter((event) => event.type === 'task/focus-removed').at(-1)!
    expect((await api(ctx, 'POST', '/api/undo', {
      token: account.token,
      body: { batchId: lastRemoval.batchId },
    })).status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .toContainEqual({ taskId: task.taskId, occurrenceKey: task.indexDate })

    const resetTask = await createTaskViaApi(ctx, account.token, {
      plannedDate: today,
      dueDate: addDays(today, 1),
    })
    await api(ctx, 'DELETE', path(resetTask.taskId, resetTask.indexDate), { token: account.token })
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .not.toContainEqual({ taskId: resetTask.taskId, occurrenceKey: resetTask.indexDate })
    const tomorrow = focusToday(ctx.db, account.id, new Date(Date.now() + 86_400_000))
    expect(tomorrow.dayKey).toBe(addDays(today, 1))
    // 当日排除次日重置；已在昨日完成的另一任务不因明天到期而误入。
    expect(tomorrow.items).toContainEqual({ taskId: resetTask.taskId, occurrenceKey: resetTask.indexDate })
    expect(tomorrow.items).not.toContainEqual({ taskId: task.taskId, occurrenceKey: task.indexDate })
  })

  it('显式加入已自动收录的任务会钉住当日选择，改期后不退出我的一天', async () => {
    const account = await freshAccount()
    const today = todayKey()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: today })
    const before = (await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).body.task
    const added = await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: account.token })
    expect(added.status).toBe(200)
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(1)
    const again = await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: account.token })
    expect(again.status).toBe(200)
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(1)
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).body.task)
      .toEqual(before)

    expect((await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: addDays(today, 2), plannedWeek: null, dueDate: null }] },
    })).status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .toContainEqual({ taskId: task.taskId, occurrenceKey: task.indexDate })
  })

  it('重复任务只自动收录今天轮次，不把未来预览或只剩昨日轮次当作今天', async () => {
    const account = await freshAccount()
    const today = todayKey()
    const daily = await createTaskViaApi(ctx, account.token, {
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: today },
    })
    await createTaskViaApi(ctx, account.token, {
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: addDays(today, 2) },
    })
    await createTaskViaApi(ctx, account.token, {
      recurrence: { rule: { freq: 'daily', interval: 1, count: 1 }, nextAnchorMode: 'catch_up', startsOn: addDays(today, -1) },
    })
    const before = await api(ctx, 'GET', '/api/focus/today', { token: account.token })
    expect(before.body.items).toEqual([{ taskId: daily.taskId, occurrenceKey: today }])
    expect((await api(ctx, 'POST', `/api/tasks/${daily.taskId}/occurrences/${today}/complete`, {
      token: account.token,
    })).status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items)
      .toEqual([{ taskId: daily.taskId, occurrenceKey: today }])
  })
  it('加入、重复加入、移除、重复移除均返回当前集合，且只写必要的事件', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: addDays(todayKey(), 2) })
    const initial = await api(ctx, 'GET', '/api/focus/today', { token: account.token })
    expect(initial.status).toBe(200)
    expect(initial.body).toEqual({ dayKey: todayKey(), items: [] })

    const beforeTask = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    const added = await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: account.token })
    expect(added.status).toBe(200)
    expect(added.body).toEqual({
      dayKey: todayKey(),
      items: [{ taskId: task.taskId, occurrenceKey: task.indexDate }],
    })
    const again = await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: account.token })
    expect(again.body).toEqual(added.body)
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(1)

    const afterTask = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(afterTask.body.task).toEqual(beforeTask.body.task)

    const removed = await api(ctx, 'DELETE', path(task.taskId, task.indexDate), { token: account.token })
    expect(removed.status).toBe(200)
    expect(removed.body.items).toEqual([])
    const removedAgain = await api(ctx, 'DELETE', path(task.taskId, task.indexDate), { token: account.token })
    expect(removedAgain.body.items).toEqual([])
    expect(countEventsOfType(ctx, account.id, 'task/focus-removed')).toBe(1)
  })

  it('按账号隔离，跨账号任务与无效轮次一律拒绝，空请求体之外的字段也拒绝', async () => {
    const a = await freshAccount()
    const b = await freshAccount()
    const task = await createTaskViaApi(ctx, a.token)
    const foreign = await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: b.token })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe('not-found')
    expect((await api(ctx, 'GET', '/api/focus/today', { token: b.token })).body.items).toEqual([])

    const wrongRound = await api(ctx, 'PUT', path(task.taskId, addDays(task.indexDate, 1)), {
      token: a.token,
    })
    expect(wrongRound.status).toBe(404)
    const invalidDay = await api(ctx, 'PUT', path(task.taskId, '2026-02-30'), { token: a.token })
    expect(invalidDay.status).toBe(400)
    const withBody = await api(ctx, 'PUT', path(task.taskId, task.indexDate), {
      token: a.token,
      body: { accountId: b.id },
    })
    expect(withBody.status).toBe(400)
    expect(countEventsOfType(ctx, a.id, 'task/focus-added')).toBe(0)
  })

  it('聚焦记录随账号日界自然隔离，投影重建后仍可从事件恢复', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: account.token })
    const event = readAccountEvents(ctx.db, account.id).find((row) => row.type === 'task/focus-added')
    expect(event?.payload).toEqual({
      taskId: task.taskId,
      occurrenceKey: task.indexDate,
      focusDayKey: todayKey(),
    })
    expect(event?.dayKey).toBe(todayKey())
    expect(event?.targetKind).toBe('task')
    expect(event?.targetId).toBe(task.taskId)

    const before = readProjection(ctx.db, account.id)
    rebuildProjection(ctx.db, account.id)
    expect(readProjection(ctx.db, account.id)).toEqual(before)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items).toEqual([
      { taskId: task.taskId, occurrenceKey: task.indexDate },
    ])
    const future = focusToday(ctx.db, account.id, new Date(Date.now() + 3 * 86_400_000))
    expect(future.dayKey).not.toBe(todayKey())
    expect(future.items).toEqual([])
  })

  it('重复任务按原计划日区分轮次；服务端账号日界决定聚焦归属日', async () => {
    const account = await freshAccount()
    const daily = await createTaskViaApi(ctx, account.token, {
      title: '每日复盘',
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: addDays(todayKey(), -2),
      },
    })
    const detail = await api(ctx, 'GET', `/api/tasks/${daily.taskId}`, { token: account.token })
    const key = detail.body.occurrenceKey
    const selected = await api(ctx, 'PUT', path(daily.taskId, key), { token: account.token })
    expect(selected.status).toBe(200)
    expect(selected.body.items).toEqual([{ taskId: daily.taskId, occurrenceKey: key }])
    const notARound = await api(ctx, 'PUT', path(daily.taskId, addDays(key, 20)), {
      token: account.token,
    })
    expect(notARound.status).toBe(404)

    const update = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { timeZone: 'UTC', dayStartHour: 12 },
    })
    expect(update.status).toBe(200)
    const date = new Date().toISOString().slice(0, 10)
    const beforeBoundary = new Date(`${date}T10:00:00.000Z`)
    const afterBoundary = new Date(`${date}T13:00:00.000Z`)
    // 新账号设置下，10:00 UTC 仍归前一天，13:00 UTC 已归当天。
    const another = await createTaskViaApi(ctx, account.token, { title: '日界测试' })
    const atTen = ctx.db.transaction(() =>
      addToFocusToday(ctx.db, account.id, beforeBoundary, another.taskId, another.indexDate),
    )()
    expect(atTen.dayKey).toBe(addDays(date, -1))
    expect(focusToday(ctx.db, account.id, beforeBoundary).items).toContainEqual({
      taskId: another.taskId,
      occurrenceKey: another.indexDate,
    })
    expect(focusToday(ctx.db, account.id, afterBoundary).dayKey).toBe(date)
    expect(focusToday(ctx.db, account.id, afterBoundary).items).not.toContainEqual({
      taskId: another.taskId,
      occurrenceKey: another.indexDate,
    })
  })

  it('新加入拒绝已完成或已放弃；先入选后完成/放弃时重试仍幂等', async () => {
    const account = await freshAccount()
    const completed = await createTaskViaApi(ctx, account.token, { title: '先完成' })
    await api(ctx, 'POST', `/api/tasks/${completed.taskId}/occurrences/${completed.indexDate}/complete`, {
      token: account.token,
    })
    const completedAdd = await api(ctx, 'PUT', path(completed.taskId, completed.indexDate), {
      token: account.token,
    })
    expect(completedAdd.status).toBe(400)

    const abandoned = await createTaskViaApi(ctx, account.token, { title: '先放弃' })
    await api(ctx, 'POST', `/api/tasks/${abandoned.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    const abandonedAdd = await api(ctx, 'PUT', path(abandoned.taskId, abandoned.indexDate), {
      token: account.token,
    })
    expect(abandonedAdd.status).toBe(400)

    const focused = await createTaskViaApi(ctx, account.token, { title: '已选中再完成' })
    expect((await api(ctx, 'PUT', path(focused.taskId, focused.indexDate), {
      token: account.token,
    })).status).toBe(200)
    await api(ctx, 'POST', `/api/tasks/${focused.taskId}/occurrences/${focused.indexDate}/complete`, {
      token: account.token,
    })
    const retry = await api(ctx, 'PUT', path(focused.taskId, focused.indexDate), {
      token: account.token,
    })
    expect(retry.status).toBe(200)
    expect(retry.body.items).toContainEqual({ taskId: focused.taskId, occurrenceKey: focused.indexDate })
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(1)

    const focusedThenAbandoned = await createTaskViaApi(ctx, account.token, { title: '已选中再放弃' })
    await api(ctx, 'PUT', path(focusedThenAbandoned.taskId, focusedThenAbandoned.indexDate), {
      token: account.token,
    })
    await api(ctx, 'POST', `/api/tasks/${focusedThenAbandoned.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    const abandonRetry = await api(ctx, 'PUT', path(focusedThenAbandoned.taskId, focusedThenAbandoned.indexDate), {
      token: account.token,
    })
    expect(abandonRetry.status).toBe(200)
    expect(countEventsOfType(ctx, account.id, 'task/focus-added')).toBe(2)
  })

  it('撤销加入批次后，聚焦读取采用与任务投影相同的撤销边界', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'PUT', path(task.taskId, task.indexDate), { token: account.token })
    const added = readAccountEvents(ctx.db, account.id).find((row) => row.type === 'task/focus-added')!
    const undone = await api(ctx, 'POST', '/api/undo', {
      token: account.token,
      body: { batchId: added.batchId },
    })
    expect(undone.status).toBe(200)
    expect((await api(ctx, 'GET', '/api/focus/today', { token: account.token })).body.items).toEqual([])
  })
})
