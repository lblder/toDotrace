import { ImportanceButton } from './ImportanceButton'
import { useState } from 'react'
import { weekStart, type DayKey } from '@shared/time'
import { MAX_TAGS } from '@shared/quickadd'
import { DEFAULT_NEXT_ANCHOR_MODE, type NextAnchorMode } from '@shared/recurrence'
import {
  canChangeStatus,
  canRescheduleTask,
  type RecurrenceSpec,
  type TaskStatus,
  type TodoItem,
} from '@shared/tasks'
import type { ProjectRow, TaskDetailPayload, TaskView } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import type { TaskActions } from '../../hooks/use-tasks'
import { useTaskDetail } from '../../hooks/use-tasks'
import { IconAlert } from '../common/Icons'
import { describePlannedWeek } from './day-text'
import { describeRule, FREQ_OPTIONS, WEEKDAY_OPTIONS } from './rule-text'
import { TimerTaskSettings } from '../timer/TimerControls'
import { isUpcomingPreview } from '@shared/tasks/views'

type PlanLevel = 'none' | 'day' | 'week'

/**
 * 任务详情 / 编辑（FR2.1 的字段全集）。
 *
 * ## 为什么这里有**两个**保存按钮
 *
 * 因为 ADR-017 §4 把写入路径按字段劈成了两条，而这**不是界面上的任意选择**：
 *
 * | 字段 | 写入者 | 为什么 |
 * |---|---|---|
 * | 标题 / 备注 / 重要性 / 标签 / 项目 / 重复规则 | `PATCH /api/tasks/:id`（**整行快照**） | 这些是「这条任务是什么」 |
 * | 计划日 / 计划周 / 期限 | `POST /api/tasks/reschedule` | **一个字段只有一个写入者**（ADR-013 §4.2）；日期锚点的唯一写入者是 `task/rescheduled`（ADR-016 §9 行 3） |
 *
 * 把两者合成一个「保存」等于让界面假装只有一条路径，而服务端会把日期字段
 * 直接 `400`（ADR-017 §4 的排除清单）。故界面上分成「定义」与「排期」两块，
 * **各自的按钮只管自己那半边**——用户点哪个按钮会发生什么，是可预期的。
 */
export interface TaskDetailFormProps {
  readonly item: TodoItem
  readonly today: DayKey
  readonly projects: readonly ProjectRow[]
  readonly actions: TaskActions
  /**
   * **写成功之后的页面级反馈**。
   *
   * 为什么不能只留在行内：这一类写入会让**本行从当前视图里进出**，而行内状态
   * 跟着行一起卸载重建——
   *
   * - 放弃 → 该行从默认视图消失（§4 的优先级表）；
   * - 给一条有日期的任务打开重复 → 两次写入之间它会短暂地「无锚点、不重复」，
   *   于是从今日视图里**闪出一下再回来**（ADR-013 §3.1 要求先清锚点、再写规则）。
   *
   * 两种情况下行内的「已保存」都会随行消失，用户只看到「点了保存，什么都没说」。
   * 故成功的确认一律由页面承接；**失败仍在行内**（那时行还在，就近说明更清楚）。
   */
  readonly onNotice: (input: { text: string }) => void
}

/**
 * 明细的**外框**：先把实体读回来（`GET /api/tasks/:id`，ADR-017 §1.1），再交给编辑器。
 *
 * 为什么必须多这一趟：列表行是 `TodoItem`，它带的是 `recurring: boolean`，
 * **不带规则本身**（ADR-015 §1 的字段表里没有 `recurrence`）。
 * 于是「这条重复任务到底怎么重复」只能从 `Task` 上读——而那是明细接口给的。
 * 拿 `recurring` 去反推规则（比如默认「每天」）就是凭空发明一条用户没写过的规则。
 */
export function TaskDetailForm(props: TaskDetailFormProps) {
  const detail = useTaskDetail(props.item.taskId)

  if (detail.isError) {
    return (
      <div className="ta-tasks__detail">
        <p className="ta-banner ta-banner--error" role="alert">
          <IconAlert size={18} />
          <span>{errorMessage(detail.error)}</span>
        </p>
      </div>
    )
  }

  if (detail.detail === null) {
    return (
      <div className="ta-tasks__detail">
        <p className="ta-tasks__hint">正在读取任务…</p>
      </div>
    )
  }

  return <TaskDetailEditor {...props} detail={detail.detail} />
}

function TaskDetailEditor({
  item,
  detail,
  today,
  projects,
  actions,
  onNotice,
}: TaskDetailFormProps & { readonly detail: TaskDetailPayload }) {
  const task: TaskView = detail.task
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [importanceOverride, setImportance] = useState<typeof task.importance | null>(null)
  const importance = importanceOverride ?? task.importance
  const [tagsText, setTagsText] = useState(task.tags.join(' '))
  const [projectId, setProjectId] = useState(task.projectId ?? '')
  const [recurrence, setRecurrence] = useState<RecurrenceSpec | null>(task.recurrence)

  const [level, setLevel] = useState<PlanLevel>(
    task.plannedWeek !== null ? 'week' : task.plannedDate !== null ? 'day' : 'none',
  )
  const [planDay, setPlanDay] = useState(task.plannedDate ?? '')
  const [planWeek, setPlanWeek] = useState(task.plannedWeek ?? '')
  const [dueDate, setDueDate] = useState(task.dueDate ?? '')

  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const rescheduleVerdict = canRescheduleTask({ recurrence: task.recurrence })
  const reopenVerdict = canChangeStatus({
    from: item.status,
    to: 'not_started',
    recurring: item.recurring,
  })

  /**
   * 保存「定义」。
   *
   * ⚠️ **先清空日期锚点，再打开重复**——两步，顺序不能反（ADR-013 §3.1）：
   * 重复任务的 `plannedDate` / `plannedWeek` / `dueDate` **恒为 `null`**，
   * 载荷 schema 会以 `400` 拒绝「有规则又有日期」的组合。而清除锚点只能走
   * `/reschedule`（`PATCH` 不收这三个字段），故这是一次两步写入。
   * **不假装一步能成**：失败时界面说清是哪一步没成。
   */
  async function saveDefinition(): Promise<void> {
    setFeedback(null)
    setBusy(true)
    try {
      const anchors = [task.plannedDate, task.plannedWeek, task.dueDate]
      const willBeRecurring = recurrence !== null
      if (willBeRecurring && anchors.some((anchor) => anchor !== null)) {
        await actions.reschedule.mutateAsync([
          { taskId: item.taskId, plannedDate: null, plannedWeek: null, dueDate: null },
        ])
      }
      await actions.update.mutateAsync({
        taskId: item.taskId,
        input: {
          title,
          notes,
          ...(importanceOverride === null ? {} : { importance: importanceOverride }),
          tags: parseTags(tagsText),
          projectId: projectId === '' ? null : projectId,
          recurrence,
        },
      })
      setImportance(null)
      setFeedback({ tone: 'info', text: '已保存。' })
      onNotice({ text: `已保存《${title}》。` })
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause) })
    } finally {
      setBusy(false)
    }
  }

  /** 保存「排期」——**单条顺延走的就是批量那条路由**（`items.length === 1`，ADR-017 §9） */
  async function saveSchedule(): Promise<void> {
    setFeedback(null)
    setBusy(true)
    try {
      await actions.reschedule.mutateAsync([
        {
          taskId: item.taskId,
          plannedDate: level === 'day' && planDay !== '' ? planDay : null,
          // 周级锚点**必须落在周一**（ADR-016 §1）：用户在日历上点哪天都行，
          // 归一化在提交前用 `weekStart` 做，**不自己写一套周的算法**。
          plannedWeek: level === 'week' && planWeek !== '' ? weekStart(planWeek) : null,
          dueDate: dueDate === '' ? null : dueDate,
        },
      ])
      setFeedback({ tone: 'info', text: '已改期。' })
      onNotice({ text: `已改期《${title}》的排期。` })
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause) })
    } finally {
      setBusy(false)
    }
  }

  function changeStatus(to: 'abandoned' | 'not_started'): void {
    const verdict = canChangeStatus({ from: item.status, to, recurring: item.recurring })
    if (!verdict.allowed) {
      setFeedback({ tone: 'error', text: verdict.message })
      return
    }
    setFeedback(null)
    actions.setStatus.mutate(
      { taskId: item.taskId, to },
      {
        onSuccess: () => {
          setFeedback({
            tone: 'info',
            text: to === 'abandoned' ? '已放弃。' : '已重新打开，回到「未开始」。',
          })
          // 同一句话也交给页面级那条横幅（见 props 的注释：行内反馈会随行消失）
          onNotice({
            text:
              to === 'abandoned'
                ? `已放弃《${item.title}》。完成记录一条都没有被删（ADR-013 §2）——它在「已放弃」筛选里，随时可以重新打开。`
                : `《${item.title}》已重新打开，回到「未开始」。`,
          })
        },
        onError: (cause) => setFeedback({ tone: 'error', text: errorMessage(cause) }),
      },
    )
  }

  return (
    <div className="ta-tasks__detail">
      <TimerTaskSettings taskId={item.taskId} occurrenceKey={item.occurrenceKey} canStart={item.status !== 'abandoned' && (!item.recurring || item.pending)} completed={item.completedAt !== null}/>
      {item.steps.length > 0 ? <section className="ta-tasks__detailSteps" aria-label="任务步骤">
        <h3 className="ta-tasks__fieldsetTitle">步骤 {item.steps.filter((step) => step.checkedAt !== null).length}/{item.steps.length}</h3>
        <ul className="ta-tasks__stepList">{item.steps.map((step) => <li className="ta-tasks__step" key={step.id}>
          <input type="checkbox" checked={step.checkedAt !== null}
            aria-label={`步骤「${step.title}」（${item.title} 的这一轮）`}
            disabled={isUpcomingPreview(item, today) || item.status === 'abandoned' || actions.toggleStep.isPending}
            onChange={(event) => actions.toggleStep.mutate({ taskId: item.taskId, stepId: step.id, originalPlannedDate: item.occurrenceKey, checked: event.target.checked }, {
              onError: (cause) => setFeedback({ tone: 'error', text: errorMessage(cause) }),
            })}/>
          <span className={step.checkedAt !== null ? 'ta-tasks__stepText--done' : undefined}>{step.title}</span>
        </li>)}</ul>
      </section> : null}
      <dl className="ta-tasks__facts">
        <div>
          <dt>{isUpcomingPreview(item, today) ? '下一轮预计日期' : '本轮日期'}</dt>
          <dd className="ta-mono" data-testid="detail-occurrence">
            {item.occurrenceKey}
          </dd>
        </div>
        <div>
          <dt>创建于</dt>
          <dd className="ta-mono">{item.createdAt}</dd>
        </div>
        <div>
          <dt>完成情况</dt>
          <dd className="ta-mono">{isUpcomingPreview(item, today) ? '尚未开始此轮' : item.completedDayKey ?? '未完成'}</dd>
        </div>
      </dl>

      {/*
        历史区（轮次历史，ADR-011 §4 的 `Round`）。
        **它是「放弃不抹除历史」在界面上最完整的那一处证据**：一条已放弃的重复任务，
        这里仍逐轮列着「哪一天完成过」。列表行只显示本实例，这一块显示全部轮次。
      */}
      {detail.occurrences.length === 0 ? null : (
        <div className="ta-tasks__historyBlock" data-testid="round-history">
          <h4 className="ta-tasks__fieldsetTitle">历史（全部轮次）</h4>
          <ul className="ta-tasks__historyList">
            {detail.occurrences.map((round) => (
              <li key={round.originalPlannedDate} className="ta-mono">
                {round.originalPlannedDate}
                {round.status === 'completed'
                  ? ` · 完成于 ${round.completedDayKey ?? '（未记录归属日）'}`
                  : ' · 待完成'}
              </li>
            ))}
          </ul>
        </div>
      )}


      {/* --- 定义：PATCH 整行快照（ADR-017 §4） --- */}
      <div className="ta-tasks__fieldset">
        <h4 className="ta-tasks__fieldsetTitle">任务信息</h4>

        <label className="ta-field">
          <span className="ta-field__label">标题</span>
          <input
            className="ta-input"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={500}
            aria-label="标题"
          />
        </label>

        <label className="ta-field">
          <span className="ta-field__label">备注</span>
          <textarea
            className="ta-input ta-tasks__notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            aria-label="备注"
          />
        </label>

        <div className="ta-tasks__grid">
          <div className="ta-field">
            <span className="ta-field__label">重要性</span>
            <ImportanceButton important={importance === 'high'} disabled={busy} onChange={(important) => setImportance(important ? 'high' : 'normal')} />
          </div>

          <label className="ta-field">
            <span className="ta-field__label">项目</span>
            <select
              className="ta-input"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-label="项目"
            >
              <option value="">（不归属任何项目）</option>
              {/* 服务端只返回未删除的项目，故这里不再滤一遍（那会滤成空列表） */}
              {projects.filter((project) => !project.archived || project.projectId === projectId).map((project) => (
                <option value={project.projectId} key={project.projectId}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="ta-field">
          <span className="ta-field__label">标签（空格分隔，至多 {MAX_TAGS} 个）</span>
          <input
            className="ta-input"
            type="text"
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
            aria-label="标签"
          />
        </label>

        <RecurrenceEditor value={recurrence} onChange={setRecurrence} today={today} />

        <div className="ta-tasks__detailActions">
          <button
            type="button"
            className="ta-btn ta-btn--primary ta-btn--sm"
            onClick={() => void saveDefinition()}
            disabled={busy || title.trim().length === 0}
          >
            保存任务
          </button>
          {title.trim().length === 0 ? (
            <span className="ta-field__hint">标题不能为空（服务端会以 400 拒绝空标题）</span>
          ) : null}
        </div>
      </div>

      {/* --- 排期：reschedule（ADR-017 §9） --- */}
      <div className="ta-tasks__fieldset">
        <h4 className="ta-tasks__fieldsetTitle">排期</h4>

        {rescheduleVerdict.allowed ? null : (
          <p className="ta-field__hint" data-testid="reschedule-blocked">
            重复任务的日期由规则决定。要更改起点，请调整重复设置。
          </p>
        )}

        <fieldset
          className="ta-tasks__radios"
          disabled={!rescheduleVerdict.allowed}
          aria-label="计划层级"
        >
          <legend className="ta-field__label">计划归在哪一层</legend>
          <label>
            <input
              type="radio"
              name={`level-${item.taskId}`}
              checked={level === 'none'}
              onChange={() => setLevel('none')}
            />
            不指定
          </label>
          <label>
            <input
              type="radio"
              name={`level-${item.taskId}`}
              checked={level === 'day'}
              onChange={() => setLevel('day')}
            />
            某一天
          </label>
          <label>
            <input
              type="radio"
              name={`level-${item.taskId}`}
              checked={level === 'week'}
              onChange={() => setLevel('week')}
            />
            某一周
          </label>
          <p className="ta-field__hint">
            选择某一天或某一周，只能选一种计划方式。
          </p>
        </fieldset>

        {level === 'day' ? (
          <label className="ta-field">
            <span className="ta-field__label">计划日</span>
            <input
              className="ta-input"
              type="date"
              value={planDay}
              onChange={(event) => setPlanDay(event.target.value)}
              aria-label="计划日"
            />
          </label>
        ) : null}

        {level === 'week' ? (
          <label className="ta-field">
            <span className="ta-field__label">计划周（随便点这一周里的哪天）</span>
            <input
              className="ta-input"
              type="date"
              value={planWeek}
              onChange={(event) => setPlanWeek(event.target.value)}
              aria-label="计划周"
            />
            <span className="ta-field__hint" data-testid="week-preview">
              {planWeek === '' ? '还没选' : `计划周 ${describePlannedWeek(weekStart(planWeek))}`}
            </span>
          </label>
        ) : null}

        <label className="ta-field">
          <span className="ta-field__label">期限</span>
          <input
            className="ta-input"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-label="期限"
          />
        </label>

        <div className="ta-tasks__detailActions">
          <button
            type="button"
            className="ta-btn ta-btn--secondary ta-btn--sm"
            onClick={() => void saveSchedule()}
            disabled={busy || !rescheduleVerdict.allowed}
            title={rescheduleVerdict.allowed ? undefined : rescheduleVerdict.message}
          >
            保存排期
          </button>
        </div>
      </div>

      {/* --- 终止与重开（ADR-013 §2 的两条显式动作） --- */}
      <div className="ta-tasks__fieldset">
        <h4 className="ta-tasks__fieldsetTitle">状态</h4>
        <p className="ta-field__hint">
          放弃后保留历史完成记录。
        </p>
        <div className="ta-tasks__detailActions">
          {item.status === 'abandoned' ? (
            <button
              type="button"
              className="ta-btn ta-btn--secondary ta-btn--sm"
              onClick={() => changeStatus('not_started')}
              disabled={!reopenVerdict.allowed || actions.setStatus.isPending}
            >
              重新打开（回到未开始）
            </button>
          ) : (
            <button
              type="button"
              className="ta-btn ta-btn--danger ta-btn--sm"
              onClick={() => changeStatus('abandoned')}
              disabled={actions.setStatus.isPending}
              data-testid={`abandon-${item.taskId}`}
            >
              放弃
            </button>
          )}
        </div>
      </div>

      {feedback === null ? null : (
        <p
          className={
            feedback.tone === 'error' ? 'ta-banner ta-banner--error' : 'ta-banner ta-banner--info'
          }
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          data-testid="detail-feedback"
        >
          {feedback.tone === 'error' ? <IconAlert size={18} /> : null}
          <span>{feedback.text}</span>
        </p>
      )}

      {isUpcomingPreview(item, today) ? <p className="ta-field__hint">{item.occurrenceKey} 起可完成本轮任务。</p> : null}
    </div>
  )
}

/**
 * 重复规则编辑器。
 *
 * 覆盖 ADR-011 §2 的规则词汇（`freq` / `interval` / `byDayOfWeek` / `byMonthDay`）
 * 与 §5 的三锚点。**不提供 `count` / `until`**——它们的语义（「总共几轮」「截止到哪天」）
 * 需要 FR2.5 的逾期提示配合，而那属另一条需求；不摆出来比摆一个说不清后果的开关好。
 */
function RecurrenceEditor({
  value,
  onChange,
  today,
}: {
  value: RecurrenceSpec | null
  onChange: (next: RecurrenceSpec | null) => void
  today: DayKey
}) {
  const freq = value?.rule.freq ?? 'none'
  const startsOn = value?.startsOn ?? today
  const interval = value?.rule.interval ?? 1
  const anchorMode = value?.nextAnchorMode ?? DEFAULT_NEXT_ANCHOR_MODE

  function rebuild(next: {
    freq: string
    interval?: number
    startsOn?: DayKey
    byDayOfWeek?: readonly number[]
    byMonthDay?: readonly number[]
    mode?: NextAnchorMode
  }): void {
    if (next.freq === 'none') {
      onChange(null)
      return
    }
    const nextInterval = next.interval ?? interval
    const rule: RecurrenceSpec['rule'] = {
      freq: next.freq as RecurrenceSpec['rule']['freq'],
      interval: Math.max(1, nextInterval),
      ...(next.freq === 'weekly' && next.byDayOfWeek !== undefined
        ? { byDayOfWeek: [...next.byDayOfWeek].sort((a, b) => a - b) }
        : {}),
      ...(next.freq === 'monthly' && next.byMonthDay !== undefined
        ? { byMonthDay: [...next.byMonthDay] }
        : {}),
    }
    onChange({
      rule,
      nextAnchorMode: next.mode ?? anchorMode,
      startsOn: next.startsOn ?? startsOn,
    })
  }

  return (
    <div className="ta-tasks__recurrence">
      <label className="ta-field">
        <span className="ta-field__label">重复</span>
        <select
          className="ta-input"
          value={freq}
          onChange={(event) => rebuild({ freq: event.target.value })}
          aria-label="重复频率"
        >
          <option value="none">不重复</option>
          {FREQ_OPTIONS.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {value === null ? null : (
        <>
          <div className="ta-tasks__grid">
            {freq === 'daily' || freq === 'yearly' ? null : (
              <label className="ta-field">
                <span className="ta-field__label">间隔</span>
                <input
                  className="ta-input"
                  type="number"
                  min={1}
                  value={interval}
                  onChange={(event) => rebuild({ freq, interval: Number(event.target.value) })}
                  aria-label="重复间隔"
                />
              </label>
            )}

            <label className="ta-field">
              <span className="ta-field__label">首轮起点（`startsOn`）</span>
              <input
                className="ta-input"
                type="date"
                value={startsOn}
                onChange={(event) => rebuild({ freq, startsOn: event.target.value })}
                aria-label="首轮起点"
              />
            </label>
          </div>

          {freq === 'weekly' ? (
            <div className="ta-tasks__weekdays" role="group" aria-label="星期几">
              {WEEKDAY_OPTIONS.map((option) => {
                const current = value.rule.byDayOfWeek ?? []
                const on = current.includes(option.index)
                return (
                  <button
                    type="button"
                    key={option.index}
                    className={on ? 'ta-btn ta-btn--primary ta-btn--sm' : 'ta-btn ta-btn--secondary ta-btn--sm'}
                    aria-pressed={on}
                    onClick={() =>
                      rebuild({
                        freq,
                        byDayOfWeek: on
                          ? current.filter((day) => day !== option.index)
                          : [...current, option.index],
                      })
                    }
                  >
                    周{option.label}
                  </button>
                )
              })}
            </div>
          ) : null}

          {freq === 'monthly' ? (
            <label className="ta-field">
              <span className="ta-field__label">每月几号（留空 = 按起点日）</span>
              <input
                className="ta-input"
                type="number"
                min={1}
                max={31}
                value={value.rule.byMonthDay?.[0] ?? ''}
                onChange={(event) =>
                  rebuild({
                    freq,
                    byMonthDay: event.target.value === '' ? [] : [Number(event.target.value)],
                  })
                }
                aria-label="每月几号"
              />
            </label>
          ) : null}

          <label className="ta-field">
            <span className="ta-field__label">完成一轮后，下一轮怎么定</span>
            <select
              className="ta-input"
              value={anchorMode}
              onChange={(event) => rebuild({ freq, mode: event.target.value as NextAnchorMode })}
              aria-label="下一轮锚点"
            >
              <option value="catch_up">② 追赶到今天之后（默认）</option>
              <option value="extend">① 按原计划顺延</option>
              <option value="recompute">③ 按完成日重算</option>
            </select>
          </label>

          <p className="ta-field__hint">
            当前规则：<span className="ta-mono">{describeRule(value.rule)}</span>
            ，首轮 <span className="ta-mono">{value.startsOn}</span>。
            {freq === 'weekly' && (value.rule.byDayOfWeek ?? []).length === 0
              ? '（没选星期几时，按起点日的星期）'
              : null}
          </p>
          <p className="ta-field__hint">
            保存重复规则后，将清除原计划日期和期限。
          </p>
        </>
      )}
    </div>
  )
}

/** 标签输入 → 数组。**只做切分**：trim / 去重 / 丢空串由服务端做一次（ADR-017 §3） */
function parseTags(text: string): string[] {
  const parts = text.split(/[\s,，]+/).filter((part) => part.length > 0)
  return parts.slice(0, MAX_TAGS)
}
