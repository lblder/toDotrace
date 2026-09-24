import { addDays, compareDayKey, weekEnd, weekStart, type DayKey } from '../time'
import type { TodoItem } from './types'
import { bucketReasonOf, isOverdue, selectionReasons, urgencyBucket } from './today'

export type PlanPeriod = 'scheduled' | 'overdue' | 'today' | 'week' | 'later' | 'unscheduled'
export type CompletionPeriod = 'all' | 'today' | 'week'

export function itemKey(item: Pick<TodoItem, 'taskId' | 'occurrenceKey'>): string {
  return `${item.taskId}:${item.occurrenceKey}`
}

/** 日期视图只读取安排和期限；完成日期属于回顾。周级安排不冒充某一天。 */
export function matchesPlanPeriod(
  item: Pick<TodoItem, 'plannedDate' | 'plannedWeek' | 'dueDate' | 'recurring' | 'scheduledOccurrenceDate'>,
  period: PlanPeriod,
  today: DayKey,
): boolean {
  const dates = [item.plannedDate, item.dueDate, item.recurring ? item.scheduledOccurrenceDate : null]
    .filter((date): date is DayKey => date != null)
  const hasSchedule = dates.length > 0 || item.plannedWeek !== null
  switch (period) {
    case 'scheduled': return hasSchedule
    case 'unscheduled': return !hasSchedule && !item.recurring
    case 'overdue': return dates.some((date) => date < today)
      || (item.plannedWeek !== null && weekEnd(item.plannedWeek) < today)
    case 'today': return dates.includes(today)
    case 'week': return dates.some((date) => date >= weekStart(today) && date <= weekEnd(today))
      || (item.plannedWeek !== null && weekStart(item.plannedWeek) === weekStart(today))
    case 'later': return dates.some((date) => date > weekEnd(today))
      || (item.plannedWeek !== null && weekStart(item.plannedWeek) > weekEnd(today))
  }
}

/** 未来轮次是只读预览；pending=false 明确阻止完成、步骤和加入我的一天等实例写入。 */
export function upcomingTaskItem(item: TodoItem, today: DayKey): TodoItem {
  if (!item.recurring || item.pending || item.status === 'abandoned'
    || item.scheduledOccurrenceDate == null || item.scheduledOccurrenceDate <= today) return item
  const preview: TodoItem = {
    ...item,
    occurrenceKey: item.scheduledOccurrenceDate,
    completedAt: null,
    completedDayKey: null,
    steps: item.steps.map((step) => ({ ...step, checkedAt: null })),
  }
  return { ...preview, overdue: isOverdue(preview, today),
    reasons: [...selectionReasons(preview, today), bucketReasonOf(urgencyBucket(preview, today))] }
}

export function isUpcomingPreview(item: TodoItem, today: DayKey): boolean {
  return item.recurring && !item.pending && item.completedAt === null
    && item.scheduledOccurrenceDate != null && item.scheduledOccurrenceDate > today
}

export function matchesCompletionPeriod(item: TodoItem, period: CompletionPeriod, today: DayKey): boolean {
  if (item.completedDayKey === null) return false
  return period === 'all' || (period === 'today' ? item.completedDayKey === today
    : item.completedDayKey >= weekStart(today) && item.completedDayKey <= weekEnd(today))
}

/** 新增默认值只安排“何时做”，不推断截止日。未安排视图不填任何日期。 */
export function planCreationDefaults(period: PlanPeriod, today: DayKey): { plannedDate?: DayKey; plannedWeek?: DayKey } {
  if (period === 'unscheduled') return {}
  if (period === 'week') return { plannedWeek: weekStart(today) }
  if (period === 'later') return { plannedWeek: addDays(weekEnd(today), 1) }
  return { plannedDate: today }
}
