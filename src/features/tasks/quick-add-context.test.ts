import { describe, expect, it } from 'vitest'
import { parseQuickAdd, resolveQuickAdd, type QuickAddContext } from '@shared/quickadd'
import type { DayKey, TimeContext } from '@shared/time'
import {
  contextDeparture,
  contextHint,
  createInputForContext,
  whereItLanded,
} from './quick-add-context'

const TODAY: DayKey = '2026-09-23' // 周三
const timeContext: TimeContext = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }

function resolve(text: string) {
  const context: QuickAddContext = {
    now: new Date('2026-09-23T12:00:00+08:00'),
    timeContext,
    projects: [{ id: 'project-b', name: '项目B' }],
  }
  return resolveQuickAdd(parseQuickAdd(text, context))
}

describe('快速录入清单上下文', () => {
  it('重要清单只给没有显式重要性的任务补 high', () => {
    expect(createInputForContext(resolve('写报告'), { kind: 'important' }, 'a').importance).toBe('high')
    expect(createInputForContext(resolve('写报告 !低'), { kind: 'important' }, 'b').importance).toBe('low')
    expect(contextDeparture({ kind: 'important' }, resolve('写报告 !低'))).toContain('全部任务')
  })

  it('项目清单默认当前项目，显式 #项目 优先并提示离开当前清单', () => {
    const context = { kind: 'project' as const, projectId: 'project-a', label: '项目A' }
    expect(createInputForContext(resolve('写报告'), context, 'a').projectId).toBe('project-a')
    expect(createInputForContext(resolve('写报告 #项目B'), context, 'b').projectId).toBe('project-b')
    expect(contextHint(context, resolve('写报告 #项目B'))).toContain('目标项目')
  })

  it('计划清单只给无日期、期限或重复规则的任务补默认计划', () => {
    const context = { kind: 'planned' as const, plannedDate: TODAY }
    expect(createInputForContext(resolve('写报告'), context, 'a').plannedDate).toBe(TODAY)
    expect(createInputForContext(resolve('明天 写报告'), context, 'b').plannedDate).toBe('2026-09-24')
    expect(createInputForContext(resolve('写报告 {明天}'), context, 'c').plannedDate).toBeNull()
    expect(createInputForContext(resolve('写报告 {明天}'), context, 'c').dueDate).toBe('2026-09-24')
    expect(createInputForContext(resolve('每天 写报告'), context, 'd').plannedDate).toBeNull()
    expect(contextDeparture(context, resolve('每天 写报告'))).toContain('全部任务')
    expect(contextDeparture({ ...context, planPeriod: 'scheduled' }, resolve('每天 写报告'))).toBeNull()
  })

  it('计划周沿用周粒度，不改成计划日', () => {
    const input = createInputForContext(resolve('写报告'), { kind: 'planned', plannedWeek: '2026-09-28' }, 'a')
    expect(input.plannedWeek).toBe('2026-09-28')
    expect(input.plannedDate).toBeNull()
  })

  it('未安排保持无日期；显式日期离开当前筛选时给出准确去向', () => {
    const unscheduled = { kind: 'planned' as const, planPeriod: 'unscheduled' as const, label: '未安排' }
    expect(createInputForContext(resolve('写报告'), unscheduled, 'a').plannedDate).toBeNull()
    expect(contextHint(unscheduled, resolve('写报告'))).toBeNull()
    expect(contextDeparture(unscheduled, resolve('明天 写报告'))).toContain('不在当前时间筛选')

    const today = { kind: 'planned' as const, planPeriod: 'today' as const, plannedDate: TODAY }
    expect(contextDeparture(today, resolve('今天 写报告'))).toBeNull()
    expect(contextDeparture(today, resolve('明天 写报告'))).toContain('已安排')
  })

  it('未来计划的落点按本周与远期计划区分', () => {
    expect(whereItLanded('2026-09-25', null, TODAY)).toContain('「计划 → 本周」')
    expect(whereItLanded('2026-09-29', null, TODAY)).toContain('「计划 → 以后」')
    expect(whereItLanded('2026-09-29', null, TODAY)).not.toContain('「计划 → 本周」')
    expect(whereItLanded('2026-09-29', '2026-09-29', TODAY)).toBe('')
  })
})
