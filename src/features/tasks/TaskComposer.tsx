import { ImportanceButton } from './ImportanceButton'
import { useRef, useState, type FormEvent } from 'react'
import { isDayKey, weekStart, type DayKey } from '@shared/time'
import type { QuickAddResult } from '@shared/quickadd'
import { matchesPlanPeriod } from '@shared/tasks/views'
import { useQuickAdd } from '../../hooks/use-quick-add'
import { useProjects } from '../../hooks/use-projects'
import { useTaskActions } from '../../hooks/use-tasks'
import { useFocusActions } from '../../hooks/use-focus'
import { errorMessage } from '../../lib/api-client'
import { IconAlert, IconInfo } from '../common/Icons'
import { QuickAddPreview, focusKeyFor } from './QuickAddBox'
import {
  contextDeparture,
  contextFields,
  contextHint,
  createInputForContext,
  whereItLanded,
  type QuickAddBoxContext,
} from './quick-add-context'
import { describeDate } from './day-text'
import { describeRule } from './rule-text'
import './composer.css'

type Importance = NonNullable<QuickAddResult['importance']>
type PlanLevel = 'none' | 'day' | 'week'
type Feedback = { readonly tone: 'info' | 'error'; readonly text: string }

interface Overrides {
  readonly level?: PlanLevel
  readonly planDay?: string
  readonly planWeek?: string
  readonly dueDate?: string
  readonly importance?: Importance
  readonly projectId?: string
}

interface PendingFocus {
  readonly taskId: string
  readonly title: string
  readonly occurrenceKey: DayKey | null
  readonly recurring: boolean
  readonly indexDate: DayKey
}

export interface TaskComposerProps {
  readonly context: QuickAddBoxContext
  readonly onCreated?: (taskId: string) => void
  readonly onNotice?: (input: { text: string; tone?: 'info' | 'error' }) => void
}

/** 新建详情：一句话解析与结构化字段共用同一份提交载荷。 */
export function TaskComposer({ context, onCreated, onNotice }: TaskComposerProps) {
  const quickAdd = useQuickAdd()
  const projects = useProjects()
  const actions = useTaskActions()
  const focusActions = useFocusActions()
  const [notes, setNotes] = useState('')
  const [overrides, setOverrides] = useState<Overrides>({})
  const [pomodoroEnabled, setPomodoroEnabled] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlightRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const { result, text, ready, canSubmit } = quickAdd
  const defaults = contextFields(result, context)
  const defaultLevel: PlanLevel = defaults.plannedDate !== null ? 'day'
    : defaults.plannedWeek !== null ? 'week' : 'none'
  const level = overrides.level ?? defaultLevel
  const planDay = overrides.planDay ?? defaults.plannedDate ?? ''
  const planWeek = overrides.planWeek ?? defaults.plannedWeek ?? ''
  const dueDate = overrides.dueDate ?? result.dueDate ?? ''
  const importance = overrides.importance ?? defaults.importance ?? 'normal'
  const projectId = overrides.projectId ?? defaults.projectId ?? ''
  const recurring = result.recurrence !== null
  const validPlan = recurring || level === 'none'
    || (level === 'day' ? isDayKey(planDay) : isDayKey(planWeek))
  const validDueDate = recurring || dueDate === '' || isDayKey(dueDate)

  const effectiveResult: QuickAddResult = {
    ...result,
    plannedDate: recurring || level !== 'day' || !isDayKey(planDay) ? null : planDay,
    plannedWeek: recurring || level !== 'week' || !isDayKey(planWeek) ? null : weekStart(planWeek),
    dueDate: recurring || !isDayKey(dueDate) ? null : dueDate,
    importance,
    projectId: projectId === '' ? null : projectId,
  }
  const hint = contextHint(context, effectiveResult)

  function changeQuickText(value: string): void {
    quickAdd.setText(value)
    // 手动覆盖是用户的明确选择；继续修改标题时保留日期、重要性与项目。
    setFeedback(null)
  }

  function clearForm(): void {
    quickAdd.reset()
    setOverrides({})
    setNotes('')
    setPomodoroEnabled(false)
    inputRef.current?.focus()
  }

  function publish(input: Feedback): void {
    setFeedback(input)
    onNotice?.({ text: input.text, tone: input.tone })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canSubmit || !ready || !validPlan || !validDueDate || pendingFocus !== null || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setFeedback(null)

    const plannedDate = recurring || level !== 'day' ? null : planDay as DayKey
    const plannedWeek = recurring || level !== 'week' ? null : weekStart(planWeek)
    const finalInput = {
      ...createInputForContext(result, context),
      title: result.title,
      notes,
      plannedDate,
      plannedWeek,
      dueDate: recurring || dueDate === '' ? null : dueDate as DayKey,
      importance,
      projectId: projectId === '' ? null : projectId,
      pomodoroEnabled,
    }

    try {
      const payload = await actions.create.mutateAsync(finalInput)
      const task = payload.task
      clearForm()

      if (context.kind === 'my-day') {
        let occurrenceKey: DayKey | null = null
        try {
          occurrenceKey = await focusKeyFor(task)
          if (occurrenceKey === null) {
            publish({ tone: 'info', text: '任务已创建。重复任务首轮尚未到期，到期后可加入我的一天。' })
            onCreated?.(task.taskId)
            return
          }
          await focusActions.add.mutateAsync({ taskId: task.taskId, occurrenceKey })
          publish({ tone: 'info', text: '已添加到我的一天。' })
          onCreated?.(task.taskId)
        } catch (cause) {
          // 创建已落库；后续只重试读取轮次与加入聚焦，不再 POST 创建。
          setPendingFocus({
            taskId: task.taskId,
            title: task.title,
            occurrenceKey,
            recurring: task.recurring,
            indexDate: task.indexDate,
          })
          publish({ tone: 'error', text: `任务「${task.title}」已创建，但加入我的一天失败：${errorMessage(cause)}` })
        }
        return
      }

      const departure = contextDeparture(context, effectiveResult)
      const planStillVisible = context.kind !== 'planned' || context.planPeriod === undefined || task.recurring
        || matchesPlanPeriod({
          plannedDate: task.plannedDate,
          plannedWeek: task.plannedWeek,
          dueDate: task.dueDate,
          recurring: false,
          scheduledOccurrenceDate: null,
        }, context.planPeriod, result.today)
      const planDestination = task.plannedDate !== null || task.plannedWeek !== null || task.dueDate !== null
        ? '已安排' : '未安排'
      const location = departure ?? (!planStillVisible ? `已添加。可在「计划 → ${planDestination}」或「全部任务」查看。`
        : context.kind === 'planned' ? '已添加到计划。'
        : context.kind === 'important' ? '已添加到重要任务。'
          : context.kind === 'project' ? `已添加到「${context.label ?? '当前项目'}」。`
            : `已添加。${whereItLanded(task.plannedDate, task.dueDate, result.today)}`)
      publish({ tone: 'info', text: payload.created ? location : '任务已存在。' })
      onCreated?.(task.taskId)
    } catch (cause) {
      publish({ tone: 'error', text: errorMessage(cause) })
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  async function retryFocus(): Promise<void> {
    if (pendingFocus === null || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    try {
      const occurrenceKey = pendingFocus.occurrenceKey ?? await focusKeyFor(pendingFocus)
      if (occurrenceKey === null) {
        setPendingFocus(null)
        publish({ tone: 'info', text: '任务已创建。重复任务首轮尚未到期，到期后可加入我的一天。' })
        onCreated?.(pendingFocus.taskId)
        return
      }
      await focusActions.add.mutateAsync({ taskId: pendingFocus.taskId, occurrenceKey })
      setPendingFocus(null)
      publish({ tone: 'info', text: `任务「${pendingFocus.title}」已加入我的一天。` })
      onCreated?.(pendingFocus.taskId)
    } catch (cause) {
      publish({ tone: 'error', text: `任务「${pendingFocus.title}」已创建，但加入我的一天失败：${errorMessage(cause)}` })
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="ta-composer" aria-labelledby="task-composer-title">
      <h2 className="ta-sr-only" id="task-composer-title">新建任务</h2>

      <form className="ta-composer__form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="ta-composer__body">
          <label className="ta-field" htmlFor="quick-add-input">
            <span className="ta-field__label">任务名称</span>
            <input
              id="quick-add-input"
              ref={inputRef}
              className="ta-input ta-composer__titleInput"
              type="text"
              aria-label="写点什么"
              aria-describedby={text.length > 0 ? 'quick-add-preview' : undefined}
              value={text}
              onChange={(event) => changeQuickText(event.target.value)}
              placeholder="例如：明天 写实验报告"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          <QuickAddPreview quickAdd={quickAdd} disabled={busy} />
          <details className="ta-composer__examples">
            <summary>输入示例</summary>
            <p>支持“明天 写报告”“下周 交周报”“每天 复习”，也可加 <code>!高</code>、<code>#项目</code> 和 <code>{'{期限}'}</code>。解析结果可在下方调整。</p>
          </details>
          {hint === null ? null : <p className="ta-composer__hint">{hint}</p>}

          <label className="ta-field">
            <span className="ta-field__label">备注</span>
            <textarea
              className="ta-input ta-composer__notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={20000}
              rows={3}
              placeholder="补充步骤、资料或完成标准（可选）"
              disabled={busy}
            />
          </label>

          <div className="ta-composer__section">
            <div className="ta-composer__sectionHead"><span>计划安排</span><small>何时做</small></div>
            {recurring ? (
              <p className="ta-composer__recurrence">
                {describeRule(result.recurrence!.rule)} · 首轮 {describeDate(result.recurrence!.startsOn, result.today)}
                <small>重复任务由规则安排日期。点上方解析碎片的 × 可取消重复。</small>
              </p>
            ) : (
              <>
                <div className="ta-composer__segments" role="group" aria-label="计划方式">
                  {([['none', '未安排'], ['day', '计划日'], ['week', '计划周']] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={level === value ? 'ta-composer__segment ta-composer__segment--active' : 'ta-composer__segment'}
                      aria-pressed={level === value}
                      onClick={() => setOverrides((previous) => ({
                        ...previous,
                        level: value,
                        ...(value === 'day' && !isDayKey(planDay) ? { planDay: result.today } : {}),
                        ...(value === 'week' && !isDayKey(planWeek) ? { planWeek: weekStart(result.today) } : {}),
                      }))}
                      disabled={busy}
                    >{label}</button>
                  ))}
                </div>
                {level === 'day' ? (
                  <label className="ta-field">
                    <span className="ta-field__label">计划日</span>
                    <input className="ta-input" type="date" value={planDay} onChange={(event) => setOverrides((previous) => ({ ...previous, planDay: event.target.value }))} disabled={busy} />
                  </label>
                ) : level === 'week' ? (
                  <label className="ta-field">
                    <span className="ta-field__label">计划周 · 选择该周任意一天</span>
                    <input className="ta-input" type="date" value={planWeek} onChange={(event) => setOverrides((previous) => ({ ...previous, planWeek: event.target.value }))} disabled={busy} />
                  </label>
                ) : null}
                <label className="ta-field">
                  <span className="ta-field__label">截止日期 <small>可选</small></span>
                  <input className="ta-input" type="date" value={dueDate} onChange={(event) => setOverrides((previous) => ({ ...previous, dueDate: event.target.value }))} disabled={busy} />
                </label>
              </>
            )}
          </div>

          <div className="ta-composer__section">
            <div className="ta-composer__sectionHead"><span>归类</span><small>可选</small></div>
            <div className="ta-field">
              <span className="ta-field__label">重要性</span>
              <ImportanceButton important={importance === 'high'} disabled={busy} onChange={(important) => setOverrides((previous) => ({ ...previous, importance: important ? 'high' : 'normal' }))} />
            </div>
            <label className="ta-field">
              <span className="ta-field__label">项目</span>
              <select className="ta-input" value={projectId} onChange={(event) => setOverrides((previous) => ({ ...previous, projectId: event.target.value }))} disabled={busy}>
                <option value="">无项目</option>
                {projects.active.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
            </label>
          </div>

          <label className="ta-composer__pomodoro">
            <input type="checkbox" checked={pomodoroEnabled} onChange={(event) => setPomodoroEnabled(event.target.checked)} disabled={busy} />
            <span><strong>番茄计时（25 分钟）</strong><small>需要专注时开启；短任务可以直接完成。</small></span>
          </label>

          {feedback === null ? null : (
            <div className={feedback.tone === 'error' ? 'ta-banner ta-banner--error' : 'ta-banner ta-banner--info'} role={feedback.tone === 'error' ? 'alert' : 'status'} data-testid="quick-add-feedback">
              {feedback.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
              <span>{feedback.text}</span>
              {pendingFocus === null ? null : (
                <div className="ta-composer__retry">
                  <button type="button" className="ta-btn ta-btn--sm" onClick={() => void retryFocus()} disabled={busy}>重试加入</button>
                  <button type="button" className="ta-btn ta-btn--sm" onClick={() => {
                    const taskId = pendingFocus.taskId
                    setPendingFocus(null)
                    publish({ tone: 'info', text: '任务已保留，可稍后从全部任务加入我的一天。' })
                    onCreated?.(taskId)
                  }} disabled={busy}>仅保留任务</button>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="ta-composer__footer">
          <button className="ta-btn ta-btn--primary" type="submit" disabled={!canSubmit || !ready || !validPlan || !validDueDate || busy || pendingFocus !== null} aria-busy={busy}>
            {busy ? '正在添加…' : '添加'}
          </button>
          {!canSubmit && text.length > 0 ? <small>请输入有效标题（最多 500 字）</small> : null}
        </footer>
      </form>
    </section>
  )
}
