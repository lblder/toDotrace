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
 * 步骤（ADR-017 §1.2；语义见 ADR-013 §4.9–§4.13）。
 *
 * 三条本组重点覆盖的契约：
 *
 * 1. **`toggle` 必须带 `originalPlannedDate`**（§1.2）：省略即 400，
 *    **不回落成「任务的 `indexDate`」**——那个回落对单轮任务看起来正常，
 *    对重复任务则每次都在勾第一轮，症状是「勾了没反应」；
 * 2. **`order` 集合必须相等**（§3）：少一个 / 多一个 / 有重复都 400，
 *    **集合相同而顺序不同必须成功**（那正是这条路由的用途）；
 * 3. **勾选属于某一轮实例**（§4.12），定义属于任务：删掉定义**不删勾选**
 *    （所以误删可撤销——撤销删除批次后勾选原样回来）。
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
  return createMemberAccount(ctx, owner.token, `step${seq}`)
}

const TODAY = todayKey()

function addStep(account: Account, taskId: string, title: string) {
  return api(ctx, 'POST', `/api/tasks/${taskId}/steps`, { token: account.token, body: { title } })
}

describe('POST /api/tasks/:id/steps（追加到末尾）', () => {
  it('逐条追加，顺序就是定义顺序；步骤 id 由服务端生成（UUIDv7）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '有步骤' })
    await addStep(account, task.taskId, '第一步')
    const res = await addStep(account, task.taskId, '第二步')
    expect(res.status).toBe(200)
    expect(res.body.task.steps.map((s: any) => s.title)).toEqual(['第一步', '第二步'])
    for (const step of res.body.task.steps) {
      expect(step.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })

  it('title 为空 → 400；未知字段 / accountId → 400', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    expect((await addStep(account, task.taskId, '')).status).toBe(400)
    const withAccount = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps`, {
      token: account.token,
      body: { title: '步骤', accountId: owner.id },
    })
    expect(withAccount.status).toBe(400)
    expect(countEventsOfType(ctx, account.id, 'task/step-added')).toBe(0)
  })

  it('100 条是上限：第 100 条成功、第 101 条 400（否则绕过上限只需点 100 次）', async () => {
    const account = await freshAccount()
    const steps = Array.from({ length: 100 }, () => ({ id: uuidv7(), title: '步骤' }))
    const task = await createTaskViaApi(ctx, account.token, { steps })
    const over = await addStep(account, task.taskId, '第 101 条')
    expect(over.status).toBe(400)
    expect(over.body.error.code).toBe('validation/invalid-input')
  })
})

describe('PATCH / DELETE /api/tasks/:id/steps/:stepId（定义层）', () => {
  it('改名只改标题，不动顺序、不动其它步骤', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, {
      steps: [
        { id: uuidv7(), title: 'A' },
        { id: uuidv7(), title: 'B' },
      ],
    })
    const res = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}/steps/${task.steps[0].id}`, {
      token: account.token,
      body: { title: 'A2' },
    })
    expect(res.status).toBe(200)
    expect(res.body.task.steps.map((s: any) => s.title)).toEqual(['A2', 'B'])
  })

  it('步骤不存在 → 404（本账号内）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { steps: [{ id: uuidv7(), title: 'A' }] })
    const renamed = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}/steps/${uuidv7()}`, {
      token: account.token,
      body: { title: 'X' },
    })
    expect(renamed.status).toBe(404)
    const removed = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}/steps/${uuidv7()}`, {
      token: account.token,
    })
    expect(removed.status).toBe(404)
  })

  it('删除只移除定义；**勾选留在流水里**，撤销删除批次后勾选原样回来（ADR-013 §4.10）', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: '写日志' }
    const task = await createTaskViaApi(ctx, account.token, { title: '复盘', steps: [step] })

    // 先勾上
    const toggled = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: task.indexDate, checked: true },
    })
    expect(toggled.status).toBe(200)
    expect(toggled.body.item.steps[0].checkedAt).not.toBeNull()

    // 删掉定义
    const removed = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}/steps/${step.id}`, {
      token: account.token,
    })
    expect(removed.status).toBe(200)
    expect(removed.body.task.steps).toEqual([])
    // 勾选事件**没有被删**（撤销的语义是追加事件，不是完善删除）
    expect(countEventsOfType(ctx, account.id, 'task/step-toggled')).toBe(1)

    // 撤销那次删除 → 定义回来、勾选也回来
    const removeEvent = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/step-removed')!
    const undo = await api(ctx, 'POST', '/api/undo', {
      token: account.token,
      body: { batchId: removeEvent.batchId },
    })
    expect(undo.status).toBe(200)
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.steps.map((s: any) => s.title)).toEqual(['写日志'])
    expect(detail.body.steps[0].checkedAt).not.toBeNull()
  })
})

describe('POST /api/tasks/:id/steps/:stepId/toggle（§1.2 / §4.12）', () => {
  it('**省略 originalPlannedDate → 400**（不回落成 indexDate）', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: 'A' }
    const task = await createTaskViaApi(ctx, account.token, { steps: [step] })
    for (const body of [{ checked: true }, { originalPlannedDate: task.indexDate }, {}]) {
      const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
        token: account.token,
        body,
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(countEventsOfType(ctx, account.id, 'task/step-toggled')).toBe(0)
  })

  it('`:key` 不是该任务的实例 → 404（否则会写出一条永不显示的勾选）', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: 'A' }
    const task = await createTaskViaApi(ctx, account.token, { steps: [step] })
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: addDays(TODAY, -3), checked: true },
    })
    expect(res.status).toBe(404)
  })

  it('勾选 / 取消：`checkedAt` 是时间戳（非 null 即已勾选），取消写 null', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: 'A' }
    const task = await createTaskViaApi(ctx, account.token, { steps: [step] })

    const on = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: task.indexDate, checked: true },
    })
    const checkedAt = on.body.item.steps[0].checkedAt
    expect(typeof checkedAt).toBe('string')

    // 状态一致时不写第二条事件（重复勾选只把 checkedAt 往前推，状态一字不变）
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: task.indexDate, checked: true },
    })
    expect(countEventsOfType(ctx, account.id, 'task/step-toggled')).toBe(1)

    const off = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: task.indexDate, checked: false },
    })
    expect(off.body.item.steps[0].checkedAt).toBeNull()
    const events = readAccountEvents(ctx.db, account.id).filter((e) => e.type === 'task/step-toggled')
    expect(events.map((e) => (e.payload as any).checkedAt)).toEqual([checkedAt, null])
  })

  it('**勾选属于某一轮**：同一任务的两个轮次各勾各的（ADR-013 §4.12）', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: '写日志' }
    const yesterday = addDays(TODAY, -1)
    const task = await createTaskViaApi(ctx, account.token, {
      title: '每日复盘',
      steps: [step],
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: yesterday,
      },
    })
    // 昨天的轮次已完成（播种），今天的轮次是待完成 → 当前实例 = 今天
    ctx.db.transaction(() =>
      appendEvents(ctx.db, account.id, [
        {
          type: 'task/occurrence-completed',
          occurredAt: `${yesterday}T09:00:00+08:00`,
          payload: {
            taskId: task.taskId,
            originalPlannedDate: yesterday,
            completedDayKey: yesterday,
            next: { date: TODAY, mode: 'catch_up' },
          },
        },
      ]),
    )()

    // 勾**昨天那一轮**：当前实例是今天，故明细里的勾选态不受影响
    const forYesterday = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: yesterday, checked: true },
    })
    expect(forYesterday.status).toBe(200)
    expect(forYesterday.body.item.occurrenceKey).toBe(TODAY)
    expect(forYesterday.body.item.steps[0].checkedAt).toBeNull()

    // 勾**今天那一轮**：同一行立刻变亮
    const forToday = await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: TODAY, checked: true },
    })
    expect(forToday.body.item.steps[0].checkedAt).not.toBeNull()

    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.occurrenceKey).toBe(TODAY)
    expect(detail.body.steps[0].checkedAt).not.toBeNull()
    expect(detail.body.steps[0]).toMatchObject({ id: step.id, title: '写日志' })
  })
})

describe('PUT /api/tasks/:id/steps/order（ADR-017 §3 的集合相等）', () => {
  async function taskWithThreeSteps(account: Account) {
    return createTaskViaApi(ctx, account.token, {
      steps: [
        { id: uuidv7(), title: 'A' },
        { id: uuidv7(), title: 'B' },
        { id: uuidv7(), title: 'C' },
      ],
    })
  }

  it('**顺序不同但集合相同 → 必须成功**（这正是这条路由的用途）', async () => {
    const account = await freshAccount()
    const task = await taskWithThreeSteps(account)
    const [a, b, c] = task.steps.map((s: any) => s.id)
    const res = await api(ctx, 'PUT', `/api/tasks/${task.taskId}/steps/order`, {
      token: account.token,
      body: { order: [c, a, b] },
    })
    expect(res.status).toBe(200)
    expect(res.body.task.steps.map((s: any) => s.id)).toEqual([c, a, b])
  })

  it('少一个 / 多一个 / 有重复 → 400（未列出的步骤会处于未定义位置）', async () => {
    const account = await freshAccount()
    const task = await taskWithThreeSteps(account)
    const [a, b, c] = task.steps.map((s: any) => s.id)
    for (const [label, order] of [
      ['少一个', [a, b]],
      ['多一个', [a, b, c, uuidv7()]],
      ['有重复', [a, a, b]],
    ] as [string, string[]][]) {
      const res = await api(ctx, 'PUT', `/api/tasks/${task.taskId}/steps/order`, {
        token: account.token,
        body: { order },
      })
      expect(res.status, label).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
    // 一个字都没写：顺序仍是原来的
    expect(countEventsOfType(ctx, account.id, 'task/steps-reordered')).toBe(0)
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.steps.map((s: any) => s.id)).toEqual([a, b, c])
  })

  it('空任务的空 order？—— 集合相等，两边都是空集 → 成功（幂等）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const res = await api(ctx, 'PUT', `/api/tasks/${task.taskId}/steps/order`, {
      token: account.token,
      body: { order: [] },
    })
    expect(res.status).toBe(200)
  })

  it('跨账号 → 404；未知字段 / accountId → 400', async () => {
    const account = await freshAccount()
    const task = await taskWithThreeSteps(account)
    const cross = await api(ctx, 'PUT', `/api/tasks/${task.taskId}/steps/order`, {
      token: owner.token,
      body: { order: [] },
    })
    expect(cross.status).toBe(404)
    const withAccount = await api(ctx, 'PUT', `/api/tasks/${task.taskId}/steps/order`, {
      token: account.token,
      body: { order: [], accountId: owner.id },
    })
    expect(withAccount.status).toBe(400)
  })
})
