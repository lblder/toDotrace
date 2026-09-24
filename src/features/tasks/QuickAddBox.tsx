import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { DayKey } from '@shared/time'
import type { QuickAddToken } from '@shared/quickadd'
import { useQuickAdd } from '../../hooks/use-quick-add'
import { useSettings } from '../../hooks/use-settings'
import { useTaskActions } from '../../hooks/use-tasks'
import { useFocusActions } from '../../hooks/use-focus'
import { api, errorMessage, type TaskView } from '../../lib/api-client'
import { IconAlert, IconInfo } from '../common/Icons'
import { IMPORTANCE_TEXT } from './labels'
import { describeDate, describePlannedWeek } from './day-text'
import { describeRule } from './rule-text'
import {
  contextDeparture,
  contextHint,
  createInputForContext,
  whereItLanded,
  type QuickAddBoxContext,
} from './quick-add-context'

export type { QuickAddBoxContext } from './quick-add-context'

interface PendingFocus {
  readonly taskId: string
  readonly title: string
  readonly occurrenceKey: DayKey | null
  readonly recurring: boolean
  readonly indexDate: DayKey
}

/** 服务端任务详情是重复任务当前有效轮次的唯一来源。 */
export async function focusKeyFor(task: Pick<TaskView, 'taskId' | 'recurring' | 'indexDate'>): Promise<DayKey | null> {
  if (!task.recurring) return task.indexDate
  const detail = await api.getTask(task.taskId)
  return detail.occurrences.find((round) => round.status === 'pending')?.originalPlannedDate ?? null
}

/**
 * 快速录入框（ADR-014）。
 *
 * 三件事在界面上必须成立，否则这条功能等于没有：
 *
 * 1. **实时预览解析出的碎片**，并且**显示解析后的绝对日期**（用户裁决 5）；
 * 2. **粒度要对**（§4.3）：`下周` 显示成「计划周 9月28日那一周」，
 *    而 `下周三` 显示成「计划日 9月30日(周三)」——两者不可互相代用；
 * 3. **三层逃生舱都能用**：① 整串引号 ② `\` 单 token ③ 预览碎片上点 `×`；
 *    且 ③ 取消之后**文本回到标题**（不是被删掉）。
 *
 * 第 3 条的界面含义：被 `×` 掉的碎片不是消失了，而是从「已识别」挪到
 * 「未识别（原文仍在标题里）」那一行——两行都摆出来，用户才能看出
 * 点 `×` 到底做了什么（§2 的采纳集模型：取消 = 从采纳集里去掉再重算）。
 */
export function QuickAddBox({ context }: { readonly context?: QuickAddBoxContext }) {
  const quickAdd = useQuickAdd()
  const actions = useTaskActions()
  const focusActions = useFocusActions()
  const settings = useSettings()
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlightRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const { result, canSubmit, ready, text } = quickAdd
  /**
   * 提交后那句提示要用的「今天」——**必须是服务端回带的那个**（ADR-015 §6）。
   * 拿不到（设置还没读回来）就什么都不说，而不是拿本机时钟顶一个上去。
   */
  const today = settings.settings?.affectsFrom ?? null
  const hint = contextHint(context, result)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canSubmit || !ready || inFlightRef.current || pendingFocus !== null) return
    inFlightRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const payload = await actions.create.mutateAsync(createInputForContext(result, context))
      const { task } = payload
      quickAdd.reset()
      inputRef.current?.focus()

      if (context?.kind === 'my-day') {
        const pending: PendingFocus = {
          taskId: task.taskId,
          title: task.title,
          occurrenceKey: null,
          recurring: task.recurring,
          indexDate: task.indexDate,
        }
        let focusKey: DayKey | null = null
        try {
          focusKey = await focusKeyFor(task)
          if (focusKey === null) {
            setFeedback({ tone: 'info', text: '任务已创建。重复任务首轮尚未到期，到期后可加入我的一天。' })
            return
          }
          await focusActions.add.mutateAsync({ taskId: task.taskId, occurrenceKey: focusKey })
          setFeedback({ tone: 'info', text: '已添加到我的一天。' })
        } catch (cause) {
          // 创建已经成功；重试只请求详情/聚焦，绝不再次 POST /api/tasks。
          setPendingFocus({ ...pending, occurrenceKey: focusKey })
          setFeedback({ tone: 'error', text: `任务「${task.title}」已创建，但加入我的一天失败：${errorMessage(cause)}` })
        }
        return
      }

      const departure = contextDeparture(context, result)
      setFeedback({
        tone: 'info',
        text: !payload.created
          ? '任务已存在。'
          : departure !== null
            ? `已添加。${departure}`
            : context?.kind === 'important'
              ? '已添加到重要任务。'
              : context?.kind === 'project'
                ? `已添加到「${context.label ?? '当前项目'}」。`
                : context?.kind === 'planned' && (task.plannedDate !== null || task.plannedWeek !== null || task.dueDate !== null)
                  ? '已添加到计划。'
                  : `已添加。${whereItLanded(task.plannedDate, task.dueDate, today)}`,
      })
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause) })
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
      const occurrenceKey = pendingFocus.occurrenceKey ?? await focusKeyFor({
        taskId: pendingFocus.taskId,
        recurring: pendingFocus.recurring,
        indexDate: pendingFocus.indexDate,
      })
      if (occurrenceKey === null) {
        setPendingFocus(null)
        setFeedback({ tone: 'info', text: '任务已创建。重复任务首轮尚未到期，到期后可加入我的一天。' })
        return
      }
      await focusActions.add.mutateAsync({ taskId: pendingFocus.taskId, occurrenceKey })
      setPendingFocus(null)
      setFeedback({ tone: 'info', text: `任务「${pendingFocus.title}」已加入我的一天。` })
    } catch (cause) {
      setFeedback({ tone: 'error', text: `任务「${pendingFocus.title}」已创建，但加入我的一天失败：${errorMessage(cause)}` })
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="ta-card ta-tasks__quick" aria-labelledby="quick-add-heading">
      <h2 className="ta-tasks__sectionHeading" id="quick-add-heading">
        添加任务
      </h2>

      <form className="ta-tasks__quickForm" onSubmit={handleSubmit}>
        <label className="ta-field__label" htmlFor="quick-add-input">
          写点什么
        </label>
        <div className="ta-tasks__quickRow">
          <input
            id="quick-add-input"
            ref={inputRef}
            className="ta-input"
            type="text"
            value={text}
            onChange={(event) => quickAdd.setText(event.target.value)}
            placeholder="添加任务，例如：明天 写实验报告"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="ta-btn ta-btn--primary"
            disabled={!canSubmit || !ready || busy || pendingFocus !== null}
            aria-busy={busy}
          >
            {busy ? '正在添加…' : '添加'}
          </button>
        </div>
      </form>

      {hint === null ? null : (
        <p className="ta-tasks__syntaxHelp" data-testid="quick-add-context-hint">
          {hint}
        </p>
      )}

      <details className="ta-tasks__syntaxHelp"><summary>输入示例</summary><p className="ta-tasks__syntax">
        认得：<code className="ta-mono">明天</code> <code className="ta-mono">9月23日</code>{' '}
        <code className="ta-mono">下周三</code> <code className="ta-mono">3天后</code>{' '}
        <code className="ta-mono">下周</code>（落到「计划周」） <code className="ta-mono">每天</code>{' '}
        <code className="ta-mono">!高</code> <code className="ta-mono">@标签</code>{' '}
        <code className="ta-mono">#项目</code> <code className="ta-mono">{'{期限}'}</code>。
      </p></details>

      <QuickAddPreview
        quickAdd={quickAdd}
        disabled={busy}
      />

      {feedback === null ? null : (
        <p
          className={
            feedback.tone === 'error' ? 'ta-banner ta-banner--error' : 'ta-banner ta-banner--info'
          }
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          data-testid="quick-add-feedback"
        >
          {feedback.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
          <span>{feedback.text}</span>
          {pendingFocus === null ? null : (
            <span>
              <button type="button" className="ta-btn" onClick={() => void retryFocus()} disabled={busy}>
                重试加入
              </button>{' '}
              <button
                type="button"
                className="ta-btn"
                onClick={() => {
                  setPendingFocus(null)
                  setFeedback({ tone: 'info', text: `任务「${pendingFocus.title}」已保留，可稍后从“全部任务”加入我的一天。` })
                }}
                disabled={busy}
              >
                仅保留任务
              </button>
            </span>
          )}
        </p>
      )}
    </section>
  )
}

/**
 * 预览区。
 *
 * ⚠️ **不用 `aria-live`**：预览会在每次按键后变化，逐字播报会把读屏器淹没。
 * 改为让输入框 `aria-describedby` 这片区域，用户主动去读时才读。
 */
export function QuickAddPreview({
  quickAdd,
  disabled,
}: {
  quickAdd: ReturnType<typeof useQuickAdd>
  disabled: boolean
}) {
  const { result, suppressed, toggleSuppressed, text, ready, canSubmit } = quickAdd

  if (text.length === 0) {
    return null
  }

  const quarantined = result.released.filter((token) => !suppressed.includes(token.start))

  return (
    <div className="ta-tasks__preview" id="quick-add-preview">
      <p className="ta-tasks__previewLine">
        <span className="ta-tasks__previewKey">标题</span>
        <span className="ta-tasks__previewTitle" data-testid="quick-add-title">
          {result.title.length === 0 ? '请输入任务标题' : result.title}
        </span>
      </p>

      <ul className="ta-tasks__chips" data-testid="quick-add-adopted">
        {result.adopted.map((token) => (
          <li key={token.start}>
            <span className="ta-tasks__chip">
              <span className="ta-tasks__chipText">{fragmentText(token, result.today, result.recurrence !== null)}</span>
              <button
                type="button"
                className="ta-tasks__chipCancel"
                onClick={() => toggleSuppressed(token.start)}
                disabled={disabled}
                aria-label={`取消识别「${token.text}」，它的原文会回到标题`}
                title={`取消识别「${token.text}」`}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>


      {quarantined.length > 0 ? (
        <p className="ta-tasks__previewNote">
          未识别，保留为标题：
          {quarantined.map((token) => (
            <code className="ta-mono ta-tasks__released" key={token.start}>
              {token.text}
            </code>
          ))}
        </p>
      ) : null}

      {suppressed.length > 0 ? (
        <p className="ta-tasks__previewNote">
          已保留为标题：
          {suppressed.map((start) => {
            const token = result.released.find((candidate) => candidate.start === start)
            return token === undefined ? null : (
              <code className="ta-mono ta-tasks__released" key={start}>
                {token.text}
              </code>
            )
          })}
        </p>
      ) : null}

      {ready ? null : (
        <p className="ta-tasks__previewNote">
          正在读取设置，请稍候再添加。
        </p>
      )}
      {ready && !canSubmit && result.title.length > 500 ? (
        <p className="ta-tasks__previewNote">标题超过 500 个字符，请缩短后再添加。</p>
      ) : null}
    </div>
  )
}

/**
 * 一个碎片的可读呈现 —— **绝对日期 + 粒度**（ADR-014 §1 / §4.3 / §7）。
 *
 * 三个分支各自对应一条口径，不能合并：
 * - `date` 在非重复任务上落 `plannedDate`，在重复任务上落的是 **`startsOn` 的相位输入 `D₀`**
 *   （§6 的落点表第二列）——写成「计划日」会是假话，因为重复任务的 `plannedDate` 恒空；
 * - `plannedWeek` 走 `describeWeek`（「9月28日那一周」），**不折算成周一那一天**；
 * - `recurrence` 必须显示 `startsOn`（§7）：`plannedDate` 恒空，用户唯一能看到的
 *   「这件事什么时候开始」就是这个值。
 */
function fragmentText(token: QuickAddToken, today: string, recurring: boolean): string {
  switch (token.kind) {
    case 'date':
      return recurring
        ? `起算日 ${describeDate(token.date, today)}`
        : `计划日 ${describeDate(token.date, today)}`
    case 'plannedWeek':
      return `计划周 ${describePlannedWeek(token.weekStart)}`
    case 'dueDate':
      return `期限 ${describeDate(token.date, today)}`
    case 'importance':
      return `重要性 ${IMPORTANCE_TEXT[token.importance]}`
    case 'tag':
      return `标签 ${token.tag}`
    case 'project':
      return `项目 ${token.projectName}`
    case 'recurrence':
      return `重复 ${describeRule(token.recurrence.rule)} · 首轮 ${describeDate(token.recurrence.startsOn, today)}`
  }
}
