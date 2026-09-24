import { compareDayKey, weekEnd, type DayKey } from '@shared/time'
import type { QuickAddResult } from '@shared/quickadd'
import { matchesPlanPeriod, type PlanPeriod } from '@shared/tasks/views'
import type { CreateTaskInput } from '../../lib/api-client'
import { describeDate, describePlannedWeek } from './day-text'
import { quickAddToCreateInput } from './payload'

type Importance = NonNullable<QuickAddResult['importance']>

export interface QuickAddBoxContext {
  readonly kind: 'my-day' | 'important' | 'planned' | 'project' | 'all'
  readonly projectId?: string
  readonly plannedDate?: DayKey
  readonly plannedWeek?: DayKey
  readonly planPeriod?: PlanPeriod
  readonly label?: string
}

/** 表单预览和提交共用同一套上下文默认值。 */
export function contextFields(
  result: QuickAddResult,
  context?: QuickAddBoxContext,
): {
  readonly importance: Importance | null
  readonly projectId: string | null
  readonly plannedDate: DayKey | null
  readonly plannedWeek: DayKey | null
} {
  const needsPlanDefault =
    context?.kind === 'planned' &&
    result.plannedDate === null &&
    result.plannedWeek === null &&
    result.dueDate === null &&
    result.recurrence === null
  return {
    importance: result.importance ?? (context?.kind === 'important' ? 'high' : null),
    projectId: result.projectId ?? (context?.kind === 'project' ? context.projectId ?? null : null),
    plannedDate: result.plannedDate ?? (needsPlanDefault ? context?.plannedDate ?? null : null),
    plannedWeek: result.plannedWeek ?? (needsPlanDefault && context?.plannedDate === undefined ? context?.plannedWeek ?? null : null),
  }
}

/** 清单上下文只补用户没写的字段；解析器识别出的明确输入始终优先。 */
export function createInputForContext(
  result: QuickAddResult,
  context?: QuickAddBoxContext,
  taskId?: string,
): CreateTaskInput {
  const input = quickAddToCreateInput(result, taskId)
  const { importance, ...fields } = contextFields(result, context)
  return {
    ...input,
    ...fields,
    ...(importance === null ? {} : { importance }),
  }
}

/** 提前说明上下文默认值与显式覆盖，避免创建后任务从当前清单中消失。 */
export function contextHint(
  context: QuickAddBoxContext | undefined,
  result: QuickAddResult,
): string | null {
  switch (context?.kind) {
    case 'my-day':
      return null
    case 'important':
      return result.importance !== null && result.importance !== 'high'
        ? '将保存到“全部任务”。'
        : '默认标记为重要。'
    case 'project':
      return result.projectId !== null && result.projectId !== context.projectId
        ? '将保存到目标项目。'
        : `归入「${context.label ?? '当前项目'}」。`
    case 'planned':
      if (result.recurrence !== null) {
        return null
      }
      if (result.plannedDate !== null || result.plannedWeek !== null || result.dueDate !== null) {
        return null
      }
      if (context.plannedDate) return `默认计划在 ${describeDate(context.plannedDate, result.today)}。`
      if (context.plannedWeek) return `默认计划在 ${describePlannedWeek(context.plannedWeek)}。`
      return null
    case 'all':
    case undefined:
      return null
  }
}

export function contextDeparture(
  context: QuickAddBoxContext | undefined,
  result: QuickAddResult,
): string | null {
  if (context?.kind === 'important' && result.importance !== null && result.importance !== 'high') {
    return '已按你输入的重要性保存，可在「全部任务」查看。'
  }
  if (context?.kind === 'project' && result.projectId !== null && result.projectId !== context.projectId) {
    return '已按你输入的项目保存，可在目标项目或「全部任务」查看。'
  }
  if (context?.kind === 'planned' && result.recurrence !== null) {
    if (context.planPeriod === 'unscheduled') {
      return '重复任务已有安排，不在「未安排」中；可在「已安排」或「全部任务」查看。'
    }
    return context.planPeriod === 'scheduled'
      ? null
      : '重复任务已按规则安排；若不在当前时间筛选，可在「已安排」或「全部任务」查看。'
  }
  if (context?.kind === 'planned' && (result.plannedDate !== null || result.plannedWeek !== null || result.dueDate !== null)) {
    if (context.planPeriod === undefined) {
      return '已按输入日期或期限保存；若不在当前时间筛选，可在「已安排」或「全部任务」查看。'
    }
    if (matchesInputPlanPeriod(result, context.planPeriod)) return null
    return '已按输入日期或期限保存；它不在当前时间筛选，可在「已安排」或「全部任务」查看。'
  }
  return null
}

/** 普通任务的解析结果映射到共享计划筛选所需的最小字段。 */
function matchesInputPlanPeriod(result: QuickAddResult, period: PlanPeriod): boolean {
  return matchesPlanPeriod({
    plannedDate: result.plannedDate,
    plannedWeek: result.plannedWeek,
    dueDate: result.dueDate,
    recurring: false,
    scheduledOccurrenceDate: null,
  }, period, result.today)
}

/** 只在能确定视图归属时提示；远期计划不能误称“本周”。 */
export function whereItLanded(
  plannedDate: DayKey | null,
  dueDate: DayKey | null,
  today: DayKey | null,
): string {
  if (today === null || plannedDate === null || dueDate !== null) return ''
  if (compareDayKey(plannedDate, today) <= 0) return ''
  const destination = compareDayKey(plannedDate, weekEnd(today)) <= 0 ? '本周' : '以后'
  return `它计划在 ${describeDate(plannedDate, today)}，可在「计划 → ${destination}」查看。`
}
