import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { rebuildProjection } from '../events/rebuild.js'
import {
  api,
  createMemberAccount,
  createOwnerAccount,
  createProjectViaApi,
  createTaskViaApi,
  startTestServer,
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

async function account(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `order${seq}`)
}

function list(token: string) {
  return api(ctx, 'GET', '/api/projects', { token })
}

function reorder(token: string, projectIds: string[]) {
  return api(ctx, 'PUT', '/api/projects/order', { token, body: { projectIds } })
}

function ids(body: any): string[] {
  return body.projects.map((project: any) => project.projectId)
}

describe('PUT /api/projects/order', () => {
  it('保存完整顺序，刷新与重建后稳定，新项目追加末尾，删除与撤销按事件恢复', async () => {
    const a = await account()
    const one = await createProjectViaApi(ctx, a.token, {
      name: '甲', startsOn: '2026-09-10', endsOn: '2026-12-31', makeCurrent: true,
    })
    const two = await createProjectViaApi(ctx, a.token, {
      name: '乙', startsOn: '2026-09-01', endsOn: '2026-12-31',
    })
    const three = await createProjectViaApi(ctx, a.token, {
      name: '丙', startsOn: '2026-09-05', endsOn: '2026-12-31',
    })
    const task = await createTaskViaApi(ctx, a.token, { projectId: two.projectId })
    expect(ids((await list(a.token)).body)).toEqual([two.projectId, three.projectId, one.projectId])

    const beforeProjection = readProjection(ctx.db, a.id)
    const saved = await reorder(a.token, [one.projectId, two.projectId, three.projectId])
    expect(saved.status).toBe(200)
    expect(ids(saved.body)).toEqual([one.projectId, two.projectId, three.projectId])
    expect(saved.body.currentProjectId).toBe(one.projectId)
    expect(readProjection(ctx.db, a.id)).toEqual(beforeProjection)
    expect(ids((await list(a.token)).body)).toEqual(ids(saved.body))
    rebuildProjection(ctx.db, a.id)
    expect(ids((await list(a.token)).body)).toEqual(ids(saved.body))
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: a.token })).body.task.projectId)
      .toBe(two.projectId)

    const four = await createProjectViaApi(ctx, a.token, {
      name: '丁', startsOn: '2026-08-01', endsOn: '2026-12-31',
    })
    expect(ids((await list(a.token)).body)).toEqual([
      one.projectId, two.projectId, three.projectId, four.projectId,
    ])
    const deleted = await api(ctx, 'DELETE', `/api/projects/${two.projectId}`, { token: a.token })
    expect(deleted.status).toBe(200)
    expect(ids((await list(a.token)).body)).toEqual([one.projectId, three.projectId, four.projectId])
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: deleted.body.batchId },
    })).status).toBe(200)
    expect(ids((await list(a.token)).body)).toEqual([
      one.projectId, two.projectId, three.projectId, four.projectId,
    ])

    const orderEvent = readAccountEvents(ctx.db, a.id).find((event) => event.type === 'project/order')!
    expect(orderEvent.targetKind).toBeNull()
    expect(orderEvent.targetId).toBeNull()
    expect(orderEvent.payload).toEqual({ projectIds: [one.projectId, two.projectId, three.projectId] })
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: orderEvent.batchId },
    })).status).toBe(200)
    expect(ids((await list(a.token)).body)).toEqual([
      four.projectId, two.projectId, three.projectId, one.projectId,
    ])
  })

  it('缺项、重复、他账号或已删除项目均拒绝；相同顺序重复提交不增加事件', async () => {
    const a = await account()
    const b = await account()
    const one = await createProjectViaApi(ctx, a.token)
    const two = await createProjectViaApi(ctx, a.token)
    const foreign = await createProjectViaApi(ctx, b.token)
    expect((await api(ctx, 'PUT', '/api/projects/order', { body: { projectIds: [] } })).status).toBe(401)
    for (const projectIds of [
      [one.projectId],
      [one.projectId, one.projectId],
      [one.projectId, foreign.projectId],
    ]) {
      const invalid = await reorder(a.token, projectIds)
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe('validation/invalid-input')
    }
    expect((await api(ctx, 'PUT', '/api/projects/order', {
      token: a.token, body: { projectIds: [one.projectId, two.projectId], accountId: b.id },
    })).status).toBe(400)
    expect(readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'project/order')).toHaveLength(0)

    const first = await reorder(a.token, [two.projectId, one.projectId])
    expect(first.status).toBe(200)
    expect(ids(first.body)).toEqual([two.projectId, one.projectId])
    expect((await reorder(a.token, [two.projectId, one.projectId])).status).toBe(200)
    expect(readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'project/order')).toHaveLength(1)

    await api(ctx, 'DELETE', `/api/projects/${one.projectId}`, { token: a.token })
    expect((await reorder(a.token, [two.projectId, one.projectId])).status).toBe(400)
    expect((await reorder(a.token, [two.projectId])).status).toBe(200)
    expect(ids((await list(a.token)).body)).toEqual([two.projectId])
  })

  it('撤销较新的排序后回到上一份有效顺序，覆盖面按统一事件规则处理', async () => {
    const a = await account()
    const one = await createProjectViaApi(ctx, a.token)
    const two = await createProjectViaApi(ctx, a.token)
    const three = await createProjectViaApi(ctx, a.token)
    await reorder(a.token, [two.projectId, one.projectId, three.projectId])
    const newer = await reorder(a.token, [three.projectId, two.projectId, one.projectId])
    expect(ids(newer.body)).toEqual([three.projectId, two.projectId, one.projectId])
    const orderEvents = readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'project/order')
    expect(orderEvents).toHaveLength(2)
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: orderEvents[1]!.batchId },
    })).status).toBe(200)
    expect(ids((await list(a.token)).body)).toEqual([two.projectId, one.projectId, three.projectId])
  })
})
