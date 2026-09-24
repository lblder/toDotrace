import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays } from '@shared/time'
import {
  api,
  createMemberAccount,
  createOwnerAccount,
  createProjectViaApi,
  createTaskViaApi,
  startTestServer,
  todayKey,
  type Account,
  type TestContext,
} from './helpers.js'

let ctx: TestContext
let owner: Account

beforeAll(async () => {
  ctx = await startTestServer()
  owner = await createOwnerAccount(ctx)
})

afterAll(async () => { await ctx.close() })

describe('GET /api/trace · ADR-018', () => {
  it('必须鉴权，查询参数严格且 projectId 仅随 project 使用', async () => {
    const noToken = await api(ctx, 'GET', '/api/trace')
    expect(noToken.status).toBe(401)
    const account = await createMemberAccount(ctx, owner.token, 'trace-api-query')
    for (const path of [
      '/api/trace?period=week&extra=x',
      '/api/trace?period=week&projectId=p',
      '/api/trace?period=project',
      '/api/trace?period=month&goalMinutes=721',
      '/api/trace?period=month&period=week',
    ]) {
      const response = await api(ctx, 'GET', path, { token: account.token })
      expect(response.status, path).toBe(400)
    }
  })

  it('项目周期统计全账号活动，项目归属摘要独立；其他账号的项目不可读', async () => {
    const account = await createMemberAccount(ctx, owner.token, 'trace-api-owner')
    const other = await createMemberAccount(ctx, owner.token, 'trace-api-other')
    const today = todayKey()
    const project = await createProjectViaApi(ctx, account.token, {
      startsOn: addDays(today, -2), endsOn: today,
    })
    const owned = await createTaskViaApi(ctx, account.token, { title: '项目内', projectId: project.projectId })
    const general = await createTaskViaApi(ctx, account.token, { title: '项目外' })
    for (const task of [owned, general]) {
      const response = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, { token: account.token })
      expect(response.status).toBe(200)
    }
    const result = await api(ctx, 'GET', `/api/trace?period=project&projectId=${project.projectId}`, { token: account.token })
    expect(result.status).toBe(200)
    expect(result.body.today).toBe(today)
    expect(result.body.range).toEqual({ from: addDays(today, -2), to: today })
    expect(result.body.totals.completed).toBe(2)
    expect(result.body.project).toMatchObject({ projectId: project.projectId, ownedTotal: 1, ownedCompleted: 1 })
    expect(result.body.heatmap).toHaveLength(371)
    const hidden = await api(ctx, 'GET', `/api/trace?period=project&projectId=${project.projectId}`, { token: other.token })
    expect(hidden.status).toBe(404)
  })
})
