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
  return createMemberAccount(ctx, owner.token, `archive${seq}`)
}

function list(token: string) {
  return api(ctx, 'GET', '/api/projects', { token })
}

function setArchived(token: string, projectId: string, archived: boolean) {
  return api(ctx, 'PATCH', `/api/projects/${projectId}/archive`, { token, body: { archived } })
}

function activeIds(body: any): string[] {
  return body.projects.filter((project: any) => !project.archived)
    .map((project: any) => project.projectId)
}

describe('PATCH /api/projects/:id/archive', () => {
  it('归档保留项目和任务历史，清除当前选择，恢复与重建后状态稳定', async () => {
    const a = await account()
    const project = await createProjectViaApi(ctx, a.token, { makeCurrent: true })
    const task = await createTaskViaApi(ctx, a.token, { projectId: project.projectId })
    const before = readProjection(ctx.db, a.id)

    const archived = await setArchived(a.token, project.projectId, true)
    expect(archived.status).toBe(200)
    expect(archived.body.project).toMatchObject({
      projectId: project.projectId, archived: true, isCurrent: false,
    })
    expect((await list(a.token)).body).toMatchObject({
      currentProjectId: null,
      projects: [{ projectId: project.projectId, archived: true, isCurrent: false }],
    })
    const projected = readProjection(ctx.db, a.id)
    expect(projected.projects.find((row) => row.id === project.projectId)?.deletedAt).toBeNull()
    expect(projected.tasks.find((row) => row.id === task.taskId)?.projectId).toBe(project.projectId)
    expect(before.tasks).toEqual(projected.tasks)
    const scoped = await api(ctx, 'GET', `/api/tasks?scope=project&projectId=${project.projectId}`, {
      token: a.token,
    })
    expect(scoped.status).toBe(200)
    expect(scoped.body.items.map((row: any) => row.taskId)).toContain(task.taskId)
    expect((await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: a.token })).body.task.projectId)
      .toBe(project.projectId)
    expect((await api(ctx, 'POST', `/api/projects/${project.projectId}/activate`, {
      token: a.token,
    })).status).toBe(400)

    const archiveEvents = readAccountEvents(ctx.db, a.id)
      .filter((event) => event.type === 'project/archive-changed')
    expect(archiveEvents).toHaveLength(1)
    expect(archiveEvents[0]?.payload).toEqual({ projectId: project.projectId, archived: true })
    expect(archiveEvents[0]?.targetId).toBe(project.projectId)
    const clearEvent = readAccountEvents(ctx.db, a.id)
      .find((event) => event.type === 'project/current-changed'
        && (event.payload as { projectId: string | null }).projectId === null)
    expect(clearEvent?.batchId).toBe(archiveEvents[0]?.batchId)

    expect((await setArchived(a.token, project.projectId, true)).status).toBe(200)
    expect(readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'project/archive-changed'))
      .toHaveLength(1)
    rebuildProjection(ctx.db, a.id)
    expect((await list(a.token)).body.projects[0].archived).toBe(true)

    const restored = await setArchived(a.token, project.projectId, false)
    expect(restored.status).toBe(200)
    expect(restored.body.project).toMatchObject({ archived: false, isCurrent: false })
    expect((await list(a.token)).body.currentProjectId).toBeNull()
    expect((await api(ctx, 'GET', `/api/tasks?scope=project&projectId=${project.projectId}`, {
      token: a.token,
    })).body.items.map((row: any) => row.taskId)).toContain(task.taskId)
  })

  it('归档批次可撤销，恢复原当前项目；跨账号与非法载荷拒绝', async () => {
    const a = await account()
    const b = await account()
    const project = await createProjectViaApi(ctx, a.token, { makeCurrent: true })

    expect((await api(ctx, 'PATCH', `/api/projects/${project.projectId}/archive`, {
      body: { archived: true },
    })).status).toBe(401)
    expect((await setArchived(b.token, project.projectId, true)).status).toBe(404)
    for (const body of [{ archived: 'true' }, { archived: true, accountId: b.id }, {}]) {
      expect((await api(ctx, 'PATCH', `/api/projects/${project.projectId}/archive`, {
        token: a.token, body,
      })).status).toBe(400)
    }
    expect(readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'project/archive-changed'))
      .toHaveLength(0)

    const archived = await setArchived(a.token, project.projectId, true)
    expect(archived.status).toBe(200)
    const event = readAccountEvents(ctx.db, a.id)
      .find((row) => row.type === 'project/archive-changed')!
    expect((await api(ctx, 'POST', '/api/undo', {
      token: b.token, body: { batchId: event.batchId },
    })).status).toBe(404)
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: event.batchId },
    })).status).toBe(200)
    const result = (await list(a.token)).body
    expect(result.currentProjectId).toBe(project.projectId)
    expect(result.projects[0]).toMatchObject({ archived: false, isCurrent: true })
    rebuildProjection(ctx.db, a.id)
    expect((await list(a.token)).body).toEqual(result)
  })

  it('活跃排序只接收未归档全集，恢复项目在新顺序末尾；删除与归档独立', async () => {
    const a = await account()
    const one = await createProjectViaApi(ctx, a.token, { name: '一' })
    const two = await createProjectViaApi(ctx, a.token, { name: '二' })
    const three = await createProjectViaApi(ctx, a.token, { name: '三' })
    expect((await api(ctx, 'PUT', '/api/projects/order', {
      token: a.token, body: { projectIds: [one.projectId, two.projectId, three.projectId] },
    })).status).toBe(200)
    expect((await setArchived(a.token, two.projectId, true)).status).toBe(200)
    expect((await api(ctx, 'PUT', '/api/projects/order', {
      token: a.token, body: { projectIds: [three.projectId, two.projectId, one.projectId] },
    })).status).toBe(400)
    const reordered = await api(ctx, 'PUT', '/api/projects/order', {
      token: a.token, body: { projectIds: [three.projectId, one.projectId] },
    })
    expect(reordered.status).toBe(200)
    expect(activeIds(reordered.body)).toEqual([three.projectId, one.projectId])
    expect(reordered.body.projects.at(-1)).toMatchObject({ projectId: two.projectId, archived: true })

    const four = await createProjectViaApi(ctx, a.token, { name: '四' })
    expect((await setArchived(a.token, two.projectId, false)).status).toBe(200)
    const restored = (await list(a.token)).body
    expect(activeIds(restored)).toEqual([
      three.projectId, one.projectId, four.projectId, two.projectId,
    ])
    rebuildProjection(ctx.db, a.id)
    expect((await list(a.token)).body).toEqual(restored)

    expect((await api(ctx, 'DELETE', `/api/projects/${two.projectId}`, {
      token: a.token,
    })).status).toBe(200)
    expect((await list(a.token)).body.projects.map((row: any) => row.projectId))
      .not.toContain(two.projectId)
    expect((await setArchived(a.token, two.projectId, true)).status).toBe(404)
  })
})
