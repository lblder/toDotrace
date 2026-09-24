import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, dayStartInstant } from '@shared/time'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { uuidv7 } from '../lib/uuid.js'
import { createTask } from '../tasks/service.js'
import { startTimer } from '../timer/service.js'
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

async function account(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `timer${seq}`)
}

function timer(token: string) {
  return api(ctx, 'GET', '/api/timer', { token })
}

function start(token: string, taskId: string, occurrenceKey: string) {
  return api(ctx, 'POST', '/api/timer/start', { token, body: { taskId, occurrenceKey } })
}

function pause(token: string, sessionId: string) {
  return api(ctx, 'POST', '/api/timer/pause', { token, body: { sessionId } })
}

describe('任务计时 API', () => {
  it('新建时原子配置；开始幂等、同账号单运行、暂停和续计均按实例保存', async () => {
    const a = await account()
    expect((await api(ctx, 'GET', '/api/timer')).status).toBe(401)
    const first = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const second = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const created = readAccountEvents(ctx.db, a.id).filter((event) =>
      event.targetId === first.taskId && ['task/created', 'task/timer-configured'].includes(event.type))
    expect(created).toHaveLength(2)
    expect(created[0]!.batchId).toBe(created[1]!.batchId)

    const running = await start(a.token, first.taskId, first.indexDate)
    expect(running.status).toBe(200)
    expect(running.body.active).toMatchObject({ taskId: first.taskId, occurrenceKey: first.indexDate })
    expect(running.body.tasks).toContainEqual({ taskId: first.taskId, enabled: true })
    const firstStartEvents = readAccountEvents(ctx.db, a.id)
      .filter((event) => event.targetId === first.taskId &&
        ['task/status-changed', 'task/timer-started'].includes(event.type))
    expect(firstStartEvents).toHaveLength(2)
    expect(firstStartEvents[0]!.batchId).toBe(firstStartEvents[1]!.batchId)
    expect(firstStartEvents[0]!.payload).toMatchObject({ to: 'in_progress' })
    expect((await api(ctx, 'GET', `/api/tasks/${first.taskId}`, { token: a.token })).body.task.status)
      .toBe('in_progress')
    expect((await timer(a.token)).body.active.sessionId).toBe(running.body.active.sessionId)
    expect((await start(a.token, first.taskId, first.indexDate)).body.active.sessionId)
      .toBe(running.body.active.sessionId)
    expect(readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'task/timer-started')).toHaveLength(1)

    const blocked = await start(a.token, second.taskId, second.indexDate)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('conflict/timer-running')

    const paused = await pause(a.token, running.body.active.sessionId)
    expect(paused.status).toBe(200)
    expect(paused.body.active).toBeNull()
    expect(paused.body.sessions).toHaveLength(1)
    expect(paused.body.sessions[0]).toMatchObject({
      taskId: first.taskId,
      occurrenceKey: first.indexDate,
      sessionId: running.body.active.sessionId,
    })
    expect((await pause(a.token, running.body.active.sessionId)).body.sessions).toHaveLength(1)
    const resumed = await start(a.token, first.taskId, first.indexDate)
    expect(resumed.status).toBe(200)
    expect(resumed.body.active.sessionId).not.toBe(running.body.active.sessionId)
    expect(resumed.body.sessions).toHaveLength(1)
  })

  it('完成实例与停止同事务但独立批次；取消完成不会自动恢复计时', async () => {
    const a = await account()
    const task = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const running = await start(a.token, task.taskId, task.indexDate)
    expect(running.status).toBe(200)
    const done = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
      token: a.token,
    })
    expect(done.status).toBe(200)
    const events = readAccountEvents(ctx.db, a.id)
    const completion = events.find((event) => event.type === 'task/occurrence-completed')!
    const stop = events.find((event) => event.type === 'task/timer-stopped')!
    expect(completion.batchId).not.toBe(stop.batchId)
    expect((await timer(a.token)).body.active).toBeNull()
    expect((await start(a.token, task.taskId, task.indexDate)).status).toBe(409)

    const undone = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/uncomplete`, {
      token: a.token,
    })
    expect(undone.status).toBe(200)
    expect((await timer(a.token)).body.active).toBeNull()
  })

  it('撤销完成、删除、放弃只撤任务动作，不把停止后的空档重新计入计时', async () => {
    const a = await account()

    const completable = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    await start(a.token, completable.taskId, completable.indexDate)
    expect((await api(ctx, 'POST', `/api/tasks/${completable.taskId}/occurrences/${completable.indexDate}/complete`, {
      token: a.token,
    })).status).toBe(200)
    const completion = readAccountEvents(ctx.db, a.id)
      .find((event) => event.type === 'task/occurrence-completed' && event.targetId === completable.taskId)!
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: completion.batchId },
    })).status).toBe(200)
    expect((await timer(a.token)).body.active).toBeNull()
    expect((await timer(a.token)).body.sessions).toHaveLength(1)
    expect((await api(ctx, 'GET', `/api/tasks/${completable.taskId}`, { token: a.token })).body.task.deletedAt)
      .toBeNull()
    const afterCompletionUndo = await api(ctx, 'GET', '/api/tasks?scope=completed', { token: a.token })
    expect(afterCompletionUndo.body.items.some((item: any) => item.taskId === completable.taskId)).toBe(false)

    const deletable = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    await start(a.token, deletable.taskId, deletable.indexDate)
    const deleted = await api(ctx, 'DELETE', `/api/tasks/${deletable.taskId}`, { token: a.token })
    expect(deleted.status).toBe(200)
    const deleteStop = readAccountEvents(ctx.db, a.id)
      .filter((event) => event.type === 'task/timer-stopped' && event.targetId === deletable.taskId)
    expect(deleteStop).toHaveLength(1)
    expect(deleteStop[0]!.batchId).not.toBe(deleted.body.batchId)
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: deleted.body.batchId },
    })).status).toBe(200)
    expect((await api(ctx, 'GET', `/api/tasks/${deletable.taskId}`, { token: a.token })).body.task.deletedAt)
      .toBeNull()
    expect((await timer(a.token)).body.active).toBeNull()

    const abandonable = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    await start(a.token, abandonable.taskId, abandonable.indexDate)
    expect((await api(ctx, 'POST', `/api/tasks/${abandonable.taskId}/status`, {
      token: a.token, body: { to: 'abandoned' },
    })).status).toBe(200)
    const abandoned = readAccountEvents(ctx.db, a.id)
      .find((event) => event.type === 'task/status-changed'
        && event.targetId === abandonable.taskId
        && (event.payload as { to: string }).to === 'abandoned')!
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: abandoned.batchId },
    })).status).toBe(200)
    expect((await api(ctx, 'GET', `/api/tasks/${abandonable.taskId}`, { token: a.token })).body.task.status)
      .toBe('in_progress')
    expect((await timer(a.token)).body.active).toBeNull()
  })

  it('停表写入失败时，完成事件和任务状态一并回滚，原计时继续', async () => {
    const a = await account()
    const task = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const started = await start(a.token, task.taskId, task.indexDate)
    expect(started.status).toBe(200)
    const before = readAccountEvents(ctx.db, a.id).length
    ctx.db.exec(`CREATE TRIGGER fail_timer_stop BEFORE INSERT ON events
      WHEN NEW.type = 'task/timer-stopped' BEGIN SELECT RAISE(ABORT, 'forced timer stop failure'); END`)
    try {
      const failed = await api(ctx, 'POST', `/api/tasks/${task.taskId}/occurrences/${task.indexDate}/complete`, {
        token: a.token,
      })
      expect(failed.status).toBe(500)
      expect(readAccountEvents(ctx.db, a.id)).toHaveLength(before)
      expect((await timer(a.token)).body.active.sessionId).toBe(started.body.active.sessionId)
      expect((await api(ctx, 'GET', '/api/tasks?scope=completed', { token: a.token })).body.items)
        .toEqual([])
    } finally {
      ctx.db.exec('DROP TRIGGER fail_timer_stop')
    }
  })

  it('拒绝未配置、未来重复轮次、他账号和已放弃任务；禁用/放弃/删除会收束运行片段', async () => {
    const a = await account()
    const b = await account()
    const disabled = await createTaskViaApi(ctx, a.token)
    const task = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const future = await createTaskViaApi(ctx, a.token, {
      pomodoroEnabled: true,
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: addDays(todayKey(), 3),
      },
    })
    expect((await start(a.token, disabled.taskId, disabled.indexDate)).body.error.code)
      .toBe('conflict/timer-disabled')
    expect((await start(a.token, future.taskId, addDays(todayKey(), 3))).status).toBe(404)
    expect((await api(ctx, 'GET', `/api/tasks/${future.taskId}`, { token: a.token })).body.task.status)
      .toBe('not_started')
    expect((await start(b.token, task.taskId, task.indexDate)).status).toBe(404)
    expect((await api(ctx, 'PUT', `/api/timer/tasks/${task.taskId}`, {
      token: b.token, body: { enabled: false },
    })).status).toBe(404)

    const running = await start(a.token, task.taskId, task.indexDate)
    expect((await pause(b.token, running.body.active.sessionId)).status).toBe(404)
    const disabledResult = await api(ctx, 'PUT', `/api/timer/tasks/${task.taskId}`, {
      token: a.token, body: { enabled: false },
    })
    expect(disabledResult.status).toBe(200)
    expect(disabledResult.body.active).toBeNull()
    expect(disabledResult.body.sessions).toHaveLength(1)

    await api(ctx, 'PUT', `/api/timer/tasks/${task.taskId}`, { token: a.token, body: { enabled: true } })
    expect((await start(a.token, task.taskId, task.indexDate)).status).toBe(200)
    const abandoned = await api(ctx, 'POST', `/api/tasks/${task.taskId}/status`, {
      token: a.token, body: { to: 'abandoned' },
    })
    expect(abandoned.status).toBe(200)
    expect((await timer(a.token)).body.active).toBeNull()
    expect((await start(a.token, task.taskId, task.indexDate)).status).toBe(409)

    const deletable = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    expect((await start(a.token, deletable.taskId, deletable.indexDate)).status).toBe(200)
    expect((await api(ctx, 'DELETE', `/api/tasks/${deletable.taskId}`, { token: a.token })).status).toBe(200)
    expect((await timer(a.token)).body.active).toBeNull()

    const repeating = await createTaskViaApi(ctx, a.token, {
      pomodoroEnabled: true,
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: todayKey(),
      },
    })
    const repeatingStart = await start(a.token, repeating.taskId, todayKey())
    expect(repeatingStart.status).toBe(200)
    expect((await api(ctx, 'GET', `/api/tasks/${repeating.taskId}`, { token: a.token })).body.task.status)
      .toBe('not_started')
  })

  it('25 分钟后不自动停表，跨日累计取绝对时刻；撤销停止事件后重放仍仅一条运行', async () => {
    const a = await account()
    const task = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const startedAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    ctx.db.transaction(() => appendEvents(ctx.db, a.id, [{
      type: 'task/timer-started',
      occurredAt: startedAt,
      payload: { taskId: task.taskId, occurrenceKey: task.indexDate },
    }]))()
    const before = await timer(a.token)
    expect(before.body.active.taskId).toBe(task.taskId)
    expect(before.body.sessions).toEqual([])
    const paused = await pause(a.token, before.body.active.sessionId)
    expect(paused.body.sessions[0].elapsedSeconds).toBeGreaterThan(25 * 60)
    expect(paused.body.sessions[0].elapsedSeconds).toBeGreaterThan(24 * 60 * 60)

    const pauseEvent = readAccountEvents(ctx.db, a.id).find((event) => event.type === 'task/timer-stopped')!
    const next = await start(a.token, task.taskId, task.indexDate)
    expect(next.status).toBe(200)
    expect(next.body.active).not.toBeNull()
    expect((await api(ctx, 'POST', '/api/undo', {
      token: a.token, body: { batchId: pauseEvent.batchId },
    })).status).toBe(200)
    const replayed = await timer(a.token)
    expect(replayed.body.active.sessionId).toBe(next.body.active.sessionId)
    expect(replayed.body.sessions).toHaveLength(1)
    expect(replayed.body.sessions[0].sessionId).toBe(before.body.active.sessionId)
  })

  it('并发从两个任务开始仅一个成功', async () => {
    const a = await account()
    const one = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const two = await createTaskViaApi(ctx, a.token, { pomodoroEnabled: true })
    const results = await Promise.all([
      start(a.token, one.taskId, one.indexDate),
      start(a.token, two.taskId, two.indexDate),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect((await timer(a.token)).body.active).not.toBeNull()
    expect(readAccountEvents(ctx.db, a.id).filter((event) => event.type === 'task/timer-started')).toHaveLength(1)
  })

  it('重复任务昨日启动后跨日仍可完成原轮次，并原子停表', async () => {
    const a = await account()
    const yesterday = addDays(todayKey(), -1)
    const settings = loadAccountSettings(ctx.db, a.id)
    const yesterdayAtNoon = new Date(dayStartInstant(yesterday, timeContextOf(settings)).getTime() + 4 * 60 * 60 * 1000)
    const taskId = uuidv7()
    ctx.db.transaction(() => createTask(ctx.db, a.id, yesterdayAtNoon, {
      taskId,
      title: '跨日重复复盘',
      notes: '',
      importance: 'normal',
      plannedDate: null,
      plannedWeek: null,
      dueDate: null,
      tags: [],
      projectId: null,
      recurrence: { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: yesterday },
      steps: [],
      pomodoroEnabled: true,
    }))()
    const running = ctx.db.transaction(() => startTimer(ctx.db, a.id, yesterdayAtNoon, taskId, yesterday))()
    expect(running.active).toMatchObject({ taskId, occurrenceKey: yesterday })
    expect((await timer(a.token)).body.active.sessionId).toBe(running.active?.sessionId)

    const completed = await api(ctx, 'POST', `/api/tasks/${taskId}/occurrences/${yesterday}/complete`, {
      token: a.token,
    })
    expect(completed.status).toBe(200)
    const after = await timer(a.token)
    expect(after.body.active).toBeNull()
    expect(after.body.sessions.some((session: any) =>
      session.taskId === taskId && session.occurrenceKey === yesterday)).toBe(true)
    const history = await api(ctx, 'GET', '/api/tasks?scope=completed', { token: a.token })
    expect(history.body.items.some((item: any) =>
      item.taskId === taskId && item.occurrenceKey === yesterday)).toBe(true)

    // 停表后旧键不再享有跨日例外，不能把任意历史轮次补完成。
    expect((await api(ctx, 'POST', `/api/tasks/${taskId}/occurrences/${yesterday}/uncomplete`, {
      token: a.token,
    })).status).toBe(200)
    expect((await api(ctx, 'POST', `/api/tasks/${taskId}/occurrences/${yesterday}/complete`, {
      token: a.token,
    })).status).toBe(404)
  })
})
