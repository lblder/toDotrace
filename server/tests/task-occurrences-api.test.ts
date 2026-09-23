import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays } from '@shared/time'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { uuidv7 } from '../lib/uuid.js'
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

/**
 * 实例的完成 / 取消完成（ADR-017 §1.1；语义见 ADR-013 §2 / §4.6 / §4.7）。
 *
 * 这一组覆盖 ADR-017 §后果 的「完成/取消」行与 ADR-015 §后果 的「取消完成」行：
 *
 * | 情形 | 期望 |
 * |---|---|
 * | 重复完成同一实例 | `409 conflict/occurrence-already-completed` |
 * | 取消一个未完成的实例 | `409 conflict/occurrence-not-completed` |
 * | 完成一个已放弃的任务 | `409 conflict/task-not-completable` |
 * | 取消后再完成 | 成功（追加事件，不是删除上一条） |
 *
 * 另有两处**契约里最容易被忽略**的断言：
 * - 这两个路由的响应里**没有 `created`**（ADR-017 §1.1：不存在「已经就是这样」的成功路径）；
 * - `:key` 必须是该任务**真实存在的实例**，否则 404（不校验就会写出一条永不显示的完成事件）。
 */

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
  return createMemberAccount(ctx, owner.token, `occ${seq}`)
}

const TODAY = todayKey()

function complete(account: Account, taskId: string, key: string) {
  return api(ctx, 'POST', `/api/tasks/${taskId}/occurrences/${key}/complete`, { token: account.token })
}

function uncomplete(account: Account, taskId: string, key: string) {
  return api(ctx, 'POST', `/api/tasks/${taskId}/occurrences/${key}/uncomplete`, { token: account.token })
}

describe('非重复任务的唯一实例（ADR-015 §2）', () => {
  it('实例键恒为 indexDate：用别的 key 完成 → 404（不写下永不显示的完成事件）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const res = await complete(account, task.taskId, addDays(TODAY, -1))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not-found')
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-completed')).toBe(0)
  })

  it('完成 → item 带 completedAt/completedDayKey；事件载荷 next === null', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '做完它', plannedDate: TODAY })
    const res = await complete(account, task.taskId, task.indexDate)
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({
      taskId: task.taskId,
      occurrenceKey: task.indexDate,
      completedDayKey: TODAY,
    })
    expect(res.body.item.completedAt).not.toBeNull()
    // **不可达的分支不该出现在契约里**：没有 created 字段
    expect(res.body).not.toHaveProperty('created')

    const event = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/occurrence-completed')!
    expect(event.payload).toEqual({
      taskId: task.taskId,
      originalPlannedDate: task.indexDate,
      completedDayKey: TODAY,
      // 非重复任务没有下一轮；「规则已终止」与它在这一字段上等价（ADR-013 §4.6）
      next: null,
    })
  })

  it('重复完成 → 409 conflict/occurrence-already-completed', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    await complete(account, task.taskId, task.indexDate)
    const again = await complete(account, task.taskId, task.indexDate)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('conflict/occurrence-already-completed')
  })

  it('取消一个未完成的实例 → 409 conflict/occurrence-not-completed', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const res = await uncomplete(account, task.taskId, task.indexDate)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/occurrence-not-completed')
  })

  it('完成 → 取消 → 完成：三次之后为已完成；中间态为未完成（防「存在即完成」的退化实现）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '反复', plannedDate: TODAY })

    await complete(account, task.taskId, task.indexDate)
    const cancelled = await uncomplete(account, task.taskId, task.indexDate)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.item.completedAt).toBeNull()
    expect(cancelled.body).not.toHaveProperty('created')

    const redone = await complete(account, task.taskId, task.indexDate)
    expect(redone.status).toBe(200)
    expect(redone.body.item.completedAt).not.toBeNull()

    // **不抹除任何历史记录**：三条事件都还在（取消完成是追加一条，不是删除上一条）
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-completed')).toBe(2)
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-uncompleted')).toBe(1)
  })

  it('`:key` 不是真实日历日 → 400', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    for (const key of ['2026-02-30', 'garbage', '2026-9-2']) {
      const res = await complete(account, task.taskId, key)
      expect(res.status, key).toBe(400)
    }
  })

  it('未知请求体字段 → 400（accountId 更是），且**一个字都不写**', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const before = readAccountEvents(ctx.db, account.id).length
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: account.token,
      body: { accountId: owner.id },
    })
    expect(res.status).toBe(400)
    expect(readAccountEvents(ctx.db, account.id)).toHaveLength(before)
  })
})

describe('重复任务的轮次（ADR-011 §4 / ADR-013 §4.6）', () => {
  /** 一条「每日」任务：`startsOn` 在两天前 → 待完成轮次 = 今天 */
  async function dailyTask(account: Account) {
    return createTaskViaApi(ctx, account.token, {
      title: '每日复盘',
      steps: [{ id: uuidv7(), title: '写日志' }],
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: addDays(TODAY, -2),
      },
    })
  }

  it('完成今天的待完成轮次：写出一条带 next 的完成事件，轮次转为已完成', async () => {
    const account = await freshAccount()
    const task = await dailyTask(account)

    const before = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(before.body.occurrenceKey).toBe(TODAY)
    expect(before.body.occurrences.filter((r: any) => r.status === 'pending')).toHaveLength(1)

    const res = await complete(account, task.taskId, TODAY)
    expect(res.status).toBe(200)
    expect(res.body.item.pending).toBe(false)

    const event = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/occurrence-completed')!
    expect(event.payload).toMatchObject({
      taskId: task.taskId,
      originalPlannedDate: TODAY,
      completedDayKey: TODAY,
      // 锚点②（catch_up，默认）：追赶到今天之后 → 明天
      next: { date: addDays(TODAY, 1), mode: 'catch_up' },
    })

    const after = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(after.body.occurrences.filter((r: any) => r.status === 'pending')).toHaveLength(0)
    expect(
      after.body.occurrences.find((r: any) => r.originalPlannedDate === TODAY).status,
    ).toBe('completed')
  })

  it('已完成的那一轮再完成一次 → 409（同一实例只能完成一次）', async () => {
    const account = await freshAccount()
    const task = await dailyTask(account)
    await complete(account, task.taskId, TODAY)
    const again = await complete(account, task.taskId, TODAY)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('conflict/occurrence-already-completed')
  })

  it('取消完成后该轮次回到待完成（`deriveRounds` 重新推它出来）', async () => {
    const account = await freshAccount()
    const task = await dailyTask(account)
    await complete(account, task.taskId, TODAY)
    const res = await uncomplete(account, task.taskId, TODAY)
    expect(res.status).toBe(200)
    expect(res.body.item).toMatchObject({ pending: true, completedAt: null })
    // 取消完成是**追加**一条事件，不是删除上一条（FR2.1）
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-completed')).toBe(1)
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-uncompleted')).toBe(1)
  })

  it('`:key` 不是该任务的轮次（如未来某天）→ 404', async () => {
    const account = await freshAccount()
    const task = await dailyTask(account)
    const res = await complete(account, task.taskId, addDays(TODAY, 30))
    expect(res.status).toBe(404)
  })

  it('取消完成一个**已删除**的任务的实例 → 允许（放弃/删除与完成态正交，§2）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    await complete(account, task.taskId, task.indexDate)
    await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })

    // 完成 → 409（已删除的任务不可完成）
    const completeDeleted = await complete(account, task.taskId, task.indexDate)
    expect(completeDeleted.status).toBe(409)
    expect(completeDeleted.body.error.code).toBe('conflict/task-not-completable')

    // 取消完成 → 允许（误点完成需要一个更正入口；历史不因为删除而消失）
    const res = await uncomplete(account, task.taskId, task.indexDate)
    expect(res.status).toBe(200)
    expect(res.body.item.completedAt).toBeNull()
  })

  it('已完成过若干轮的重复任务：历史轮次逐条保留（不串轮、不抹除）', async () => {
    const account = await freshAccount()
    const task = await dailyTask(account)
    // 播种两个较早的轮次（真实日子里它们才可能被完成）
    for (const [key, next] of [
      [addDays(TODAY, -2), addDays(TODAY, -1)],
      [addDays(TODAY, -1), TODAY],
    ] as [string, string][]) {
      ctx.db.transaction(() =>
        appendEvents(ctx.db, account.id, [
          {
            type: 'task/occurrence-completed',
            occurredAt: `${key}T09:00:00+08:00`,
            payload: {
              taskId: task.taskId,
              originalPlannedDate: key,
              completedDayKey: key,
              next: { date: next, mode: 'catch_up' },
            },
          },
        ]),
      )()
    }

    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    const completed = detail.body.occurrences.filter((r: any) => r.status === 'completed')
    expect(completed.map((r: any) => r.originalPlannedDate)).toEqual([
      addDays(TODAY, -2),
      addDays(TODAY, -1),
    ])
    // 完成态按**各自的轮次**归属：今天的轮次仍是待完成
    expect(detail.body.occurrenceKey).toBe(TODAY)

    // 缝合不串轮：今日列表里这一行是「今天该做还没做」，不是「已完成」
    const today = await api(ctx, 'GET', '/api/tasks?scope=today', { token: account.token })
    const row = today.body.items.find((item: any) => item.taskId === task.taskId)
    expect(row.occurrenceKey).toBe(TODAY)
    expect(row.completedAt).toBeNull()
    expect(row.pending).toBe(true)
  })
})
