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
 * 项目路由的 HTTP 契约（ADR-017 §1.3；语义见 ADR-016 §4 / §5 / §6）。
 *
 * 本组重点覆盖四件事：
 *
 * 1. **`PATCH` 收差量、事件载荷是整行快照**（§1.3 注 + ADR-016 §5.2）：
 *    只改 `name` 时，事件载荷里另外三个字段必须是**合并后的当前值**——
 *    把差量直接写进载荷会让重放依赖「前一条事件一定在」，而撤销与合并导入都可能让它不在；
 * 2. **「当前项目」至多一个、且只有 `project/current-changed` 能改**：
 *    `isCurrent` 不在 `PATCH` 的载荷里（给出即 400）；「新建并设为当前」是同一批次两条事件；
 * 3. **删除项目不动其下任务**（ADR-016 §6）：任务全部保留、`projectId` 一个都不清；
 * 4. **`active`/`upcoming`/`ended` 是派生量**（ADR-016 §4）：不落库，按 `endsOn` 与今日算。
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
  return createMemberAccount(ctx, owner.token, `proj${seq}`)
}

const TODAY = todayKey()

describe('鉴权与入口契约', () => {
  it('无令牌 → 401', async () => {
    const id = uuidv7()
    for (const [method, path] of [
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['PATCH', `/api/projects/${id}`],
      ['DELETE', `/api/projects/${id}`],
      ['POST', `/api/projects/${id}/activate`],
      ['DELETE', '/api/projects/current'],
    ] as [string, string][]) {
      const res = await api(ctx, method, path, {
        body: method === 'GET' || method === 'DELETE' ? undefined : {},
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('accountId 出现在请求体 → 400（.strict() 拒绝，不是忽略）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: {
        projectId: uuidv7(),
        name: '项目',
        startsOn: '2026-09-01',
        endsOn: '2026-09-30',
        accountId: other.id,
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
    expect(readProjection(ctx.db, account.id).projects).toEqual([])
  })

  it('无请求体的路由（删除 / 切换 / 取消当前）多给一个字段 → 400', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token)
    for (const [method, path] of [
      ['POST', `/api/projects/${project.projectId}/activate`],
      ['DELETE', `/api/projects/${project.projectId}`],
      ['DELETE', '/api/projects/current'],
    ] as [string, string][]) {
      const res = await api(ctx, method, path, { token: account.token, body: { accountId: other.id } })
      expect(res.status, `${method} ${path}`).toBe(400)
    }
  })
})

describe('POST /api/projects（ADR-016 §5.1 / §5.5）', () => {
  it('新建：默认不是当前项目；响应 { project, created: true }', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: {
        projectId: uuidv7(),
        name: '毕业课题',
        startsOn: '2026-09-01',
        endsOn: '2026-12-31',
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(true)
    expect(res.body.project).toMatchObject({
      name: '毕业课题',
      startsOn: '2026-09-01',
      endsOn: '2026-12-31',
      isCurrent: false,
      state: 'active',
    })
    expect(res.body.project).not.toHaveProperty('accountId')

    const list = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(list.body.currentProjectId).toBeNull()
  })

  it('`makeCurrent: true` 是**同一批次的两条事件**（created + current-changed）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: {
        projectId: uuidv7(),
        name: '当前项目',
        startsOn: '2026-09-01',
        endsOn: '2026-09-30',
        makeCurrent: true,
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.project.isCurrent).toBe(true)

    const events = readAccountEvents(ctx.db, account.id).filter((e) =>
      ['project/created', 'project/current-changed'].includes(e.type),
    )
    expect(events.map((e) => e.type)).toEqual(['project/created', 'project/current-changed'])
    // 「一次用户动作 = 一个批次」：两条事件同批
    expect(new Set(events.map((e) => e.batchId)).size).toBe(1)
  })

  it('幂等：同一 projectId 两次 → created: false，事件数没多；**重复提交不会顺带切当前**', async () => {
    const account = await freshAccount()
    const projectId = uuidv7()
    const body = { projectId, name: '项目', startsOn: '2026-09-01', endsOn: '2026-09-30' }
    await api(ctx, 'POST', '/api/projects', { token: account.token, body })
    const second = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: { ...body, makeCurrent: true },
    })
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)
    expect(second.body.project.isCurrent).toBe(false) // 没有产生第一次没有的副作用
    expect(countEventsOfType(ctx, account.id, 'project/created')).toBe(1)
    expect(countEventsOfType(ctx, account.id, 'project/current-changed')).toBe(0)
  })

  it('起晚于止 → 400（**不是 500**：表侧 CHECK 是结构兜底，不是入口校验）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: { projectId: uuidv7(), name: '反的', startsOn: '2026-09-30', endsOn: '2026-09-01' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
  })

  it('起止同日合法（1 天的项目，FR2.8「长短完全自定义」）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: { projectId: uuidv7(), name: '一天', startsOn: '2026-09-10', endsOn: '2026-09-10' },
    })
    expect(res.status).toBe(200)
    expect(res.body.project.state).toBe('ended')
  })

  it('非法日期 / 非 UUIDv7 的 projectId → 400', async () => {
    const account = await freshAccount()
    const badDay = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: { projectId: uuidv7(), name: '项目', startsOn: '2026-02-30', endsOn: '2026-09-30' },
    })
    expect(badDay.status).toBe(400)
    const badId = await api(ctx, 'POST', '/api/projects', {
      token: account.token,
      body: { projectId: 'nope', name: '项目', startsOn: '2026-09-01', endsOn: '2026-09-30' },
    })
    expect(badId.status).toBe(400)
  })
})

describe('GET /api/projects', () => {
  it('只返回未删除的项目；state 是派生的（upcoming / active / ended）', async () => {
    const account = await freshAccount()
    await createProjectViaApi(ctx, account.token, {
      name: '将来的',
      startsOn: addDays(TODAY, 5),
      endsOn: addDays(TODAY, 10),
    })
    await createProjectViaApi(ctx, account.token, {
      name: '进行中的',
      startsOn: addDays(TODAY, -5),
      endsOn: addDays(TODAY, 5),
    })
    await createProjectViaApi(ctx, account.token, {
      name: '过去的',
      startsOn: addDays(TODAY, -10),
      endsOn: addDays(TODAY, -5),
    })
    const doomed = await createProjectViaApi(ctx, account.token, {
      name: '要删的',
      startsOn: addDays(TODAY, -1),
      endsOn: addDays(TODAY, 1),
    })
    await api(ctx, 'DELETE', `/api/projects/${doomed.projectId}`, { token: account.token })

    const res = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(res.status).toBe(200)
    expect(res.body.today).toBe(TODAY)
    const byName = new Map(res.body.projects.map((p: any) => [p.name, p]))
    expect([...byName.keys()].sort()).toEqual(['将来的', '过去的', '进行中的'])
    expect((byName.get('将来的') as any).state).toBe('upcoming')
    expect((byName.get('进行中的') as any).state).toBe('active')
    expect((byName.get('过去的') as any).state).toBe('ended')
  })
})

describe('PATCH /api/projects/:id（差量进、**整行载荷出**）', () => {
  it('只改 name：事件载荷的四个字段都是合并后的当前值', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, {
      name: '原名',
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
    })
    const res = await api(ctx, 'PATCH', `/api/projects/${project.projectId}`, {
      token: account.token,
      body: { name: '新名' },
    })
    expect(res.status).toBe(200)
    expect(res.body.project).toMatchObject({
      name: '新名',
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
    })

    const updated = readAccountEvents(ctx.db, account.id).filter((e) => e.type === 'project/updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]!.payload).toEqual({
      projectId: project.projectId,
      // 整行快照：没改的两个字段也在载荷里（否则重放要依赖「前一条事件一定在」）
      name: '新名',
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
    })
  })

  it('改期（延期 / 提前结束）：`isCurrent` 不在载荷里，给出即 400', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, { makeCurrent: true })
    const extended = await api(ctx, 'PATCH', `/api/projects/${project.projectId}`, {
      token: account.token,
      body: { endsOn: '2027-01-31' },
    })
    expect(extended.status).toBe(200)
    expect(extended.body.project.endsOn).toBe('2027-01-31')
    expect(extended.body.project.isCurrent).toBe(true) // 改期不动当前项目

    for (const body of [{ isCurrent: true }, { deletedAt: null }, { projectId: uuidv7() }]) {
      const res = await api(ctx, 'PATCH', `/api/projects/${project.projectId}`, {
        token: account.token,
        body,
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('合并后的区间反了 → 400（改 startsOn 同样可能把区间弄反）', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, {
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
    })
    const res = await api(ctx, 'PATCH', `/api/projects/${project.projectId}`, {
      token: account.token,
      body: { startsOn: '2026-10-01' },
    })
    expect(res.status).toBe(400)
  })

  it('不存在的 / 他人的 / 已删除的项目 → 404，且响应体逐字相同', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, { name: 'A 的' })
    const missingId = uuidv7()
    const body = { name: '改' }

    const cross = await api(ctx, 'PATCH', `/api/projects/${project.projectId}`, { token: other.token, body })
    const absent = await api(ctx, 'PATCH', `/api/projects/${missingId}`, { token: other.token, body })
    expect(cross.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(JSON.stringify(cross.body).replaceAll(project.projectId, 'X')).toBe(
      JSON.stringify(absent.body).replaceAll(missingId, 'X'),
    )

    await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, { token: account.token })
    const deleted = await api(ctx, 'PATCH', `/api/projects/${project.projectId}`, {
      token: account.token,
      body,
    })
    expect(deleted.status).toBe(404)
  })
})

describe('POST /api/projects/:id/activate 与 DELETE /api/projects/current（ADR-016 §5.4）', () => {
  it('切换当前项目；`DELETE /current` 显式清空（那个状态必须能主动进入）', async () => {
    const account = await freshAccount()
    const first = await createProjectViaApi(ctx, account.token, { name: '一' })
    const second = await createProjectViaApi(ctx, account.token, { name: '二' })

    const activated = await api(ctx, 'POST', `/api/projects/${first.projectId}/activate`, {
      token: account.token,
    })
    expect(activated.status).toBe(200)
    expect(activated.body.currentProjectId).toBe(first.projectId)

    const switched = await api(ctx, 'POST', `/api/projects/${second.projectId}/activate`, {
      token: account.token,
    })
    expect(switched.body.currentProjectId).toBe(second.projectId)

    // 至多一个：列表里只有一个 isCurrent
    const list = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(list.body.projects.filter((p: any) => p.isCurrent).map((p: any) => p.projectId)).toEqual([
      second.projectId,
    ])

    const cleared = await api(ctx, 'DELETE', '/api/projects/current', { token: account.token })
    expect(cleared.status).toBe(200)
    expect(cleared.body.currentProjectId).toBeNull()
    const after = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(after.body.currentProjectId).toBeNull()
    expect(after.body.projects.every((p: any) => !p.isCurrent)).toBe(true)
  })

  it('重复激活 / 重复清空是幂等的（事件只带 to，重放结果不变）', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, { name: '项目' })
    await api(ctx, 'POST', `/api/projects/${project.projectId}/activate`, { token: account.token })
    const again = await api(ctx, 'POST', `/api/projects/${project.projectId}/activate`, {
      token: account.token,
    })
    expect(again.status).toBe(200)
    expect(again.body.currentProjectId).toBe(project.projectId)

    await api(ctx, 'DELETE', '/api/projects/current', { token: account.token })
    const twice = await api(ctx, 'DELETE', '/api/projects/current', { token: account.token })
    expect(twice.status).toBe(200)
    const list = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(list.body.currentProjectId).toBeNull()
  })

  it('激活不存在 / 已删除 / 他人的项目 → **400**（ADR-016 §5.4 的明文，不区分三者以免泄露存在性）', async () => {
    const account = await freshAccount()
    const missing = await api(ctx, 'POST', `/api/projects/${uuidv7()}/activate`, {
      token: account.token,
    })
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('validation/invalid-input')

    const foreign = await createProjectViaApi(ctx, other.token, { name: '别人的' })
    const cross = await api(ctx, 'POST', `/api/projects/${foreign.projectId}/activate`, {
      token: account.token,
    })
    expect(cross.status).toBe(400)
    expect(cross.body.error.code).toBe('validation/invalid-input')

    const own = await createProjectViaApi(ctx, account.token, { name: '自己的' })
    await api(ctx, 'DELETE', `/api/projects/${own.projectId}`, { token: account.token })
    const deleted = await api(ctx, 'POST', `/api/projects/${own.projectId}/activate`, {
      token: account.token,
    })
    expect(deleted.status).toBe(400)
  })
})

describe('DELETE /api/projects/:id：软删除 + 其下任务一条都不动（ADR-016 §6）', () => {
  it('返回 { projectId, batchId }；项目从清单消失；**任务的 projectId 逐字不变**', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, {
      name: '结题',
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
      makeCurrent: true,
    })
    const task = await createTaskViaApi(ctx, account.token, {
      title: '项目里的任务',
      projectId: project.projectId,
      plannedDate: TODAY,
    })

    const res = await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, { token: account.token })
    expect(res.status).toBe(200)
    expect(res.body.projectId).toBe(project.projectId)
    expect(typeof res.body.batchId).toBe('string')

    // 项目：清单里没有了、当前项目归 null（「已删除的项目不能是当前项目」是不变式）
    const list = await api(ctx, 'GET', '/api/projects', { token: account.token })
    expect(list.body.projects).toEqual([])
    expect(list.body.currentProjectId).toBeNull()

    // 任务：**全部保留**，`projectId` 一个都不清（清空会让历史静默丢失
    //「这条任务当时属于哪个项目」，而软删除下引用根本不会悬挂）
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.task.projectId).toBe(project.projectId)
    const today = await api(ctx, 'GET', '/api/tasks?scope=today', { token: account.token })
    expect(today.body.items.map((item: any) => item.title)).toContain('项目里的任务')

    // 软删除：行还在（`deletedAt` 置位），不是物理删除
    const row = readProjection(ctx.db, account.id).projects.find((p) => p.id === project.projectId)!
    expect(row.deletedAt).not.toBeNull()
  })

  it('重复删除 → 404', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token)
    await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, { token: account.token })
    const again = await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, {
      token: account.token,
    })
    expect(again.status).toBe(404)
  })

  it('删掉项目后，其下任务仍在**别的** scope 里看得见（区间外分组不成立时也不丢件）', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, {
      name: '项目',
      startsOn: addDays(TODAY, -2),
      endsOn: addDays(TODAY, 2),
    })
    const task = await createTaskViaApi(ctx, account.token, {
      title: '任务',
      projectId: project.projectId,
      plannedDate: addDays(TODAY, 30),
    })
    await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, { token: account.token })
    const all = await api(ctx, 'GET', '/api/tasks?scope=all', { token: account.token })
    expect(all.body.items.map((item: any) => item.title)).toContain('任务')
    expect(readProjection(ctx.db, account.id).tasks[0]!.projectId).toBe(project.projectId)
    expect(readProjection(ctx.db, account.id).tasks[0]!.id).toBe(task.taskId)
  })
})
