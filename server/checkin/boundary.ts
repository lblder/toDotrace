import { addDays, dayEndInstant, toDayKey, toIsoInZone } from '@shared/time'
import type { Db } from '../db/connection.js'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { foldedEvents } from '../events/project.js'
import { readProjection } from '../events/projection-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import { invalidInput } from '../lib/errors.js'

function arrivalEvents(db: Db, accountId: string) {
  return foldedEvents(readAccountEvents(db, accountId))
}

/** Use the arrival's saved clock settings, including across later settings changes. */
export function attendanceAnomalies(db: Db, accountId: string, now: Date) {
  const events = arrivalEvents(db, accountId)
  const today = toDayKey(now, timeContextOf(loadAccountSettings(db, accountId)))
  return readProjection(db, accountId).days.flatMap(day => {
    if (day.dayKey < addDays(today, -3) || day.dayKey >= today) return []
    const history = events.filter(e => e.dayKey === day.dayKey)
    const arrival = history.findLast(e => e.type === 'checkin/arrived')
    if (!arrival) return []
    const end = dayEndInstant(day.dayKey, { timeZone: arrival.timezone, dayStartHour: arrival.dayStartHour })
    const last = history.findLast(e => ['checkin/auto-left', 'checkin/departure-corrected', 'checkin/left'].includes(e.type))
    if (last?.type === 'checkin/departure-corrected') return []
    if (last?.type !== 'checkin/auto-left' && (day.leftAt === null || Date.parse(day.leftAt) <= end.getTime())) return []
    return [{ dayKey: day.dayKey, arrivedAt: day.arrivedAt, leftAt: day.leftAt,
      boundaryAt: toIsoInZone(end, arrival.timezone), timeZone: arrival.timezone }]
  }).reverse()
}

/** Called by the server clock and before authenticated requests; restart-safe and idempotent. */
export function closeExpiredAttendance(db: Db, accountId: string, now: Date): void {
  assertInTransaction(db, '日界自动离开')
  const open = readProjection(db, accountId).days.filter(day => day.leftAt === null)
  if (!open.length) return
  const events = arrivalEvents(db, accountId)
  for (const day of open) {
    const arrival = events.findLast(e => e.type === 'checkin/arrived' && e.dayKey === day.dayKey)
    if (!arrival) continue
    const boundary = dayEndInstant(day.dayKey, { timeZone: arrival.timezone, dayStartHour: arrival.dayStartHour })
    if (boundary.getTime() > now.getTime()) continue
    appendEvents(db, accountId, [{ type: 'checkin/auto-left', payload: {},
      occurredAt: toIsoInZone(boundary, arrival.timezone), timezone: arrival.timezone,
      dayKey: day.dayKey, dayStartHour: arrival.dayStartHour }])
  }
}

export function correctDeparture(db: Db, accountId: string, now: Date, dayKey: string, leftAt: string): void {
  assertInTransaction(db, '修正离开时间')
  const anomaly = attendanceAnomalies(db, accountId, now).find(day => day.dayKey === dayKey)
  if (!anomaly) throw invalidInput('该记录不在最近三天的待确认记录中，请刷新后重试。')
  const value = Date.parse(leftAt)
  if (!Number.isFinite(value) || value < Date.parse(anomaly.arrivedAt) || value > Date.parse(anomaly.boundaryAt) || value > now.getTime()) {
    throw invalidInput('离开时间必须介于到达时间与当日日界之间。')
  }
  appendEvents(db, accountId, [{ type: 'checkin/departure-corrected', occurredAt: toIsoInZone(now, anomaly.timeZone),
    dayKey, dayStartHour: loadAccountSettings(db, accountId).dayStartHour,
    payload: { leftAt: toIsoInZone(new Date(value), anomaly.timeZone) } }])
}
