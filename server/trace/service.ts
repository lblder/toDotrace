import { addDays, diffDays, parseDayKey, today as accountToday, weekEnd, weekStart, type DayKey } from '@shared/time'
import { effectiveCompletions, resolveInstance } from '@shared/tasks/rounds'
import type { OccurrenceCompletedPayload, ProjectedTask } from '@shared/tasks/types'
import type { TraceDay, TracePayload, TracePeriod, TraceRatio, TraceScore, TraceTaskRecord } from '@shared/trace/types'
import type { Db } from '../db/connection.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { notFound } from '../lib/errors.js'
import { loadTaskSources, occurrenceEventsOf } from '../tasks/sources.js'

/** Trace 只读既有事件与投影；归属日从事件 day_key 读取，绝不按当前时区重算。 */
export interface TraceQuery {
  period: TracePeriod
  projectId?: string
  goalMinutes: number
}

interface Range { from: DayKey; to: DayKey }
type Sources = ReturnType<typeof loadTaskSources>

function dayList(from: DayKey, to: DayKey): DayKey[] {
  if (from > to) return []
  const count = diffDays(from, to) + 1
  return Array.from({ length: count }, (_, i) => addDays(from, i))
}

function rangeOf(query: TraceQuery, today: DayKey, sources: Sources): Range {
  const { period } = query
  if (period === 'week') return { from: weekStart(today), to: today }
  if (period === 'month') return { from: `${today.slice(0, 7)}-01` as DayKey, to: today }
  if (period === '90d') return { from: addDays(today, -89), to: today }
  if (period === 'all') {
    const first = sources.events.reduce<DayKey | null>((min, event) =>
      min === null || event.dayKey < min ? event.dayKey : min, null)
    return { from: first !== null && first < today ? first : today, to: today }
  }
  const project = sources.projection.projects.find((row) => row.id === query.projectId && row.deletedAt === null)
  if (project === undefined) throw notFound('项目不存在或不可用')
  return { from: project.startsOn, to: project.endsOn }
}

function ratio(numerator: number, denominator: number): TraceRatio {
  return { numerator, denominator, percent: denominator === 0 ? null : Math.min(100, Math.round(numerator / denominator * 100)) }
}

function durationOf(arrivedAt: string, leftAt: string | null): { minutes: number | null; needsReview: boolean } {
  if (leftAt === null) return { minutes: null, needsReview: false }
  const elapsed = (Date.parse(leftAt) - Date.parse(arrivedAt)) / 60_000
  if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed >= 18 * 60) {
    return { minutes: null, needsReview: true }
  }
  return { minutes: Math.round(elapsed), needsReview: false }
}

function localHour(iso: string): number | null {
  // ISO 偏移在写入时已固化；取字面墙钟小时，不转成本机时区。
  const match = /T(\d{2}):\d{2}/.exec(iso)
  return match === null ? null : Number(match[1])
}

function weekdayIndex(dayKey: DayKey): number {
  const { year, month, day } = parseDayKey(dayKey)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return (weekday + 6) % 7 // 周一到周日
}

/** 非重复任务的期限取完成动作发生时那一版，后续顺延不改写旧评价。 */
function deadlinesAtCompletion(events: Sources['events']): Map<string, DayKey | null> {
  const currentDue = new Map<string, DayKey | null>()
  const deadlines = new Map<string, DayKey | null>()
  for (const event of events) {
    if (event.type === 'task/created') {
      const payload = event.payload as { taskId: string; dueDate: DayKey | null }
      currentDue.set(payload.taskId, payload.dueDate)
    } else if (event.type === 'task/rescheduled') {
      const payload = event.payload as { taskId: string; toDueDate: DayKey | null }
      currentDue.set(payload.taskId, payload.toDueDate)
    } else if (event.type === 'task/occurrence-completed') {
      const payload = event.payload as OccurrenceCompletedPayload
      deadlines.set(event.id, currentDue.get(payload.taskId) ?? null)
    }
  }
  return deadlines
}

function fillDays(keys: readonly DayKey[], today: DayKey, sources: Sources, completedByDay: Map<DayKey, TraceTaskRecord[]>, createdByDay: Map<DayKey, number>): TraceDay[] {
  const arrivalByDay = new Map(sources.projection.days.map((row) => [row.dayKey, row]))
  return keys.map((dayKey) => {
    const arrival = arrivalByDay.get(dayKey)
    const duration = arrival === undefined ? { minutes: null, needsReview: false } : durationOf(arrival.arrivedAt, arrival.leftAt)
    const future = dayKey > today
    const completions = future ? [] : completedByDay.get(dayKey) ?? []
    return {
      dayKey,
      future,
      created: future ? 0 : createdByDay.get(dayKey) ?? 0,
      completed: completions.length,
      completions,
      arrival: future ? null : arrival?.arrivedAt ?? null,
      left: future ? null : arrival?.leftAt ?? null,
      durationMinutes: future ? null : duration.minutes,
      durationNeedsReview: future ? false : duration.needsReview,
    }
  })
}

function scoreOf(input: {
  days: readonly TraceDay[]
  range: Range
  today: DayKey
  sources: Sources
  createdTasks: readonly ProjectedTask[]
  goalMinutes: number
}): TraceScore {
  const { days, range, today, sources, createdTasks, goalMinutes } = input
  const liveTasks = sources.projection.tasks.filter((task) => task.deletedAt === null && task.status !== 'abandoned')
  const occurrenceEvents = occurrenceEventsOf(sources.events)
  const effectiveByTask = new Map(liveTasks.map((task) => [task.id, effectiveCompletions(task, occurrenceEvents)]))
  const currentlyDone = createdTasks.filter((task) => resolveInstance(task, occurrenceEvents, today).completion !== null)
  const completion = ratio(currentlyDone.length, createdTasks.length)
  const deadlines = deadlinesAtCompletion(sources.events)

  let onTime = 0
  let timed = 0
  for (const task of liveTasks) {
    for (const completionEvent of effectiveByTask.get(task.id) ?? []) {
      const completedDay = completionEvent.payload.completedDayKey
      if (completedDay < range.from || completedDay > range.to || completedDay > today) continue
      const deadline = task.recurrence === null ? deadlines.get(completionEvent.eventId) ?? null : completionEvent.payload.originalPlannedDate
      if (deadline === null) continue
      timed += 1
      if (completedDay <= deadline) onTime += 1
    }
  }

  const checkinDays = days.filter((day) => day.arrival !== null).length
  const validDays = days.filter((day) => day.durationMinutes !== null)
  const totalDuration = validDays.reduce((sum, day) => sum + (day.durationMinutes ?? 0), 0)
  const periodDays = range.from > today ? 0 : diffDays(range.from, range.to < today ? range.to : today) + 1
  const persistence = ratio(checkinDays, periodDays)
  const timeliness = ratio(onTime, timed)
  const effort = ratio(totalDuration, validDays.length * goalMinutes)

  const firstPassTasks = currentlyDone.filter((task) => !sources.events.some((event) =>
    event.type === 'task/rescheduled' && (event.payload as { taskId?: string }).taskId === task.id))
  const firstPass = ratio(firstPassTasks.length, currentlyDone.length)
  const missingCheckinDays = Math.max(0, 3 - checkinDays)
  const missingCreatedTasks = Math.max(0, 5 - createdTasks.length)
  const complete = missingCheckinDays === 0 && missingCreatedTasks === 0 && timeliness.percent !== null && effort.percent !== null
  const total = complete ? Math.round(0.3 * persistence.percent! + 0.3 * completion.percent! + 0.25 * timeliness.percent! + 0.15 * effort.percent!) : null
  const grade = total === null ? null : total >= 90 ? 'S' : total >= 80 ? 'A' : total >= 70 ? 'B' : total >= 60 ? 'C' : 'D'

  const dimensions = [
    { name: '坚持度', ratio: persistence, suggestion: '下周先选固定的到达时间，连续记录三天。' },
    { name: '完成率', ratio: completion, suggestion: '把下一周计划缩到真正能完成的几件事。' },
    { name: '按时率', ratio: timeliness, suggestion: '给有期限的任务预留一天缓冲。' },
    { name: '投入度', ratio: effort, suggestion: '给重要任务留一段不被打断的学习时间。' },
  ]
  const weakest = dimensions.filter((item) => item.ratio.percent !== null).sort((a, b) => a.ratio.percent! - b.ratio.percent!)[0]
  const missing = [
    missingCheckinDays > 0 ? `再记录 ${missingCheckinDays} 天到达` : '',
    missingCreatedTasks > 0 ? `再新建 ${missingCreatedTasks} 条计划` : '',
    timeliness.percent === null ? '完成一条有期限的任务' : '',
    effort.percent === null ? '记录一次有效离开' : '',
  ].filter(Boolean)
  return {
    persistence, completion, timeliness, effort, firstPass, total, grade,
    missingCheckinDays, missingCreatedTasks,
    explanation: total === null ? `样本还不足：${missing.join('、')}。` : `本期${weakest?.name ?? '计划执行'}是最值得调整的一项。`,
    suggestion: total === null ? '先继续记录真实的任务和到达，积累可比较的样本。' : weakest?.suggestion ?? '保持现在的节奏。',
  }
}

function trendOf(days: readonly TraceDay[], period: TracePeriod): { trend: TracePayload['trend']; trendUnit: TracePayload['trendUnit'] } {
  const trendUnit = period === 'all' || days.length > 366 ? 'month' : days.length > 90 ? 'week' : 'day'
  const grouped = new Map<DayKey, { created: number; completed: number }>()
  for (const day of days) {
    const key = trendUnit === 'month' ? `${day.dayKey.slice(0, 7)}-01` as DayKey : trendUnit === 'week' ? weekStart(day.dayKey) : day.dayKey
    const current = grouped.get(key) ?? { created: 0, completed: 0 }
    current.created += day.created
    current.completed += day.completed
    grouped.set(key, current)
  }
  return { trendUnit, trend: [...grouped].map(([key, value]) => ({ key, label: trendUnit === 'month' ? key.slice(0, 7) : key.slice(5), ...value })) }
}

export function getTrace(db: Db, accountId: string, now: Date, query: TraceQuery): TracePayload {
  const settings = loadAccountSettings(db, accountId)
  const today = accountToday(timeContextOf(settings), now)
  const sources = loadTaskSources(db, accountId)
  const range = rangeOf(query, today, sources)
  const liveTasks = sources.projection.tasks.filter((task) => task.deletedAt === null && task.status !== 'abandoned')
  const taskById = new Map(liveTasks.map((task) => [task.id, task]))

  const createdByDay = new Map<DayKey, number>()
  const createdIds = new Set<string>()
  for (const event of sources.events) {
    if (event.type !== 'task/created' || event.dayKey > today) continue
    const taskId = (event.payload as { taskId: string }).taskId
    createdByDay.set(event.dayKey, (createdByDay.get(event.dayKey) ?? 0) + 1)
    if (event.dayKey >= range.from && event.dayKey <= range.to && taskById.has(taskId)) createdIds.add(taskId)
  }
  const createdTasks = [...createdIds].map((id) => taskById.get(id)!).filter(Boolean)

  // 足迹取完成动作本身；同一实例同一天只计一次，跨天重新完成可再留一格。
  // sources.events 已被 foldedEvents 过滤撤销批次与覆盖边界。
  const completedByDay = new Map<DayKey, TraceTaskRecord[]>()
  const seen = new Set<string>()
  for (const event of sources.events) {
    if (event.type !== 'task/occurrence-completed' || event.dayKey > today) continue
    const payload = event.payload as OccurrenceCompletedPayload
    const task = taskById.get(payload.taskId)
    if (task === undefined) continue
    const key = `${event.dayKey}\x00${payload.taskId}\x00${payload.originalPlannedDate}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = completedByDay.get(event.dayKey) ?? []
    list.push({ taskId: task.id, occurrenceKey: payload.originalPlannedDate, title: task.title, completedAt: event.occurredAt })
    completedByDay.set(event.dayKey, list)
  }

  const heatmapEnd = weekEnd(today)
  const heatmapStart = addDays(heatmapEnd, -370)
  const heatmap = fillDays(dayList(heatmapStart, heatmapEnd), today, sources, completedByDay, createdByDay)
  const rangeEnd = range.to < today ? range.to : today
  const days = fillDays(dayList(range.from, rangeEnd), today, sources, completedByDay, createdByDay)
  const trend = trendOf(days, query.period)
  const score = scoreOf({ days, range, today, sources, createdTasks, goalMinutes: query.goalMinutes })
  const durationDays = days.filter((day) => day.durationMinutes !== null)
  const weekdays = Array.from({ length: 7 }, (_, index) => days.filter((day) => weekdayIndex(day.dayKey) === index).reduce((sum, day) => sum + day.completed, 0))
  const arrivals = Array.from({ length: 24 }, () => 0)
  for (const day of days) {
    if (day.arrival === null) continue
    const hour = localHour(day.arrival)
    if (hour !== null && hour >= 0 && hour < 24) arrivals[hour] = (arrivals[hour] ?? 0) + 1
  }
  const planTypes = { day: 0, week: 0, recurring: 0, undated: 0 }
  for (const task of createdTasks) {
    if (task.recurrence !== null) planTypes.recurring += 1
    else if (task.plannedDate !== null) planTypes.day += 1
    else if (task.plannedWeek !== null) planTypes.week += 1
    else planTypes.undated += 1
  }
  const selected = query.period === 'project' ? sources.projection.projects.find((row) => row.id === query.projectId)! : null
  const owned = selected === null ? [] : liveTasks.filter((task) => task.projectId === selected.id)
  const occurrenceEvents = occurrenceEventsOf(sources.events)
  return {
    today, period: query.period, range, goalMinutes: query.goalMinutes, heatmap, days,
    trend: trend.trend, trendUnit: trend.trendUnit, score,
    totals: {
      created: days.reduce((sum, day) => sum + day.created, 0),
      completed: days.reduce((sum, day) => sum + day.completed, 0),
      checkinDays: days.filter((day) => day.arrival !== null).length,
      validDurationDays: durationDays.length,
      durationNeedsReviewDays: days.filter((day) => day.durationNeedsReview).length,
      totalDurationMinutes: durationDays.reduce((sum, day) => sum + (day.durationMinutes ?? 0), 0),
    },
    weekdays, arrivals, planTypes,
    project: selected === null ? null : {
      projectId: selected.id, name: selected.name, ownedTotal: owned.length,
      ownedCompleted: owned.filter((task) => resolveInstance(task, occurrenceEvents, today).completion !== null).length,
    },
  }
}
