import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays } from '@shared/time'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { uuidv7 } from '../lib/uuid.js'
import {
  api,
  countEventsOfType,
  createMemberAccount,
  createOwnerAccount,
  createProjectViaApi,
  createTaskViaApi,
  startTestServer,
  todayKey,
  type Account,
  type TestContext,
} from './helpers.js'

/**
 * 撤销入口（ADR-017 §1.6 / §8；机制见 ADR-006）。
 *
 * 它在阶段 4 就位是**一处对阶段划分的修订，理由必要**：ADR-013 §4.8 定
 * 「删除是软删除，撤销删除 = 撤销该批次」，而「30 秒撤销」原本排在阶段 5——
 * 两条合读的后果是**阶段 4 的删除是删了就没了**，而任务删除是**唯一**一个
 * 把东西移出所有视图的操作。
 *
 * 四条约束各有一组用例：
 *
 * | 约束 | 期望 |
 * |---|---|
 * | 只能撤销本账号的批次 | 跨账号 → `404`（**不泄露存在性**：批次只是事件行的列，没有独立的表，「不存在」与「属于他人」在数据上完全同形） |
 * | 撤销一个撤销 → 被拒 | `409 conflict/batch-not-revocable` |
 * | 一个批次只能撤销一次 | 重复撤销**幂等**（不写第二条 revoke 事件） |
 * | 不做 30 秒窗口 | 任何批次、任何时刻都可撤销（FR3：窗口是界面的事） |
 */

let ctx: TestContext
let owner: Account
let other: Account
let seq = 0

beforeAll(async () => {
  ctx = await startTestServer()
  owner = await createOwnerAccount(ctx)
  other = await createMemberAccount(ctx, owner.token, 'bob')
})

afterAll(async () => {
  await ctx.close()
})

async function freshAccount(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `undo${seq}`)
}

const TODAY = todayKey()

function undo(account: Account, batchId: string) {
  return api(ctx, 'POST', '/api/undo', { token: account.token, body: { batchId } })
}

describe('入口契约', () => {
  it('无令牌 → 401；batchId 缺失 / 非字符串 → 400；accountId → 400', async () => {
    const noToken = await api(ctx, 'POST', '/api/undo', { body: { batchId: uuidv7() } })
    expect(noToken.status).toBe(401)

    const account = await freshAccount()
    for (const body of [{}, { batchId: '' }, { batchId: 1 }, { batchId: uuidv7(), accountId: other.id }]) {
      const res = await api(ctx, 'POST', '/api/undo', { token: account.token, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
  })

  it('不存在的批次 → 404 not-found', async () => {
    const account = await freshAccount()
    const res = await undo(account, uuidv7())
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not-found')
  })
})

describe('撤销删除：任务逐字段还原（ADR-013 §4.8）', () => {
  it('删除 → 撤销 → 任务逐字段回来（含步骤、完成记录、projectId）', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: '第一步' }
    const task = await createTaskViaApi(ctx, account.token, {
      title: '要撤销的删除',
      notes: '备注原文',
      importance: 'high',
      tags: ['a', 'b'],
      plannedDate: TODAY,
      dueDate: addDays(TODAY, 3),
      steps: [step],
    })
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/steps/${step.id}/toggle`, {
      token: account.token,
      body: { originalPlannedDate: task.indexDate, checked: true },
    })
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: account.token,
    })
    const before = (await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).body

    const deleted = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(deleted.status).toBe(200)
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).status).toBe(404)

    const res = await undo(account, deleted.body.batchId)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ batchId: deleted.body.batchId, revoked: true })

    // 逐字段还原：定义、完成记录（本实例）、步骤勾选都在
    const after = (await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).body
    expect(after.task).toEqual(before.task)
    expect(after.steps).toEqual(before.steps)
    expect(after.occurrences).toEqual(before.occurrences)
    expect(after.task.deletedAt).toBeNull()
    expect(after.steps[0].checkedAt).not.toBeNull()
    expect(after.occurrences[0].status).toBe('completed')

    // 又出现在视图里
    const all = await api(ctx, 'GET', '/api/tasks?scope=all', { token: account.token })
    expect(all.body.items.map((item: any) => item.title)).toContain('要撤销的删除')
  })

  it('撤销顺延批次：plannedDate 回到顺延前（append-only 的撤销语义）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const moved = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: addDays(TODAY, 7) }] },
    })
    expect(moved.status).toBe(200)
    const batchId = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/rescheduled')!
      .batchId

    await undo(account, batchId)
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.task.plannedDate).toBe(TODAY)
    // 被撤销的事件**仍在流水里**（撤销只跳过、不删除）——审计价值不丢
    expect(countEventsOfType(ctx, account.id, 'task/rescheduled')).toBe(1)
    expect(countEventsOfType(ctx, account.id, 'system/revoke')).toBe(1)
  })

  it('撤销删除**项目**批次：项目回来，且其下任务的 projectId 一直没变过', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, { name: '课题', makeCurrent: true })
    const task = await createTaskViaApi(ctx, account.token, { projectId: project.projectId })
    const deleted = await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, {
      token: account.token,
    })
    await undo(account, deleted.body.batchId)

    const list = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(list.body.projects.map((p: any) => p.name)).toEqual(['课题'])
    // `isCurrent` 也回来了（它是行的字段，由 `project/current-changed` 事件重放得出）
    expect(list.body.currentProjectId).toBe(project.projectId)
    expect(readProjection(ctx.db, account.id).tasks[0]!.projectId).toBe(project.projectId)
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).status).toBe(200)
  })

  it('撤销一次**批量**顺延：两条任务一起回到原值（「一个请求 = 一个批次」的直接好处）', async () => {
    const account = await freshAccount()
    const a = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const b = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const moved = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: {
        items: [
          { taskId: a.taskId, plannedDate: addDays(TODAY, 3) },
          { taskId: b.taskId, plannedDate: addDays(TODAY, 4) },
        ],
      },
    })
    expect(moved.status).toBe(200)

    const batchId = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/rescheduled')!
      .batchId
    await undo(account, batchId)

    for (const task of [a, b]) {
      const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
      expect(detail.body.task.plannedDate).toBe(TODAY)
    }
  })
})

describe('约束：跨账号 404 / 撤销撤销 409 / 重复撤销幂等', () => {
  it('跨账号撤销 → 404，且与「不存在」**逐字相同**', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const deleted = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })

    const cross = await undo(other, deleted.body.batchId)
    const absent = await undo(other, uuidv7())
    expect(cross.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(cross.body.error.code).toBe('not-found')
    // 抹掉 id 之后两份响应必须完全一样——否则「存在但不属于你」就成了可探测的事实
    expect(JSON.stringify(cross.body).replaceAll(deleted.body.batchId, 'X')).toBe(
      JSON.stringify(absent.body).replaceAll(absent.body.error.message.match(/[0-9a-f-]{36}/)?.[0] ?? 'none', 'X'),
    )
    // 而且**没有产生任何事件**（跨账号的新账号连一个字节都不该多）
    expect(countEventsOfType(ctx, other.id, 'system/revoke')).toBe(0)
  })

  it('撤销一个「撤销」批次 → 409 conflict/batch-not-revocable（§8：不允许凭直觉实现）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const deleted = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    const first = await undo(account, deleted.body.batchId)
    expect(first.status).toBe(200)

    const revokeEvent = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'system/revoke')!
    const res = await undo(account, revokeEvent.batchId)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/batch-not-revocable')
    // 「撤销撤销」没有发生：任务**仍是被撤销前的还原态**（第一次撤销照常生效），
    // 且流水里只有那一条 revoke —— 被拒的这次请求**一个字都没写**
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).status).toBe(200)
    expect(countEventsOfType(ctx, account.id, 'system/revoke')).toBe(1)
  })

  it('重复撤销同一批次 → 幂等（200），且**不写第二条 revoke 事件**（ADR-006）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const deleted = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    await undo(account, deleted.body.batchId)
    const again = await undo(account, deleted.body.batchId)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ batchId: deleted.body.batchId, revoked: true })
    expect(countEventsOfType(ctx, account.id, 'system/revoke')).toBe(1)
  })

  it('撤销**任何**批次（不设 30 秒窗口，FR3：窗口是界面的事）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '建了就撤' })
    const created = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/created')!
    const res = await undo(account, created.batchId)
    expect(res.status).toBe(200)
    // 撤销创建 → 任务从投影里消失（「什么都没发生过」）
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })).status).toBe(404)
  })
})

describe('撤销与投影重建的接线（ADR-010 §5）', () => {
  it('撤销是边界事件：撤销之后投影等于全量重建的结果', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: '步骤' }
    const task = await createTaskViaApi(ctx, account.token, {
      title: '重建',
      plannedDate: TODAY,
      steps: [step],
    })
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: account.token,
    })
    const deleted = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    await undo(account, deleted.body.batchId)

    // 投影（读表）与重放（`project()`）必须逐字段一致——「投影 = 重放结果」
    const { rebuildProjection } = await import('../events/rebuild.js')
    const { project } = await import('../events/project.js')
    const before = readProjection(ctx.db, account.id)
    dbTransaction(ctx, () => rebuildProjection(ctx.db, account.id))
    const rebuilt = readProjection(ctx.db, account.id)
    const replayed = project(readAccountEvents(ctx.db, account.id))
    expect(rebuilt).toEqual(replayed)
    expect(before).toEqual(rebuilt)

    // 撤销之后完成态也回来了（它不是投影行，而是从流水折叠出来的）
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.task.deletedAt).toBeNull()
    expect(detail.body.occurrences[0].status).toBe('completed')
    expect(detail.body.steps[0].checkedAt).toBeNull()
  })
})

function dbTransaction(ctx: TestContext, run: () => void): void {
  ctx.db.transaction(run)()
}
