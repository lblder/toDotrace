import { afterEach, beforeEach, expect, it } from 'vitest'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { insertUser } from '../repo/users.js'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { closeExpiredAttendance, attendanceAnomalies, correctDeparture } from '../checkin/boundary.js'
import { foldTimerEvents } from '../timer/service.js'
let db: Db
const at = (s: string) => new Date(s)
const arriveAt = '2026-09-27T10:00:00+08:00'
const boundary = '2026-09-28T04:00:00+08:00'
const nextDay = at('2026-09-28T10:00:00+08:00')
beforeEach(() => {
  db = openMigratedDatabase(':memory:')
  for (const id of ['a', 'b']) {
    insertUser(db, { id, username: id, displayName: id, role: 'member', passwordHash: 'unused', createdAt: arriveAt })
    db.transaction(() => appendEvents(db, id, [
      { type: 'settings/updated', occurredAt: arriveAt, payload: { timeZone: 'Asia/Shanghai', dayStartHour: 4 } },
      { type: 'checkin/arrived', occurredAt: arriveAt, payload: {} },
    ]))()
  }
})
afterEach(() => db.close())
it('closes exactly at the saved boundary, is idempotent and account isolated', () => {
  db.transaction(() => closeExpiredAttendance(db, 'a', at('2026-09-28T03:59:59+08:00')))()
  expect(readProjection(db, 'a').days[0]?.leftAt).toBeNull()
  db.transaction(() => closeExpiredAttendance(db, 'a', at(boundary)))()
  db.transaction(() => closeExpiredAttendance(db, 'a', nextDay))()
  expect(readProjection(db, 'a').days[0]?.leftAt).toBe(boundary)
  expect(readProjection(db, 'b').days[0]?.leftAt).toBeNull()
  expect(readAccountEvents(db, 'a').filter(e => e.type === 'checkin/auto-left')).toHaveLength(1)
  expect(attendanceAnomalies(db, 'a', nextDay)).toHaveLength(1)
})
it('corrects departure, clips breaks, preserves arrival and replays identically', () => {
  db.transaction(() => {
    appendEvents(db, 'a', [{ type: 'checkin/away', occurredAt: '2026-09-27T17:00:00+08:00', payload: {} }])
    closeExpiredAttendance(db, 'a', nextDay)
    correctDeparture(db, 'a', nextDay, '2026-09-27', '2026-09-27T18:00:00+08:00')
  })()
  const projection = readProjection(db, 'a')
  expect(projection.days[0]?.arrivedAt).toBe(arriveAt)
  expect(projection.days[0]?.leftAt).toBe('2026-09-27T18:00:00+08:00')
  expect(projection.days[0]?.breaks?.[0]?.endedAt).toBe('2026-09-27T18:00:00+08:00')
  expect(attendanceAnomalies(db, 'a', nextDay)).toEqual([])
  expect(project(readAccountEvents(db, 'a')).days).toEqual(projection.days)
})
it('rejects invalid times and limits reminders to the previous three days', () => {
  db.transaction(() => closeExpiredAttendance(db, 'a', nextDay))()
  for (const left of ['2026-09-27T09:00:00+08:00', '2026-09-28T05:00:00+08:00']) {
    expect(() => db.transaction(() => correctDeparture(db, 'a', nextDay, '2026-09-27', left))()).toThrow()
  }
  expect(attendanceAnomalies(db, 'a', at('2026-09-30T10:00:00+08:00'))).toHaveLength(1)
  expect(attendanceAnomalies(db, 'a', at('2026-10-01T10:00:00+08:00'))).toEqual([])
})
it('uses arrival clock even when settings changed and catches up after downtime', () => {
  db.transaction(() => {
    appendEvents(db, 'a', [{ type: 'settings/updated', occurredAt: '2026-09-27T11:00:00+08:00', payload: { timeZone: 'UTC', dayStartHour: 8 } }])
    closeExpiredAttendance(db, 'a', at('2026-09-30T12:00:00+08:00'))
  })()
  expect(readProjection(db, 'a').days[0]?.leftAt).toBe(boundary)
})
it('recognizes legacy late departures for correction', () => {
  db.transaction(() => appendEvents(db, 'a', [{ type: 'checkin/left', dayKey: '2026-09-27', dayStartHour: 4, occurredAt: '2026-09-28T09:00:00+08:00', payload: {} }]))()
  expect(attendanceAnomalies(db, 'a', nextDay)).toHaveLength(1)
})
it('auto-stop and correction trim the old focus session without stopping a new day session', () => {
  const arrival = readAccountEvents(db, 'a').find(e => e.type === 'checkin/arrived')!
  const event = (id: string, type: string, occurredAt: string, payload: unknown = {}, dayKey = '2026-09-27') => ({ ...arrival, id, type, occurredAt, payload, dayKey })
  const events = [arrival,
    event('old', 'task/timer-started', '2026-09-27T15:00:00+08:00', { taskId: 'task', occurrenceKey: null }),
    event('auto', 'checkin/auto-left', boundary),
    event('new', 'task/timer-started', '2026-09-28T10:00:00+08:00', { taskId: 'other', occurrenceKey: null }, '2026-09-28'),
    event('fix', 'checkin/departure-corrected', '2026-09-28T11:00:00+08:00', { leftAt: '2026-09-27T18:00:00+08:00' }),
  ]
  const timer = foldTimerEvents(events)
  expect(timer.sessions[0]?.elapsedSeconds).toBe(3 * 3600)
  expect(timer.active?.sessionId).toBe('new')
})
