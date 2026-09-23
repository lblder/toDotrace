import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { compareDayKey } from '@shared/time'
import type { QuickAddToken } from '@shared/quickadd'
import { useQuickAdd } from '../../hooks/use-quick-add'
import { useSettings } from '../../hooks/use-settings'
import { useTaskActions } from '../../hooks/use-tasks'
import { errorMessage } from '../../lib/api-client'
import { IconAlert, IconInfo } from '../common/Icons'
import { IMPORTANCE_TEXT } from './labels'
import { describeDate, describePlannedWeek } from './day-text'
import { describeRule } from './rule-text'
import { quickAddToCreateInput } from './payload'

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
export function QuickAddBox() {
  const quickAdd = useQuickAdd()
  const actions = useTaskActions()
  const settings = useSettings()
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { result, canSubmit, ready, text } = quickAdd
  /**
   * 提交后那句提示要用的「今天」——**必须是服务端回带的那个**（ADR-015 §6）。
   * 拿不到（设置还没读回来）就什么都不说，而不是拿本机时钟顶一个上去。
   */
  const today = settings.settings?.affectsFrom ?? null

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!canSubmit || !ready || actions.create.isPending) return
    setFeedback(null)

    actions.create.mutate(quickAddToCreateInput(result), {
      onSuccess: (payload) => {
        const { task } = payload
        quickAdd.reset()
        inputRef.current?.focus()
        setFeedback({
          tone: 'info',
          // 幂等命中要说出来（对齐打卡页对 created 的处置）：服务端没写第二条，
          // 假装「新建成功」会让用户以为双击提交产生了两条。
          text: payload.created
            ? `已添加。${whereItLanded(task.plannedDate, task.dueDate, today)}`
            : '这条任务之前已经建过（同一个标识），没有重复添加。',
        })
      },
      onError: (cause) => {
        setFeedback({ tone: 'error', text: errorMessage(cause) })
      },
    })
  }

  return (
    <section className="ta-card ta-tasks__quick" aria-labelledby="quick-add-heading">
      <h2 className="ta-tasks__sectionHeading" id="quick-add-heading">
        快速录入
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
            placeholder="明天 写实验报告 @科研 #实验 !高 {下周五}"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="ta-btn ta-btn--primary"
            disabled={!canSubmit || !ready || actions.create.isPending}
            aria-busy={actions.create.isPending}
          >
            {actions.create.isPending ? '正在添加…' : '添加'}
          </button>
        </div>
      </form>

      <p className="ta-tasks__syntax">
        认得：<code className="ta-mono">明天</code> <code className="ta-mono">9月23日</code>{' '}
        <code className="ta-mono">下周三</code> <code className="ta-mono">3天后</code>{' '}
        <code className="ta-mono">下周</code>（落到「计划周」） <code className="ta-mono">每天</code>{' '}
        <code className="ta-mono">!高</code> <code className="ta-mono">@标签</code>{' '}
        <code className="ta-mono">#项目</code> <code className="ta-mono">{'{期限}'}</code>；
        不认得的<strong>一个字都不动</strong>，原样留在标题里。
      </p>

      <Preview
        quickAdd={quickAdd}
        disabled={actions.create.isPending}
        placeholder="在下面输入时，这里会实时显示解析结果"
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
        </p>
      )}
    </section>
  )
}

/**
 * 「加完之后它去哪儿了」。
 *
 * 起因是一个真实的经验：写下 `明天 交材料` 之后，它在默认的「今日」视图里
 * **看不见**——因为 §3 的入选规则 A 是 `plannedDate ≤ today`，
 * 而明天的那条不满足任何一条 A–F。这是规格规定的正确行为，但**没有任何提示**，
 * 用户只会以为「加了没反应」。这一句就是那个提示。
 *
 * 判据只在**能说死**的情形下才说：`plannedDate > today` 且无期限、未开始、不重复时，
 * A–F 六条全部不成立——这时说「它在「本周」里」是**确定**的。
 * 其余情形一个字都不说（说不出确定的话就不说，而不是说一句可能是假的话）。
 */
function whereItLanded(
  plannedDate: string | null,
  dueDate: string | null,
  today: string | null,
): string {
  if (today === null || plannedDate === null || dueDate !== null) return ''
  if (compareDayKey(plannedDate, today) <= 0) return ''
  return `它计划在 ${describeDate(plannedDate, today)}，「今日」只收今天到期与已逾期的，所以它在「本周」视图里。`
}

/**
 * 预览区。
 *
 * ⚠️ **不用 `aria-live`**：预览会在每次按键后变化，逐字播报会把读屏器淹没。
 * 改为让输入框 `aria-describedby` 这片区域，用户主动去读时才读。
 */
function Preview({
  quickAdd,
  disabled,
  placeholder,
}: {
  quickAdd: ReturnType<typeof useQuickAdd>
  disabled: boolean
  placeholder: string
}) {
  const { result, quoted, suppressed, toggleSuppressed, text, ready, canSubmit } = quickAdd

  if (text.length === 0) {
    return <p className="ta-tasks__previewEmpty">{placeholder}</p>
  }

  const quarantined = result.released.filter((token) => !suppressed.includes(token.start))

  return (
    <div className="ta-tasks__preview" id="quick-add-preview">
      <p className="ta-tasks__previewLine">
        <span className="ta-tasks__previewKey">标题</span>
        <span className="ta-tasks__previewTitle" data-testid="quick-add-title">
          {result.title.length === 0 ? '（空——标题不能只由碎片组成）' : result.title}
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

      {result.adopted.length === 0 && result.released.length === 0 ? (
        <p className="ta-tasks__previewNote">
          {quoted
            ? '整串引号：这一层不解析任何碎片，一个字都没有被拿走。'
            : '没有识别到任何碎片——原文全部留在标题里。'}
        </p>
      ) : null}

      {quarantined.length > 0 ? (
        <p className="ta-tasks__previewNote">
          未被采纳（<strong>原文仍在标题里</strong>，可以改写法让它生效）：
          {quarantined.map((token) => (
            <code className="ta-mono ta-tasks__released" key={token.start}>
              {token.text}
            </code>
          ))}
        </p>
      ) : null}

      {suppressed.length > 0 ? (
        <p className="ta-tasks__previewNote">
          你取消了 {suppressed.length} 个识别，它们的原文已经回到标题：
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
          账号设置还没读到，预览暂按本机时区折算；<strong>读到之前不能提交</strong>。
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
