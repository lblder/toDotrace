import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, compareDayKey, weekEnd, weekStart } from '@shared/time'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { uuidv7 } from '../lib/uuid.js'
import { createTask } from '../tasks/service.js'
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
 * 任务路由的 HTTP 契约（ADR-017 §1.1 / §3 / §4 / §9）与其接线。
 *
 * 覆盖 ADR-017 §后果 的测试矩阵中与任务路由有关的部分：`accountId` 不来自请求体、
 * 跨账号 404、幂等、非法状态迁移、`已完成 → 已放弃`、`order` 集合相等、
 * 批量顺延的原子性、上限边界、以及 `AnchorInvariantError` 的 500 接线。
 *
 * 步骤与实例完成/取消的用例在 `task-steps-api.test.ts` / `task-occurrences-api.test.ts`，
 * 每日备注与设置在 `note-api.test.ts` / `settings-api.test.ts`，撤销在 `undo-api.test.ts`。
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

/** 每个用例一个全新账号：任务列表是全账号可见的，共用账号会让断言互相污染 */
async function freshAccount(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `taskuser${seq}`)
}

const TODAY = todayKey()

/**
 * 每条 `:id` 路由 + 一份**合法**的请求体。
 *
 * 请求体必须合法：入参校验发生在鉴权与归属判定**之前**（`parseInput` 是第一句），
 * 故给一个畸形 body 会让本例拿到 400 而不是我们要断言的 404——
 * 那样测的就是「校验器会拒绝」，而不是「跨账号一律 404」。
 */
function taskRoutes(id: string): [string, string, unknown?][] {
  return [
    ['GET', `/api/tasks/${id}`],
    ['PATCH', `/api/tasks/${id}`, { title: '改一下' }],
    ['POST', `/api/tasks/${id}/status`, { to: 'in_progress' }],
    ['POST', `/api/tasks/${id}/order`, { manualOrder: 1 }],
    ['DELETE', `/api/tasks/${id}`],
    ['POST', `/api/tasks/${id}/occurrences/${TODAY}/complete`],
    ['POST', `/api/tasks/${id}/occurrences/${TODAY}/uncomplete`],
    ['POST', `/api/tasks/${id}/steps`, { title: '步骤' }],
    ['PATCH', `/api/tasks/${id}/steps/${uuidv7()}`, { title: '改名' }],
    ['DELETE', `/api/tasks/${id}/steps/${uuidv7()}`],
    ['POST', `/api/tasks/${id}/steps/${uuidv7()}/toggle`, { originalPlannedDate: TODAY, checked: true }],
    ['PUT', `/api/tasks/${id}/steps/order`, { order: [] }],
  ]
}

function countTasks(accountId: string): number {
  return readProjection(ctx.db, accountId).tasks.length
}

// ─────────────────────────────── 鉴权 ───────────────────────────────

describe('鉴权：任务路由一律需令牌（ADR-017 §1）', () => {
  it('无令牌 → 401，且不写任何东西', async () => {
    const id = uuidv7()
    const before = countEventsOfType(ctx, owner.id, 'task/created')
    for (const [method, path] of [
      ['GET', '/api/tasks?scope=all'],
      ['GET', `/api/tasks/${id}`],
      ['POST', '/api/tasks'],
      ['PATCH', `/api/tasks/${id}`],
      ['POST', `/api/tasks/${id}/status`],
      ['POST', '/api/tasks/reschedule'],
      ['POST', `/api/tasks/${id}/order`],
      ['DELETE', `/api/tasks/${id}`],
      ['POST', `/api/tasks/${id}/occurrences/${TODAY}/complete`],
      ['POST', `/api/tasks/${id}/occurrences/${TODAY}/uncomplete`],
      ['POST', `/api/tasks/${id}/steps`],
      ['PATCH', `/api/tasks/${id}/steps/${uuidv7()}`],
      ['DELETE', `/api/tasks/${id}/steps/${uuidv7()}`],
      ['POST', `/api/tasks/${id}/steps/${uuidv7()}/toggle`],
      ['PUT', `/api/tasks/${id}/steps/order`],
    ] as [string, string][]) {
      const res = await api(ctx, method, path, {
        body: method === 'GET' || method === 'DELETE' ? undefined : {},
      })
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.body.error.code).toBe('auth/missing-token')
    }
    expect(countEventsOfType(ctx, owner.id, 'task/created')).toBe(before)
  })
})

// ─────────────────────────── 新建（§3 / §5） ───────────────────────────

describe('POST /api/tasks（ADR-017 §3 / §5）', () => {
  it('默认值齐全，响应是 { task, created: true }', async () => {
    const account = await freshAccount()
    const taskId = uuidv7()
    const res = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId, title: '写周报' },
    })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(true)
    expect(res.body.task).toMatchObject({
      taskId,
      title: '写周报',
      notes: '',
      importance: 'normal',
      plannedDate: null,
      plannedWeek: null,
      dueDate: null,
      tags: [],
      projectId: null,
      status: 'not_started',
      manualOrder: null,
      recurrence: null,
      recurring: false,
      deletedAt: null,
      steps: [],
    })
    // 实例键 = `task/created` 的 day_key（ADR-013 §1/§2）
    expect(res.body.task.indexDate).toBe(TODAY)
    // 响应里没有账号标识（响应体只含当前账号的数据）
    expect(res.body.task).not.toHaveProperty('accountId')
    expect(res.body.task).not.toHaveProperty('account_id')
  })

  it('**accountId 出现在请求体 → 400**（.strict() 拒绝，不是忽略）', async () => {
    const account = await freshAccount()
    for (const key of ['accountId', 'account_id']) {
      const res = await api(ctx, 'POST', '/api/tasks', {
        token: account.token,
        body: { taskId: uuidv7(), title: '任务', [key]: other.id },
      })
      expect(res.status, key).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
    // 断言它确实**没有**影响归属：任务一条都没建，别的账号也没有多出东西
    expect(countTasks(account.id)).toBe(0)
    expect(countTasks(other.id)).toBe(0)
  })

  it('新建的任务归属于**调用者**（accountId 取自鉴权上下文）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '归属测试' })
    const mine = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(mine.status).toBe(200)
    // 另一个账号看不到它（跨账号 = 不存在）
    const theirs = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: other.token })
    expect(theirs.status).toBe(404)
    expect(readProjection(ctx.db, account.id).tasks[0]!.accountId).toBe(account.id)
  })

  it('幂等：同一 taskId POST 两次 → created: false，任务数仍为 1，**事件数也没多**', async () => {
    const account = await freshAccount()
    const taskId = uuidv7()
    const body = { taskId, title: '双击提交', plannedDate: TODAY }
    const first = await api(ctx, 'POST', '/api/tasks', { token: account.token, body })
    const second = await api(ctx, 'POST', '/api/tasks', { token: account.token, body })

    expect(first.body.created).toBe(true)
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)
    expect(second.body.task.taskId).toBe(taskId)
    expect(second.body.task.createdAt).toBe(first.body.task.createdAt)
    expect(countTasks(account.id)).toBe(1)
    expect(countEventsOfType(ctx, account.id, 'task/created')).toBe(1)
  })

  it('taskId 不是 UUIDv7 → 400（标识形态是契约，不是建议）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: 'not-a-uuid', title: '任务' },
    })
    expect(res.status).toBe(400)
  })

  it('title 非空（ADR-013 §6）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '' },
    })
    expect(res.status).toBe(400)
  })

  it('projectId 指向不存在 / 已删除的项目 → 400（三者同码，不泄露存在性）', async () => {
    const account = await freshAccount()
    const missing = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', projectId: uuidv7() },
    })
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('validation/invalid-input')

    const project = await createProjectViaApi(ctx, account.token, { name: '实验' })
    await api(ctx, 'DELETE', `/api/projects/${project.projectId}`, { token: account.token })
    const deleted = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', projectId: project.projectId },
    })
    expect(deleted.status).toBe(400)
    expect(deleted.body.error.code).toBe('validation/invalid-input')
  })

  it('重复任务带日期锚点 → 400（载荷层的 superRefine 那道）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: {
        taskId: uuidv7(),
        title: '每日复盘',
        plannedDate: TODAY,
        recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: TODAY },
      },
    })
    expect(res.status).toBe(400)
  })

  it('plannedWeek 非周一 → 400；plannedDate 与 plannedWeek 并存 → 400（ADR-016 §1）', async () => {
    const account = await freshAccount()
    const monday = weekStart(TODAY)
    const tuesday = monday === TODAY ? addDays(TODAY, 1) : TODAY

    const notMonday = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', plannedWeek: tuesday },
    })
    expect(notMonday.status, '非周一').toBe(400)

    const both = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', plannedDate: TODAY, plannedWeek: monday },
    })
    expect(both.status, '两个锚点并存').toBe(400)

    const ok = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', plannedWeek: monday },
    })
    expect(ok.status, '周一合法').toBe(200)
    expect(ok.body.task.plannedWeek).toBe(monday)
  })
})

describe('输入上限（ADR-017 §3：恰好等于上限 → 成功；+1 → 400）', () => {
  it('title：500 / 501', async () => {
    const account = await freshAccount()
    const ok = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: 'x'.repeat(500) },
    })
    expect(ok.status).toBe(200)
    const tooLong = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: 'x'.repeat(501) },
    })
    expect(tooLong.status).toBe(400)
  })

  it('notes：20000 / 20001', async () => {
    const account = await freshAccount()
    const ok = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', notes: 'n'.repeat(20000) },
    })
    expect(ok.status).toBe(200)
    const tooLong = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', notes: 'n'.repeat(20001) },
    })
    expect(tooLong.status).toBe(400)
  })

  it('tags：20 个 / 21 个；单个 50 / 51 字符', async () => {
    const account = await freshAccount()
    const ok = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', tags: Array.from({ length: 20 }, (_, i) => `t${i}`) },
    })
    expect(ok.status).toBe(200)
    const tooMany = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
    })
    expect(tooMany.status).toBe(400)

    const okLong = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', tags: ['y'.repeat(50)] },
    })
    expect(okLong.status).toBe(200)
    const tooLong = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', tags: ['y'.repeat(51)] },
    })
    expect(tooLong.status).toBe(400)
  })

  it('steps：100 条 / 101 条', async () => {
    const account = await freshAccount()
    const steps = (n: number) => Array.from({ length: n }, () => ({ id: uuidv7(), title: '步骤' }))
    const ok = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', steps: steps(100) },
    })
    expect(ok.status).toBe(200)
    const tooMany = await api(ctx, 'POST', '/api/tasks', {
      token: account.token,
      body: { taskId: uuidv7(), title: '任务', steps: steps(101) },
    })
    expect(tooMany.status).toBe(400)
  })

  it('reschedule：items 200 条 → 成功；201 条 → 400', async () => {
    const account = await freshAccount()
    // 200 条任务用事件层一次播完（走 HTTP 建 200 条会把 5s 的用例上限撑爆，
    // 而这条用例要测的是**上限**，不是「建 200 条有多快」）
    const taskIds = seedTasks(ctx, account.id, 200)
    const items = (n: number) =>
      taskIds.slice(0, n).map((taskId) => ({ taskId, plannedDate: addDays(TODAY, 1) }))

    const ok = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: items(200) },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.tasks).toHaveLength(200)

    // 第 201 条：超上限即 400（上限是 200，恰好等于上限的那次已经成功）
    const over = taskIds.length >= 201 ? taskIds : seedTasks(ctx, account.id, 201)
    const tooMany = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: over.slice(0, 201).map((taskId) => ({ taskId, plannedDate: addDays(TODAY, 2) })) },
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.code).toBe('validation/invalid-input')
  })
})

describe('tags 的规范化在服务端做一次（ADR-017 §3）', () => {
  it('去首尾空白、丢弃空串、按首次出现顺序去重、大小写不折叠', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, {
      tags: ['  论文  ', '', '   ', 'PCR', 'pcr', '论文', '实验'],
    })
    expect(task.tags).toEqual(['论文', 'PCR', 'pcr', '实验'])
  })
})

// ─────────────────────────────── 读取 ───────────────────────────────

describe('GET /api/tasks（ADR-017 §1.1）', () => {
  it('scope=today 回带服务端算出的 today，且含逾期项（ADR-015 §3 A）', async () => {
    const account = await freshAccount()
    await createTaskViaApi(ctx, account.token, { title: '今天做', plannedDate: TODAY })
    await createTaskViaApi(ctx, account.token, { title: '拖了三天', plannedDate: addDays(TODAY, -3) })
    await createTaskViaApi(ctx, account.token, { title: '明天做', plannedDate: addDays(TODAY, 1) })
    await createTaskViaApi(ctx, account.token, { title: '收件箱' })

    const res = await api(ctx, 'GET', '/api/tasks?scope=today', { token: account.token })
    expect(res.status).toBe(200)
    expect(res.body.today).toBe(TODAY)
    const titles = res.body.items.map((item: any) => item.title)
    expect(titles).toContain('今天做')
    // ⚠️ 「今日」不是区间判定：逾期项**必须**在（ADR-015 §5 的回归）
    expect(titles).toContain('拖了三天')
    expect(titles).not.toContain('明天做')
    // 无日期、未开始的任务不进今日（§3 的 A–F 没有一条命中它）
    expect(titles).not.toContain('收件箱')
    // 排序理由可见（FR2.6），且档位理由恒为一条
    const overdue = res.body.items.find((item: any) => item.title === '拖了三天')
    expect(overdue.reasons).toContain('bucket_overdue')
  })

  it('scope=range 的边界：两端都含；缺参数 / from>to → 400（不返回空数组）', async () => {
    const account = await freshAccount()
    await createTaskViaApi(ctx, account.token, { title: '区间左端', plannedDate: '2026-09-10' })
    await createTaskViaApi(ctx, account.token, { title: '区间右端', plannedDate: '2026-09-20' })
    await createTaskViaApi(ctx, account.token, { title: '区间外', plannedDate: '2026-09-21' })

    const res = await api(ctx, 'GET', '/api/tasks?scope=range&from=2026-09-10&to=2026-09-20', {
      token: account.token,
    })
    const titles = res.body.items.map((item: any) => item.title)
    expect(titles).toContain('区间左端')
    expect(titles).toContain('区间右端')
    expect(titles).not.toContain('区间外')

    const missing = await api(ctx, 'GET', '/api/tasks?scope=range&from=2026-09-10', { token: account.token })
    expect(missing.status).toBe(400)
    const reversed = await api(ctx, 'GET', '/api/tasks?scope=range&from=2026-09-20&to=2026-09-10', {
      token: account.token,
    })
    expect(reversed.status).toBe(400)
  })

  it('scope=week 覆盖整个自然周（两端都含）', async () => {
    const account = await freshAccount()
    await createTaskViaApi(ctx, account.token, { title: '周一', plannedDate: weekStart(TODAY) })
    await createTaskViaApi(ctx, account.token, { title: '周日', plannedDate: weekEnd(TODAY) })
    await createTaskViaApi(ctx, account.token, {
      title: '下周一',
      plannedDate: addDays(weekEnd(TODAY), 1),
    })
    const res = await api(ctx, 'GET', '/api/tasks?scope=week', { token: account.token })
    const titles = res.body.items.map((item: any) => item.title)
    expect(titles).toContain('周一')
    expect(titles).toContain('周日')
    expect(titles).not.toContain('下周一')
  })

  it('scope=project 是**归属**判定：区间外的任务仍出现，区间只体现在分组标注上', async () => {
    const account = await freshAccount()
    // 区间**不含今天**：`isOutsideProjectRange` 会把非重复任务的 `occurrenceKey`
    // （= 创建日 = 今天）也算成一个锚点，若区间含今天，这条断言就测不到东西
    // （见下面那条「已知偏离」用例）。
    const startsOn = addDays(TODAY, -20)
    const endsOn = addDays(TODAY, -5)
    const project = await createProjectViaApi(ctx, account.token, { name: '上旬课题', startsOn, endsOn })
    await createTaskViaApi(ctx, account.token, { title: '项目内', projectId: project.projectId, plannedDate: addDays(TODAY, -10) })
    await createTaskViaApi(ctx, account.token, { title: '项目外', projectId: project.projectId, plannedDate: addDays(TODAY, 40) })
    await createTaskViaApi(ctx, account.token, { title: '无锚点的项目任务', projectId: project.projectId })
    await createTaskViaApi(ctx, account.token, { title: '别的任务' })

    const res = await api(ctx, 'GET', `/api/tasks?scope=project&projectId=${project.projectId}`, {
      token: account.token,
    })
    const items: { title: string; reasons: string[] }[] = res.body.items
    const byTitle = new Map(items.map((item) => [item.title, item]))
    // **归属**：属于 P 的任务一条都不消失，哪怕它的日期全在 P 区间外或压根没有日期
    expect([...byTitle.keys()].sort()).toEqual(['无锚点的项目任务', '项目内', '项目外'])
    expect(byTitle.get('项目外')!.reasons).toContain('outside_project_range')
    expect(byTitle.get('项目内')!.reasons).not.toContain('outside_project_range')

    const noProject = await api(ctx, 'GET', '/api/tasks?scope=project', { token: account.token })
    expect(noProject.status).toBe(400)
  })

  /**
   * 项目视图的分组标注：**排期在项目区间外的任务必须被标出来**。
   *
   * > 这条用例曾经**锁定的是错误行为**——它由 api 实现者写下，当时
   * > `shared/tasks/filter.ts` 的 `isOutsideProjectRange` 把 `item.occurrenceKey`
   * > **无条件**计入锚点，而非重复任务的 `occurrenceKey` 是 `indexDate`（**创建日**）、
   * > 不是排期日。它不能改 `shared/`，于是写了一条以「⚠️ 已知偏离」命名的用例
   * > **锁住当时的错误行为**，并在注释里写明「修好之后它应当翻面」。
   *
   * > **它确实翻面了**：`shared/` 侧修好（`occurrenceKey` 按 `recurring` 分流）之后，
   * > 这条断言立刻红。**这正是它被写成那个形状的意义**——
   * > 若当时它只是被跳过或删掉，这个修复就没有任何东西提醒。
   * > 这也是同一条 bug 的**第三次**发作（`urgencyDates` / `relevantDates` / 这里）。
   */
  it('项目视图：排期在区间外的任务带 outside_project_range（区间含今天也不受影响）', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, {
      name: '含今天',
      startsOn: addDays(TODAY, -5),
      endsOn: addDays(TODAY, 5),
    })
    await createTaskViaApi(ctx, account.token, {
      title: '排期在区间外',
      projectId: project.projectId,
      plannedDate: addDays(TODAY, 40),
    })
    const res = await api(ctx, 'GET', `/api/tasks?scope=project&projectId=${project.projectId}`, {
      token: account.token,
    })
    const item: { reasons: string[]; occurrenceKey: string } = res.body.items[0]
    // 排期在区间外 → 必须被标出来（ADR-015 §5 的分组标注）
    expect(item.reasons).toContain('outside_project_range')
    // 实例键仍是创建日——**这与上面那条判据无关**，两者不该混为一谈：
    // 实例键必须稳定（ADR-013 §2），而分组标注看的是**排期**。
    expect(item.occurrenceKey).toBe(TODAY)
  })

  it('排序与筛选**不在服务端参数里**：多给一个参数即 400（不静默忽略）', async () => {
    const account = await freshAccount()
    for (const suffix of ['&sort=due', '&status=completed', '&tags=a']) {
      const res = await api(ctx, 'GET', `/api/tasks?scope=all${suffix}`, { token: account.token })
      expect(res.status, suffix).toBe(400)
    }
  })

  /**
   * **已放弃的任务必须能被找到**（ADR-015 §4：「否则用户无法重新打开它」）。
   *
   * 这条用例来自一次真实缺陷：服务端四个非今日 scope 最初都没传 `status`，
   * 于是 `queryItems` 走了**默认视图**判据（排除已放弃）——前端手里的 `items`
   * 里根本没有已放弃的行，**「已放弃」与「全部」两个筛选永远是空的**。
   *
   * 状态筛选属 FR2.6 的**前端**职责（ADR-017 §1.1 的分工：服务端不做筛选），
   * 故服务端传 `status: 'all'` 把整集交出去；而**今日视图的门槛不受影响**——
   * 它是 ADR-015 §3 的**入选规则**（`status !== 'abandoned'` 写在 `selectionReasons` 里），
   * 与筛选器无关，不由调用方传参决定。
   */
  it('已放弃的任务：出现在 scope=all 与 scope=project 里，**不出现在** scope=today 里', async () => {
    const account = await freshAccount()
    const project = await createProjectViaApi(ctx, account.token, {
      name: '项目',
      startsOn: addDays(TODAY, -3),
      endsOn: addDays(TODAY, 3),
    })
    const task = await createTaskViaApi(ctx, account.token, {
      title: '要放弃的',
      projectId: project.projectId,
      plannedDate: TODAY,
    })
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })

    const all = await api(ctx, 'GET', '/api/tasks?scope=all', { token: account.token })
    expect(all.body.items.map((item: any) => item.title)).toContain('要放弃的')

    const projectView = await api(ctx, 'GET', `/api/tasks?scope=project&projectId=${project.projectId}`, {
      token: account.token,
    })
    expect(projectView.body.items.map((item: any) => item.title)).toContain('要放弃的')

    // 今日视图的**入选规则**里那道 status 门槛仍然生效（ADR-015 §3）
    const today = await api(ctx, 'GET', '/api/tasks?scope=today', { token: account.token })
    expect(today.body.items.map((item: any) => item.title)).not.toContain('要放弃的')
  })

  it('已软删除的任务不出现在任何 scope 里', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '要删的', plannedDate: TODAY })
    await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    for (const scope of ['today', 'all', `range&from=${TODAY}&to=${TODAY}`]) {
      const res = await api(ctx, 'GET', `/api/tasks?scope=${scope}`, { token: account.token })
      expect(res.body.items.map((item: any) => item.title)).not.toContain('要删的')
    }
  })
})

describe('GET /api/tasks/:id（ADR-017 §1.1）', () => {
  it('返回 task / occurrences / steps，且 today 与 occurrenceKey 自洽', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, {
      title: '明细',
      notes: '备注',
      importance: 'high',
      tags: ['a'],
      steps: [{ id: uuidv7(), title: '第一步' }],
      plannedDate: TODAY,
    })
    const res = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(res.status).toBe(200)
    expect(res.body.task.taskId).toBe(task.taskId)
    expect(res.body.task.notes).toBe('备注')
    expect(res.body.steps.map((step: any) => step.title)).toEqual(['第一步'])
    expect(res.body.steps[0].checkedAt).toBeNull()
    expect(res.body.steps[0].taskId).toBeUndefined // TodoItemStep 只带 id/title/checkedAt
    // 非重复任务的实例键恒为 indexDate（ADR-015 §2）
    expect(res.body.occurrenceKey).toBe(task.indexDate)
    expect(res.body.today).toBe(TODAY)
    expect(res.body.occurrences.map((r: any) => r.originalPlannedDate)).toEqual([task.indexDate])
    expect(res.body.carryCount).toBe(0)
    expect(res.body.reschedules).toEqual([])
  })

  it('已软删除的任务 → 404（软删除 = 从所有视图消失）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    const res = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not-found')
  })

  it('跨账号 :id 一律 404，且响应体与「不存在」**逐字相同**（ADR-017 §后果）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: 'A 的任务' })
    const missingId = uuidv7()
    for (const [method, path, body] of taskRoutes(task.taskId)) {
      const cross = await api(ctx, method, path, { token: other.token, body })
      const absent = await api(ctx, method, path.replace(task.taskId, missingId), {
        token: other.token,
        body,
      })
      expect(cross.status, `${method} ${path}`).toBe(404)
      expect(absent.status, `${method} ${path}`).toBe(404)
      expect(cross.body.error.code).toBe('not-found')
      // 「存在但不属于你」与「不存在」必须无法区分：把消息里的 id 抹掉再比
      expect(JSON.stringify(cross.body).replaceAll(task.taskId, 'X'), `${method} ${path}`).toBe(
        JSON.stringify(absent.body).replaceAll(missingId, 'X'),
      )
    }
  })
})

// ─────────────────────────── PATCH（整行快照） ───────────────────────────

describe('PATCH /api/tasks/:id（ADR-017 §4）', () => {
  it('只给 title：事件载荷是**整行快照**，其余字段逐字保留', async () => {
    const account = await freshAccount()
    const step = { id: uuidv7(), title: '第一步' }
    const task = await createTaskViaApi(ctx, account.token, {
      title: '原标题',
      notes: '原备注',
      importance: 'high',
      tags: ['a', 'b'],
      plannedDate: TODAY,
      dueDate: addDays(TODAY, 3),
      steps: [step],
    })
    const res = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}`, {
      token: account.token,
      body: { title: '新标题' },
    })
    expect(res.status).toBe(200)
    expect(res.body.task).toMatchObject({
      title: '新标题',
      notes: '原备注',
      importance: 'high',
      tags: ['a', 'b'],
      plannedDate: TODAY,
      dueDate: addDays(TODAY, 3),
    })
    expect(res.body.task.steps.map((s: any) => s.title)).toEqual(['第一步'])

    // 事件载荷是整行（重放不依赖「前一条事件一定在」）
    const updated = readAccountEvents(ctx.db, account.id).filter((event) => event.type === 'task/updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]!.payload).toMatchObject({
      taskId: task.taskId,
      title: '新标题',
      notes: '原备注',
      importance: 'high',
      tags: ['a', 'b'],
      projectId: null,
      recurrence: null,
    })
    // 不携带日期锚点（ADR-016 §9 行 3：创建之后它们只由 task/rescheduled 写）
    expect(updated[0]!.payload).not.toHaveProperty('plannedDate')
    expect(updated[0]!.payload).not.toHaveProperty('plannedWeek')
    expect(updated[0]!.payload).not.toHaveProperty('dueDate')
  })

  it('给专属路由的字段 → 400（**不静默忽略**）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    for (const body of [
      { status: 'abandoned' },
      { steps: [] },
      { plannedDate: TODAY },
      { plannedWeek: weekStart(TODAY) },
      { dueDate: TODAY },
      { manualOrder: 1 },
      { taskId: uuidv7() },
      { accountId: other.id },
      { deletedAt: '2026-09-23T10:00:00+08:00' },
      { indexDate: TODAY },
    ]) {
      const res = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}`, { token: account.token, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
    // 一个字都没写
    expect(countEventsOfType(ctx, account.id, 'task/updated')).toBe(0)
  })

  it('**跨行守卫**：给已有日期锚点的任务加重复规则 → 400（ADR-013 §3.1 第 2 道）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const res = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}`, {
      token: account.token,
      body: {
        recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: TODAY },
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
    expect(res.body.error.message).toContain('plannedDate')

    // 先清空锚点再换轴 → 成功（ADR-013 §3.3 的「换轴」路径）
    const cleared = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: null, plannedWeek: null, dueDate: null }] },
    })
    expect(cleared.status).toBe(200)
    const converted = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}`, {
      token: account.token,
      body: {
        recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: TODAY },
      },
    })
    expect(converted.status).toBe(200)
    expect(converted.body.task.recurring).toBe(true)
    expect(converted.body.task.plannedDate).toBeNull()
  })

  it('已放弃的任务也能改定义（改名不是状态迁移）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    const res = await api(ctx, 'PATCH', `/api/tasks/${task.taskId}`, {
      token: account.token,
      body: { title: '放弃后改名' },
    })
    expect(res.status).toBe(200)
    expect(res.body.task).toMatchObject({ title: '放弃后改名', status: 'abandoned' })
  })
})

// ─────────────────────────── 状态迁移（§1.1 / ADR-013 §2） ───────────────────────────

describe('POST /api/tasks/:id/status（ADR-013 §2）', () => {
  it('合法边逐条可走', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    for (const to of ['in_progress', 'not_started', 'abandoned', 'not_started']) {
      const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
        token: account.token,
        body: { to },
      })
      expect(res.status, `→ ${to}`).toBe(200)
      expect(res.body.task.status).toBe(to)
    }
  })

  it('非法迁移 → 409 conflict/status-transition（已放弃 → 进行中）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'in_progress' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/status-transition')
  })

  it('重复任务转「进行中」→ 409（可达性约束，不是第二套状态机）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, {
      title: '每日复盘',
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: TODAY },
    })
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'in_progress' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/status-transition')
  })

  it('同值 → 200（事件只带 to、本身幂等；拒掉会让重试变成 409）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'not_started' },
    })
    expect(res.status).toBe(200)
  })

  it('**已完成 → 已放弃**：成功、只写一条事件、完成记录保留（ADR-017 §后果）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { title: '做完再放弃', plannedDate: TODAY })
    const completed = await api(
      ctx,
      'POST',
      `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`,
      { token: account.token },
    )
    expect(completed.status).toBe(200)
    expect(completed.body.item.completedAt).not.toBeNull()

    const before = readAccountEvents(ctx.db, account.id).length
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    expect(res.status).toBe(200)
    expect(res.body.task.status).toBe('abandoned')

    const appended = readAccountEvents(ctx.db, account.id).slice(before)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.type).toBe('task/status-changed')
    expect(appended[0]!.payload).toEqual({ taskId: task.taskId, to: 'abandoned' })
    // **没有**取消完成事件，既有完成记录保留（Logseq 教训的回归）
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-uncompleted')).toBe(0)
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-completed')).toBe(1)

    // 读路径上那条轮次仍然是「已完成」（历史不抹除），而**档位是 5**——
    // `abandoned` 压过「本实例已完成」（ADR-015 §4 的优先级表：已放弃的
    // **不得呈现为已完成**，否则它会排进「已完成」里，与 01 FR2.1 v1.4 相反）。
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.occurrences[0]).toMatchObject({ status: 'completed' })
    const all = await api(ctx, 'GET', '/api/tasks?scope=all', { token: account.token })
    const row: { title: string; reasons: string[]; status: string; overdue: boolean } =
      all.body.items.find((item: any) => item.title === '做完再放弃')
    expect(row.status).toBe('abandoned')
    expect(row.reasons).toContain('bucket_abandoned')
    expect(row.reasons).not.toContain('bucket_done')
    // 已放弃的逾期任务不再被催（overdue 恒为 false）——档位与标红是两件事
    expect(row.overdue).toBe(false)
  })

  it('重复任务已完成过若干轮 → 放弃：只写一条状态事件，**既有完成记录全部保留**', async () => {
    const account = await freshAccount()
    const startsOn = addDays(TODAY, -4)
    const task = await createTaskViaApi(ctx, account.token, {
      title: '每日复盘',
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn },
    })
    // 直接播种两条完成事件（历轮次的完成只能由真实的日子累积，测试用事件层构造）
    seedCompletion(ctx, account.id, task.taskId, addDays(TODAY, -2), addDays(TODAY, -1))
    seedCompletion(ctx, account.id, task.taskId, addDays(TODAY, -1), TODAY)

    const before = readAccountEvents(ctx.db, account.id).length
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    expect(res.status).toBe(200)
    expect(res.body.task.status).toBe('abandoned')

    const appended = readAccountEvents(ctx.db, account.id).slice(before)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.type).toBe('task/status-changed')
    expect(countEventsOfType(ctx, account.id, 'task/occurrence-completed')).toBe(2)

    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    const completed = detail.body.occurrences.filter((round: any) => round.status === 'completed')
    expect(completed.map((round: any) => round.originalPlannedDate)).toEqual([
      addDays(TODAY, -2),
      addDays(TODAY, -1),
    ])
  })

  it('已放弃的任务不可完成 → 409 conflict/task-not-completable', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: account.token,
      body: { to: 'abandoned' },
    })
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: account.token,
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/task-not-completable')
  })

  it('已删除的任务不可完成 → 409（不是 404：任务存在，只是不能完成）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: account.token,
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/task-not-completable')
  })
})

// ─────────────────────────── 顺延（§9） ───────────────────────────

describe('POST /api/tasks/reschedule（ADR-017 §9）', () => {
  it('单条即 items.length === 1；事件载荷六个日期字段全显式', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, {
      plannedDate: TODAY,
      dueDate: addDays(TODAY, 2),
    })
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: addDays(TODAY, 1) }] },
    })
    expect(res.status).toBe(200)
    expect(res.body.tasks[0]).toMatchObject({
      plannedDate: addDays(TODAY, 1),
      // 省略 = 保持原值（见下一条用例的理由）
      dueDate: addDays(TODAY, 2),
      plannedWeek: null,
    })
    const event = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/rescheduled')!
    expect(event.payload).toEqual({
      taskId: task.taskId,
      fromPlannedDate: TODAY,
      toPlannedDate: addDays(TODAY, 1),
      fromPlannedWeek: null,
      toPlannedWeek: null,
      fromDueDate: addDays(TODAY, 2),
      toDueDate: addDays(TODAY, 2),
    })
  })

  it('省略 = 保持原值；`null` = 清空（顺延不会顺手清掉期限）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, {
      plannedDate: TODAY,
      dueDate: addDays(TODAY, 2),
    })
    const kept = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: addDays(TODAY, 1) }] },
    })
    expect(kept.body.tasks[0].dueDate).toBe(addDays(TODAY, 2))

    const cleared = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: null, dueDate: null }] },
    })
    expect(cleared.body.tasks[0]).toMatchObject({ plannedDate: null, dueDate: null })
  })

  it('批量：N 条事件**共用同一个 batchId**（「一个请求 = 一个批次」）', async () => {
    const account = await freshAccount()
    const a = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const b = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: {
        items: [
          { taskId: a.taskId, plannedDate: addDays(TODAY, 5) },
          { taskId: b.taskId, plannedDate: addDays(TODAY, 6) },
        ],
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.tasks.map((task: any) => task.taskId)).toEqual([a.taskId, b.taskId])

    const events = readAccountEvents(ctx.db, account.id).filter((e) => e.type === 'task/rescheduled')
    expect(events).toHaveLength(2)
    expect(new Set(events.map((event) => event.batchId)).size).toBe(1)
  })

  it('**整批原子**：任一任务不存在 → 404，且一条事件都不写、第一条任务也不动', async () => {
    const account = await freshAccount()
    const good = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const before = readAccountEvents(ctx.db, account.id).length

    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: {
        items: [
          { taskId: good.taskId, plannedDate: addDays(TODAY, 3) },
          { taskId: uuidv7(), plannedDate: addDays(TODAY, 3) },
        ],
      },
    })
    expect(res.status).toBe(404)
    expect(readAccountEvents(ctx.db, account.id)).toHaveLength(before)
    const still = await api(ctx, 'GET', `/api/tasks/${good.taskId}`, { token: account.token })
    expect(still.body.task.plannedDate).toBe(TODAY) // 「一半挪了一半没挪」不存在
  })

  it('任一任务是重复任务 → 整批 409 conflict/date-driven-by-rule', async () => {
    const account = await freshAccount()
    const plain = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const recurring = await createTaskViaApi(ctx, account.token, {
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: TODAY },
    })
    const before = readAccountEvents(ctx.db, account.id).length
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: {
        items: [
          { taskId: plain.taskId, plannedDate: addDays(TODAY, 3) },
          { taskId: recurring.taskId, plannedDate: addDays(TODAY, 3) },
        ],
      },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/date-driven-by-rule')
    expect(readAccountEvents(ctx.db, account.id)).toHaveLength(before)
  })

  it('同一任务在 items 里出现两次 → 400（批次内两条顺延的前后值会互相矛盾）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: {
        items: [
          { taskId: task.taskId, plannedDate: addDays(TODAY, 1) },
          { taskId: task.taskId, plannedDate: addDays(TODAY, 2) },
        ],
      },
    })
    expect(res.status).toBe(400)
  })

  it('items 为空 → 400（单条顺延即 length === 1）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [] },
    })
    expect(res.status).toBe(400)
  })

  it('前后值完全相同的 item **不写事件**（carryCount 是事件条数，不能凭空加一次「拖过」）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY, dueDate: addDays(TODAY, 2) })
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: TODAY, dueDate: addDays(TODAY, 2) }] },
    })
    expect(res.status).toBe(200)
    expect(res.body.tasks[0].plannedDate).toBe(TODAY)
    expect(countEventsOfType(ctx, account.id, 'task/rescheduled')).toBe(0)
  })
})

describe('carryCount 是派生量（ADR-013 §4.3）', () => {
  it('顺延两次 → 明细里计数为 2；撤销第二次顺延的批次 → 回到 1', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })

    await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: addDays(TODAY, 1) }] },
    })
    const second = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: { items: [{ taskId: task.taskId, plannedDate: addDays(TODAY, 2) }] },
    })
    expect(second.status).toBe(200)

    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.carryCount).toBe(2)
    expect(detail.body.reschedules).toHaveLength(2)
    expect(detail.body.reschedules[0]).toMatchObject({ fromPlannedDate: TODAY, toPlannedDate: addDays(TODAY, 1) })

    // 撤销第二次顺延（batchId 从流水里取：它是那次动作的批次）
    const events = readAccountEvents(ctx.db, account.id).filter((e) => e.type === 'task/rescheduled')
    const undo = await api(ctx, 'POST', '/api/undo', {
      token: account.token,
      body: { batchId: events[1]!.batchId },
    })
    expect(undo.status).toBe(200)

    const after = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(after.body.carryCount).toBe(1) // 落库的话这条必然红
    expect(after.body.task.plannedDate).toBe(addDays(TODAY, 1))
  })
})

// ─────────────────────────── 手动排序（§1.1） ───────────────────────────

describe('POST /api/tasks/:id/order', () => {
  it('写入 manualOrder 并回读', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/order`, {
      token: account.token,
      body: { manualOrder: 1.5 },
    })
    expect(res.status).toBe(200)
    expect(res.body.task.manualOrder).toBe(1.5)
  })

  it('非有限数 / 非数字 → 400（NaN 经 JSON 会变成 null，那是另一个值）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    for (const manualOrder of ['1', null, true, {}]) {
      const res = await api(ctx, 'POST', `/api/tasks/${task.taskId}/order`, {
        token: account.token,
        body: { manualOrder },
      })
      expect(res.status, JSON.stringify(manualOrder)).toBe(400)
    }
  })
})

// ─────────────────────────── 删除（ADR-013 §4.8） ───────────────────────────

describe('DELETE /api/tasks/:id', () => {
  it('返回 { taskId, batchId }；软删除（行还在、deletedAt 置位）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const res = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(res.status).toBe(200)
    expect(res.body.taskId).toBe(task.taskId)
    expect(typeof res.body.batchId).toBe('string')

    const row = readProjection(ctx.db, account.id).tasks.find((t) => t.id === task.taskId)!
    expect(row.deletedAt).not.toBeNull() // 行还在（软删除），事件流水也保留
    expect(countEventsOfType(ctx, account.id, 'task/created')).toBe(1)
  })

  it('重复删除 → 404（它已从所有视图消失）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token)
    await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    const again = await api(ctx, 'DELETE', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(again.status).toBe(404)
  })
})

// ─────────────────── 事务（ADR-002 §1 / ADR-017 §后果） ───────────────────

/**
 * 「一次用户动作 = 一个批次 = 一个事务」——**事件与投影同事务提交**。
 *
 * 这条纪律的可执行形态有两半，两半都要测：
 *
 * 1. **结构性强制**：服务层的写函数在事务外调用即抛错（`assertInTransaction`）。
 *    没有它，「事件已写、投影未更新」的中间态不会被平时的查询发现，
 *    只在下次重放时以「数字对不上」的形式浮现（架构文档 §4）；
 * 2. **失败即整批不写**：请求失败时事件与投影**都不变**——回滚后两者都不存在，
 *    不会留下「事件多了一条、投影没动」或反之的半截状态。
 */
describe('事务：事件与投影同事务（ADR-002 §1）', () => {
  it('服务层写函数在事务外调用 → 抛错（不替你开事务）', async () => {
    const account = await freshAccount()
    expect(() =>
      createTask(ctx.db, account.id, new Date(), {
        taskId: uuidv7(),
        title: '事务外',
        notes: '',
        importance: 'normal',
        plannedDate: null,
        plannedWeek: null,
        dueDate: null,
        tags: [],
        projectId: null,
        recurrence: null,
        steps: [],
      }),
    ).toThrow(/事务/)
    // 一个字都没写进去
    expect(countEventsOfType(ctx, account.id, 'task/created')).toBe(0)
    expect(countTasks(account.id)).toBe(0)
  })

  it('失败的写请求：事件数与投影**都不变**（回滚后两者都不存在）', async () => {
    const account = await freshAccount()
    const task = await createTaskViaApi(ctx, account.token, { plannedDate: TODAY })
    const eventsBefore = readAccountEvents(ctx.db, account.id).length
    const projectionBefore = readProjection(ctx.db, account.id)

    // 批量顺延：第二条指向另一个账号的任务 → 整批 404
    const res = await api(ctx, 'POST', '/api/tasks/reschedule', {
      token: account.token,
      body: {
        items: [
          { taskId: task.taskId, plannedDate: addDays(TODAY, 2) },
          { taskId: (await createTaskViaApi(ctx, other.token)).taskId, plannedDate: addDays(TODAY, 2) },
        ],
      },
    })
    expect(res.status).toBe(404)
    expect(readAccountEvents(ctx.db, account.id)).toHaveLength(eventsBefore)
    expect(readProjection(ctx.db, account.id)).toEqual(projectionBefore)
  })
})

// ─────────────────── AnchorInvariantError 的接线（ADR-017 §2） ───────────────────

describe('AnchorInvariantError → 500，且日志带上 taskId 与 originalPlannedDate', () => {
  it('坏的完成事件让列表返回 500（**不降级成 4xx、不吞掉**），日志可查', async () => {
    const logs: { message: string; detail: unknown }[] = []
    const guarded = await startTestServer({}, { logError: (message, detail) => logs.push({ message, detail }) })
    try {
      const account = await createOwnerAccount(guarded, 'anchor-user')
      const task = await createTaskViaApi(guarded, account.token, {
        title: '坏锚点',
        recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: addDays(TODAY, -1) },
      })
      // 一条**违反锚点不变式**的完成事件（`next` 不晚于本轮原计划日）：
      // 事件层照收（阶段 2 的测试明文锁定），于是错误在读时才现形。
      const bad = addDays(TODAY, -1)
      guarded.db.transaction(() =>
        appendEvents(guarded.db, account.id, [
          {
            type: 'task/occurrence-completed',
            occurredAt: `${bad}T10:00:00+08:00`,
            payload: {
              taskId: task.taskId,
              originalPlannedDate: bad,
              completedDayKey: bad,
              next: { date: bad, mode: 'catch_up' },
            },
          },
        ]),
      )()

      const res = await api(guarded, 'GET', '/api/tasks?scope=all', { token: account.token })
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('server/internal-error')
      // 响应体不泄露内部细节
      expect(JSON.stringify(res.body)).not.toContain('originalPlannedDate')

      const entry = logs.find((log) => log.message.includes('锚点不变式'))
      expect(entry, '日志里必须有一条锚点不变式的记录').toBeDefined()
      expect(entry!.detail).toMatchObject({ taskId: task.taskId, originalPlannedDate: bad })
    } finally {
      await guarded.close()
    }
  })
})

/**
 * 直接播种 n 条任务（事件层一次写完）。**只用于「要很多条数据」的用例**——
 * 走 HTTP 建 200 条会撞上 vitest 的 5s 用例上限，而那种用例要测的是上限本身。
 */
function seedTasks(ctx: TestContext, accountId: string, n: number): string[] {
  const ids = Array.from({ length: n }, () => uuidv7())
  ctx.db.transaction(() =>
    appendEvents(
      ctx.db,
      accountId,
      ids.map((taskId) => ({
        type: 'task/created' as const,
        occurredAt: `${TODAY}T10:00:00+08:00`,
        payload: {
          taskId,
          title: '批量任务',
          notes: '',
          importance: 'normal' as const,
          plannedDate: TODAY,
          plannedWeek: null,
          dueDate: null,
          tags: [],
          projectId: null,
          recurrence: null,
          steps: [],
        },
      })),
    ),
  )()
  return ids
}

/** 直接播种一条完成事件（历轮次的完成只能由真实的日子累积，测试用事件层构造） */
function seedCompletion(
  ctx: TestContext,
  accountId: string,
  taskId: string,
  key: string,
  next: string,
): void {
  ctx.db.transaction(() =>
    appendEvents(ctx.db, accountId, [
      {
        type: 'task/occurrence-completed',
        occurredAt: `${key}T10:00:00+08:00`,
        payload: {
          taskId,
          originalPlannedDate: key,
          completedDayKey: key,
          next: { date: next, mode: 'catch_up' },
        },
      },
    ]),
  )()
}

/** 未使用但保留：`compareDayKey` 供后续边界用例直接引用（本文件目前用字符串比较足够） */
void compareDayKey
