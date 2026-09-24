import { describe, expect, it } from 'vitest'
import { buildTodoItem } from './today'
import { task, taskId } from './test-fixtures'
import { matchesPlanPeriod, upcomingTaskItem, isUpcomingPreview, matchesCompletionPeriod, planCreationDefaults } from './views'
const today = '2026-09-24'
function item(overrides: Parameters<typeof task>[0] = { id: taskId(1) }) {
  const row = task(overrides)
  return buildTodoItem({ tasks: [row], events: [], today }, row)
}

describe('智能视图的日期语义', () => {
  it('本周完成但未排期，不算本周计划；完成历史仍可按本周查', () => {
    const row = { ...item(), completedAt: '2026-09-24T10:00:00+08:00', completedDayKey: today }
    expect(matchesPlanPeriod(row, 'week', today)).toBe(false)
    expect(matchesCompletionPeriod(row, 'week', today)).toBe(true)
  })
  it('周级安排只属于本周，不在周日被伪装成当天计划', () => {
    const row = item({ id: taskId(1), plannedWeek: '2026-09-21' })
    expect(matchesPlanPeriod(row, 'week', today)).toBe(true)
    expect(matchesPlanPeriod(row, 'today', '2026-09-27')).toBe(false)
    expect(matchesPlanPeriod(row, 'overdue', '2026-09-28')).toBe(true)
  })
  it('旧逾期和今天安排分别可见，不将逾期混进今天时间筛选', () => {
    const row = item({ id: taskId(1), plannedDate: '2026-09-10' })
    expect(matchesPlanPeriod(row, 'overdue', today)).toBe(true)
    expect(matchesPlanPeriod(row, 'today', today)).toBe(false)
    expect(matchesPlanPeriod(row, 'week', today)).toBe(false)
  })
  it('计划日与截止日各有意义，同一任务可同时属于本周和以后', () => {
    const row = item({ id: taskId(1), plannedDate: today, dueDate: '2026-10-01' })
    expect(matchesPlanPeriod(row, 'week', today)).toBe(true)
    expect(matchesPlanPeriod(row, 'later', today)).toBe(true)
  })
  it('未来重复日期来自规则，不来自创建日；预览不保留上一轮完成和勾选', () => {
    const row = { ...item(), recurring: true, pending: false, scheduledOccurrenceDate: '2026-10-01',
      completedAt: '2026-09-23T10:00:00+08:00', completedDayKey: '2026-09-23', steps: [{ id: 's', title: '步骤', checkedAt: '2026-09-23T10:00:00+08:00' }] }
    const preview = upcomingTaskItem(row, today)
    expect(preview.occurrenceKey).toBe('2026-10-01')
    expect(preview.completedAt).toBeNull()
    expect(preview.steps[0]?.checkedAt).toBeNull()
    expect(isUpcomingPreview(preview, today)).toBe(true)
    expect(matchesPlanPeriod(preview, 'later', today)).toBe(true)
    expect(matchesPlanPeriod(preview, 'unscheduled', today)).toBe(false)
    expect(row.completedDayKey).toBe('2026-09-23')
  })
  it('按时间筛选新增只写计划默认值，未来设下周而非伪造截止日', () => {
    expect(planCreationDefaults('week', today)).toEqual({ plannedWeek: '2026-09-21' })
    expect(planCreationDefaults('later', today)).toEqual({ plannedWeek: '2026-09-28' })
    expect(planCreationDefaults('unscheduled', today)).toEqual({})
  })
})
