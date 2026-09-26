import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { appendEvents } from '../events/append.js'
import type { Event, EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'
import { getTrace } from './service.js'
import { parseTraceQuery } from '../routes/trace.js'

let dir: string
let db: Db
let seq = 0
const NOW = new Date('2026-09-24T12:00:00+08:00')

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-trace-'))
  db = openMigratedDatabase(path.join(dir, 'app.db'))
})

afterAll(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function nextId(): string {
  seq += 1
  return `${seq.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`
}

function freshAccount(): string {
  const accountId = `trace-${nextId()}`
  insertUser(db, {
    id: accountId,
    username: accountId,
    displayName: accountId,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-20T10:00:00+08:00',
  })
  emit(accountId, 'settings/updated', '2026-09-20', { timeZone: 'Asia/Shanghai', dayStartHour: 4 })
  return accountId
}

function emit(accountId: string, type: string, dayKey: string, payload: unknown, hour = '10:00', extras: Partial<EventDraft> = {}): Event {
  const event: EventDraft = {
    id: nextId(), batchId: nextId(), type, payload,
    occurredAt: `${dayKey}T${hour}:00+08:00`, dayKey, dayStartHour: 4, timezone: 'Asia/Shanghai',
    ...extras,
  }
  return db.transaction(() => appendEvents(db, accountId, [event]))()[0]!
}

function create(accountId: string, dayKey: string, overrides: Record<string, unknown> = {}): string {
  const taskId = nextId()
  emit(accountId, 'task/created', dayKey, {
    taskId, title: `任务 ${taskId.slice(0, 4)}`, notes: '', importance: 'normal',
    plannedDate: null, plannedWeek: null, dueDate: null, tags: [], projectId: null,
    recurrence: null, steps: [], ...overrides,
  })
  return taskId
}

function complete(accountId: string, taskId: string, occurrenceKey: string, dayKey: string, hour = '10:00'): Event {
  return emit(accountId, 'task/occurrence-completed', dayKey,
    { taskId, originalPlannedDate: occurrenceKey, completedDayKey: dayKey, next: null }, hour)
}

function trace(accountId: string) {
  return getTrace(db, accountId, NOW, { period: 'week', goalMinutes: 360 })
}

describe('Trace 事实口径', () => {
  it('同一实例当天重复完成只计一次；跨天再次完成留两天足迹，当前态只看最后一轮', () => {
    const account = freshAccount()
    const taskId = create(account, '2026-09-22')
    complete(account, taskId, '2026-09-22', '2026-09-22', '10:00')
    emit(account, 'task/occurrence-uncompleted', '2026-09-22', { taskId, originalPlannedDate: '2026-09-22' }, '11:00')
    complete(account, taskId, '2026-09-22', '2026-09-22', '12:00')
    emit(account, 'task/occurrence-uncompleted', '2026-09-23', { taskId, originalPlannedDate: '2026-09-22' }, '09:00')
    complete(account, taskId, '2026-09-22', '2026-09-23', '10:00')
    const result = trace(account)
    expect(result.days.find((day) => day.dayKey === '2026-09-22')?.completed).toBe(1)
    expect(result.days.find((day) => day.dayKey === '2026-09-23')?.completed).toBe(1)
    expect(result.score.completion).toMatchObject({ numerator: 1, denominator: 1 })
    expect(result.totals.completed).toBe(2)
    expect(result.heatmap).toHaveLength(371)
    expect(result.heatmap.filter((day) => day.future).length).toBeGreaterThan(0)
  })

  it('撤销完成批次、软删除和放弃不计入成就；账号之间无串台', () => {
    const account = freshAccount()
    const other = freshAccount()
    const kept = create(account, '2026-09-22')
    const revoked = complete(account, kept, '2026-09-22', '2026-09-22')
    emit(account, 'system/revoke', '2026-09-23', { targetBatchId: revoked.batchId })
    const deleted = create(account, '2026-09-22')
    complete(account, deleted, '2026-09-22', '2026-09-22')
    emit(account, 'task/deleted', '2026-09-23', { taskId: deleted })
    const abandoned = create(account, '2026-09-22')
    complete(account, abandoned, '2026-09-22', '2026-09-22')
    emit(account, 'task/status-changed', '2026-09-23', { taskId: abandoned, to: 'abandoned' })
    const otherTask = create(other, '2026-09-22')
    complete(other, otherTask, '2026-09-22', '2026-09-22')
    expect(trace(account).totals.completed).toBe(0)
    // 新增趋势是历史 task/created 动作；删除/放弃不会改写曾经新建过的事实。
    expect(trace(account).totals.created).toBe(3)
    // C 的分母则只看当前仍可执行的区间新建任务。
    expect(trace(account).score.completion.denominator).toBe(1)
    expect(trace(other).totals.completed).toBe(1)
  })

  it('日界固化、时长边界和样本门槛：不重算事件 day_key，18 小时待核对', () => {
    const account = freshAccount()
    const taskId = create(account, '2026-09-22', { dueDate: '2026-09-22' })
    const completed = emit(account, 'task/occurrence-completed', '2026-09-22',
      { taskId, originalPlannedDate: '2026-09-22', completedDayKey: '2026-09-22', next: null },
      '02:00')
    expect(completed.dayKey).toBe('2026-09-22')
    emit(account, 'checkin/arrived', '2026-09-22', {}, '08:00')
    emit(account, 'checkin/left', '2026-09-22', {}, '14:00')
    emit(account, 'checkin/arrived', '2026-09-23', {}, '05:00')
    emit(account, 'checkin/left', '2026-09-23', {}, '23:00')
    const result = trace(account)
    expect(result.days.find((day) => day.dayKey === '2026-09-22')).toMatchObject({ completed: 1, durationMinutes: 360 })
    expect(result.days.find((day) => day.dayKey === '2026-09-23')).toMatchObject({ durationMinutes: null, durationNeedsReview: true })
    expect(result.totals.validDurationDays).toBe(1)
    expect(result.totals.durationNeedsReviewDays).toBe(1)
    expect(result.score.timeliness).toMatchObject({ numerator: 1, denominator: 1 })
    expect(result.score.grade).toBeNull()
    expect(result.score.missingCheckinDays).toBe(1)
    expect(result.score.missingCreatedTasks).toBe(4)
  })

  it('样本达到门槛且四维有分母时才给总分与等级', () => {
    const account = freshAccount()
    for (const dayKey of ['2026-09-21', '2026-09-22', '2026-09-23']) {
      emit(account, 'checkin/arrived', dayKey, {}, '08:00')
      emit(account, 'checkin/left', dayKey, {}, '14:00')
    }
    for (let i = 0; i < 5; i += 1) {
      const taskId = create(account, '2026-09-22', { dueDate: '2026-09-23' })
      complete(account, taskId, '2026-09-22', '2026-09-22')
    }
    const result = trace(account)
    expect(result.score.persistence).toMatchObject({ numerator: 3, denominator: 4, percent: 75 })
    expect(result.score.completion).toMatchObject({ numerator: 5, denominator: 5, percent: 100 })
    expect(result.score.timeliness).toMatchObject({ numerator: 5, denominator: 5, percent: 100 })
    expect(result.score.effort).toMatchObject({ numerator: 1080, denominator: 1080, percent: 100 })
    expect(result.score.total).toBe(93)
    expect(result.score.grade).toBe('S')
  })
})

describe('Trace 查询契约', () => {
  it('默认月/6 小时，严格拒绝未知字段和无效项目组合', () => {
    expect(parseTraceQuery({})).toMatchObject({ period: 'month', goalMinutes: 360 })
    expect(parseTraceQuery({ period: 'project', projectId: 'p', goalMinutes: '60' })).toMatchObject({ period: 'project', projectId: 'p', goalMinutes: 60 })
    expect(() => parseTraceQuery({ period: 'week', projectId: 'p' })).toThrow()
    expect(() => parseTraceQuery({ period: 'project' })).toThrow()
    expect(() => parseTraceQuery({ period: 'week', extra: 'x' })).toThrow()
    expect(() => parseTraceQuery({ goalMinutes: '721' })).toThrow()
  })
})

describe('专注时间', () => {
  it('累计未完成任务的多个片段，暂停与暂离不计入；独立于在场时长', () => {
    const account = freshAccount()
    const taskId = create(account, '2026-09-22')
    emit(account, 'checkin/arrived', '2026-09-22', {}, '08:00')
    const first = emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '09:00')
    emit(account, 'task/timer-stopped', '2026-09-22', { taskId, sessionId: first.id }, '09:25')
    emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '09:40')
    // 旧版本缺少停止事件，也应在暂离处截止。
    emit(account, 'checkin/away', '2026-09-22', {}, '10:00')
    emit(account, 'checkin/returned', '2026-09-22', {}, '11:00')
    emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '11:30')
    emit(account, 'checkin/left', '2026-09-22', {}, '12:00')
    const result = trace(account)
    expect(result.totals.totalFocusSeconds).toBe(75 * 60)
    expect(result.days.find(day => day.dayKey === '2026-09-22')).toMatchObject({ focusSeconds: 4500, durationMinutes: 180 })
    expect(result.focusRunning).toBe(false)
    expect(trace(freshAccount()).totals.totalFocusSeconds).toBe(0)
  })

  it('跨日按开始时的时区日界拆分，设置变化不改写历史；运行片段计到查询时刻', () => {
    const account = freshAccount()
    const taskId = create(account, '2026-09-22')
    emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '03:50', { occurredAt: '2026-09-23T03:50:00+08:00' })
    const now = new Date('2026-09-23T04:20:00+08:00')
    let result = getTrace(db, account, now, { period: 'week', goalMinutes: 360 })
    expect(result.days.find(day => day.dayKey === '2026-09-22')?.focusSeconds).toBe(600)
    expect(result.days.find(day => day.dayKey === '2026-09-23')?.focusSeconds).toBe(1200)
    expect(result.totals.totalFocusSeconds).toBe(1800)
    expect(result.focusRunning).toBe(true)
    emit(account, 'settings/updated', '2026-09-23', { timeZone: 'UTC', dayStartHour: 0 }, '04:10')
    result = getTrace(db, account, new Date('2026-09-23T10:00:00+08:00'), { period: 'week', goalMinutes: 360 })
    expect(result.days.find(day => day.dayKey === '2026-09-22')?.focusSeconds).toBe(600)
  })

  it('重放重叠开始事件不会重复计时，任务删除仍保留真实用时', () => {
    const account = freshAccount()
    const taskId = create(account, '2026-09-22')
    const second = create(account, '2026-09-22')
    emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '09:00')
    const active = emit(account, 'task/timer-started', '2026-09-22', { taskId: second, occurrenceKey: '2026-09-22' }, '09:10')
    emit(account, 'task/timer-stopped', '2026-09-22', { taskId: second, sessionId: active.id }, '09:20')
    emit(account, 'task/deleted', '2026-09-22', { taskId }, '10:00')
    expect(trace(account).totals.totalFocusSeconds).toBe(1200)
  })
})

describe('专注项目分布', () => {
  it('按开始时的项目分组；移动、删除项目不丢失历史，未归属时间纳入总和', () => {
    const account = freshAccount()
    const projectId = nextId()
    emit(account, 'project/created', '2026-09-22', { projectId, name: '论文阅读', startsOn: '2026-09-01', endsOn: '2026-10-01' })
    const taskId = create(account, '2026-09-22', { projectId })
    const first = emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '11:00')
    emit(account, 'task/timer-stopped', '2026-09-22', { taskId, sessionId: first.id }, '11:30')
    emit(account, 'task/updated', '2026-09-22', { taskId, title: '阅读', notes: '', importance: 'normal', tags: [], projectId: null, recurrence: null }, '12:00')
    const second = emit(account, 'task/timer-started', '2026-09-23', { taskId, occurrenceKey: '2026-09-22' }, '09:00')
    emit(account, 'task/timer-stopped', '2026-09-23', { taskId, sessionId: second.id }, '09:10')
    emit(account, 'project/deleted', '2026-09-23', { projectId }, '11:00')
    const result = trace(account)
    expect(result.focusProjects).toEqual([
      { projectId, name: '论文阅读（已删除）', seconds: 1800 },
      { projectId: null, name: '未归属项目', seconds: 600 },
    ])
    expect(result.focusProjects.reduce((sum, row) => sum + row.seconds, 0)).toBe(result.totals.totalFocusSeconds)
    expect(trace(freshAccount()).focusProjects).toEqual([])
  })

  it('跨日分摊和小数秒累计与总数一致，区间只计入选中日期', () => {
    const account = freshAccount()
    const projectId = nextId()
    emit(account, 'project/created', '2026-09-22', { projectId, name: '实验', startsOn: '2026-09-01', endsOn: '2026-10-01' })
    const ids = [create(account, '2026-09-22', { projectId }), create(account, '2026-09-22')]
    ids.forEach((taskId, i) => {
      const start = emit(account, 'task/timer-started', '2026-09-22', { taskId, occurrenceKey: '2026-09-22' }, '09:00', { occurredAt: `2026-09-22T09:00:0${i}.000+08:00` })
      emit(account, 'task/timer-stopped', '2026-09-22', { taskId, sessionId: start.id }, '09:00', { occurredAt: `2026-09-22T09:00:0${i}.900+08:00` })
    })
    const result = trace(account)
    expect(result.totals.totalFocusSeconds).toBe(1)
    expect(result.focusProjects.reduce((sum, row) => sum + row.seconds, 0)).toBe(1)
    const empty = getTrace(db, account, new Date('2026-10-01T12:00:00+08:00'), { period: 'month', goalMinutes: 360 })
    expect(empty.focusProjects).toEqual([])
  })
})
