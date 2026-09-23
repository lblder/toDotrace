import { useEffect, useMemo, useState } from 'react'
import { compareDayKey, formatDayKey, weekEnd, weekStart } from '@shared/time'
import type { DayKey } from '@shared/time'
import {
  canRescheduleTask,
  queryItems,
  sortItems,
  type SortMode,
  type StatusFilter,
} from '@shared/tasks'
import type { RescheduleItem, TaskListQuery } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import { useDayNote, useSaveDayNote, useSettings, useUpdateSettings } from '../../hooks/use-settings'
import { useProjectActions, useProjects } from '../../hooks/use-projects'
import { useTaskActions, useTaskList } from '../../hooks/use-tasks'
import { IconAlert, IconInfo } from '../common/Icons'
import { QuickAddBox } from './QuickAddBox'
import { TaskRow } from './TaskRow'
import { ProjectPanel } from './ProjectPanel'
import { STATUS_FILTER_TEXT, STATUS_FILTER_HINT, SORT_TEXT } from './labels'
import './tasks.css'

type View = 'today' | 'week' | 'project' | 'all'

const VIEWS: readonly { readonly value: View; readonly label: string }[] = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'project', label: '项目' },
  { value: 'all', label: '全部' },
]

/**
 * 撤销窗口（FR3：**30 秒是界面提示时长，不是服务端能力边界**）。
 *
 * 服务端可以撤销任何批次（ADR-017 §8：**不做 30 秒窗口的服务端强制**）。
 * 窗口在这里是纯 UI 状态——因此它天然可测，而服务端窗口会让撤销变成不可测试的。
 */
const UNDO_WINDOW_MS = 30_000

/**
 * 任务页（阶段 4）。
 *
 * ## 两件事写在了结构里，而不是注释里
 *
 * 1. **`today` 一律取服务端响应里的那个**（ADR-015 §6）。本页面自己不算「今天」，
 *    它把 `today` 从 `/api/tasks` 的响应里取出来，用于**展示与档位**；
 *    凡是要回传给服务端的东西（勾选、完成、顺延）用的都是**行上的既有值**
 *    （`occurrenceKey`、用户选的绝对日期），没有一处经过本地时钟。
 * 2. **排序与筛选不在这里重写**（ADR-015 §7）：`queryItems` 与 `sortItems`
 *    都是 `shared/tasks` 的纯函数，服务端用的是同一份。
 */
export function TasksPage() {
  const [view, setView] = useState<View>('today')
  const [sortMode, setSortMode] = useState<SortMode>('smart')
  const [statusFilter, setStatusFilter] = useState<StatusFilter | 'default'>('default')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [selection, setSelection] = useState<readonly string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [batchDate, setBatchDate] = useState('')
  const [banner, setBanner] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [undoState, setUndoState] = useState<{ batchId: string; title: string } | null>(null)

  const projectsApi = useProjects()
  const projectActions = useProjectActions()
  const actions = useTaskActions()

  // 项目视图的默认打开对象 = 当前项目（ADR-016 §4 的三个用途之一）
  const effectiveProject = selectedProject ?? projectsApi.currentProjectId
  useEffect(() => {
    if (selectedProject === null && projectsApi.currentProjectId !== null) {
      setSelectedProject(projectsApi.currentProjectId)
    }
  }, [selectedProject, projectsApi.currentProjectId])

  /** 项目视图但没选中项目——此时不渲染清单（见下面那条说明） */
  const projectUnselected = view === 'project' && effectiveProject === null

  const listQuery: TaskListQuery = useMemo(() => {
    if (view === 'week') return { scope: 'week' }
    if (view === 'project' && effectiveProject !== null) {
      return { scope: 'project', projectId: effectiveProject }
    }
    return { scope: view === 'today' ? 'today' : 'all' }
  }, [view, effectiveProject])

  const list = useTaskList(listQuery)
  const { today } = list

  const projectInterval = useMemo(() => {
    if (listQuery.scope !== 'project') return null
    const row = projectsApi.projects.find((project) => project.projectId === listQuery.projectId)
    if (row === undefined) return null
    return { startsOn: row.startsOn, endsOn: row.endsOn }
  }, [listQuery, projectsApi.projects])

  /**
   * 筛选与排序 —— **判据只在 `shared/tasks`**。
   *
   * 默认视图（`statusFilter === 'default'`）的语义见 `filter.ts`：排除已放弃、
   * **保留已完成**（今天做完的仍要留在视野里，ADR-015 §3 D/F）。
   * 项目视图的区间分组（`outside_project_range`）也由它标注，界面据此分组。
   */
  const visible = useMemo(() => {
    if (today === null) return []
    const filtered = queryItems(list.items, {
      status: statusFilter === 'default' ? null : statusFilter,
      ...(projectInterval === null ? {} : { projectInterval }),
    })
    return sortItems(filtered, today, sortMode)
  }, [list.items, today, statusFilter, projectInterval, sortMode])

  const inRange = visible.filter((item) => !item.reasons.includes('outside_project_range'))
  const outsideRange = visible.filter((item) => item.reasons.includes('outside_project_range'))

  const selectedItems = visible.filter((item) => selection.includes(item.taskId))
  /**
   * 顺延的合法性判据只在 `shared/tasks/state.ts`（`canRescheduleTask`：**重复任务一律拒绝**）。
   * 这里用 `recurring` 是因为 `TodoItem` 只带这个布尔量（明细页有完整 `Task`，
   * 那里调的是 `canRescheduleTask` 本身）——两者是同一个判据的两种可用输入，不是两份规则。
   */
  const recurringSelected = selectedItems.filter((item) => item.recurring)

  function toggleSelect(taskId: string): void {
    setSelection((previous) =>
      previous.includes(taskId) ? previous.filter((id) => id !== taskId) : [...previous, taskId],
    )
  }

  /**
   * 批量顺延：**一个请求 = 一个批次**（ADR-017 §9），因此可被**一次撤销**回滚。
   *
   * 语义：把计划日整体挪到 `batchDate`，**期限各自保持不动**（FR2.7 的顺延只动计划，
   * 不该顺手改掉用户单独设的截止日）；`plannedWeek` 同时清空——它与 `plannedDate`
   * 不得同时非空（ADR-016 §1）。
   */
  function runBatchReschedule(): void {
    if (today === null || batchDate === '') return
    setBanner(null)

    const items: RescheduleItem[] = []
    for (const item of selectedItems) {
      // **重复任务一律拒绝**（ADR-013 §3.2）：整批会被服务端 409 挡下，
      // 而部分成功会让用户看到「一半挪了一半没挪」。故这里先挡，并说清是谁。
      if (item.recurring) {
        setBanner({
          tone: 'error',
          text: `《${item.title}》是重复任务，日期由规则决定，不能顺延——服务端会整批拒绝（409）。请先取消选中它。`,
        })
        return
      }
      if (item.plannedDate !== null && compareDayKey(batchDate, item.plannedDate) === 0) continue
      items.push({
        taskId: item.taskId,
        plannedDate: batchDate,
        plannedWeek: null,
        dueDate: item.dueDate,
      })
    }

    if (items.length === 0) {
      setBanner({ tone: 'info', text: '选中的任务本来就在那一天，没有需要改的。' })
      return
    }

    actions.reschedule.mutate(items, {
      onSuccess: (payload) => {
        setSelection([])
        setBanner({ tone: 'info', text: `已顺延 ${payload.tasks.length} 条（同一个批次，可一次撤销）。` })
      },
      onError: (cause) => setBanner({ tone: 'error', text: errorMessage(cause) }),
    })
  }

  /**
   * 页面级确认（详情里的**成功**写入都经由它）。
   *
   * 为什么必须在**行外面**：那些写入会让本行从当前视图进出——放弃会把它移出默认视图；
   * 给有日期的任务打开重复时，两次写入之间它会短暂地「无锚点、不重复」而闪出今日视图
   * ——行内反馈会随行一起卸载。用户需要的是一条活得更久的确认。
   */
  function handleNotice(input: { text: string }): void {
    setBanner({ tone: 'info', text: input.text })
  }

  function runUndo(): void {
    if (undoState === null) return
    actions.undo.mutate(undoState.batchId, {
      onSuccess: () => {
        setBanner({ tone: 'info', text: `已撤销删除：《${undoState.title}》回来了（逐字段还原）。` })
        setUndoState(null)
      },
      onError: (cause) => setBanner({ tone: 'error', text: errorMessage(cause) }),
    })
  }

  // 撤销窗口只是一个界面计时器；服务端不受它约束（ADR-017 §8）
  useEffect(() => {
    if (undoState === null) return
    const timer = window.setTimeout(() => setUndoState(null), UNDO_WINDOW_MS)
    return () => window.clearTimeout(timer)
  }, [undoState])

  return (
    <>
      <section className="ta-card ta-tasks__head" aria-labelledby="tasks-heading">
        <p className="ta-tasks__eyebrow ta-mono">TASKS</p>
        <h1 className="ta-tasks__heading" id="tasks-heading">
          任务
        </h1>
        <p className="ta-tasks__subtitle">
          「今天」由服务端按账号的时区与日界算出并回带。界面不自己算它——
          跨零点或跨日界的那一刻，两端会算出不同日期，而那个错误<strong>没有任何报错</strong>。
        </p>
        {/*
          这一行就是 ADR-017 §10 末段要的东西：显示响应里的 `today`。
          重取解决的是「列表过期」，显示 `today` 解决的是「用户不知道自己看的是哪一天」。
        */}
        <p className="ta-tasks__todayLine">
          今天是{' '}
          <span className="ta-mono ta-tasks__today" data-testid="server-today">
            {today ?? '正在读取…'}
          </span>
          {view === 'week' && today !== null ? (
            <span className="ta-tasks__metaItem">
              本周 {formatDayKey(weekStart(today))} – {formatDayKey(weekEnd(today))}
            </span>
          ) : null}
          <button
            type="button"
            className="ta-btn ta-btn--ghost ta-btn--sm"
            onClick={list.refetch}
          >
            重新读取
          </button>
        </p>
      </section>

      <QuickAddBox />

      <section className="ta-card ta-tasks__board" aria-labelledby="task-list-heading">
        <h2 className="ta-tasks__sectionHeading" id="task-list-heading">
          清单
        </h2>

        <div className="ta-tasks__toolbar">
          <div className="ta-tasks__tabs" role="tablist" aria-label="视图">
            {VIEWS.map((option) => (
              <button
                type="button"
                role="tab"
                key={option.value}
                aria-selected={view === option.value}
                className={cx('ta-tasks__tab', view === option.value && 'ta-tasks__tab--on')}
                onClick={() => {
                  setView(option.value)
                  setSelection([])
                }}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="ta-tasks__control">
            <span className="ta-field__label">排序</span>
            <select
              className="ta-input ta-tasks__select"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
            >
              {(Object.keys(SORT_TEXT) as SortMode[]).map((mode) => (
                <option value={mode} key={mode}>
                  {SORT_TEXT[mode]}
                </option>
              ))}
            </select>
          </label>

          <label className="ta-tasks__control">
            <span className="ta-field__label">状态</span>
            <select
              className="ta-input ta-tasks__select"
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as StatusFilter | 'default')
              }
              aria-label="状态筛选"
            >
              <option value="default">默认（不含已放弃）</option>
              {(Object.keys(STATUS_FILTER_TEXT) as StatusFilter[]).map((value) => (
                <option value={value} key={value}>
                  {STATUS_FILTER_TEXT[value]}
                </option>
              ))}
            </select>
          </label>

          {view === 'project' ? (
            <label className="ta-tasks__control">
              <span className="ta-field__label">项目</span>
              <select
                className="ta-input ta-tasks__select"
                value={effectiveProject ?? ''}
                onChange={(event) => {
                  setSelectedProject(event.target.value === '' ? null : event.target.value)
                  setSelection([])
                }}
                aria-label="查看哪个项目"
              >
                <option value="">（未选择）</option>
                {projectsApi.active.map((project) => (
                  <option value={project.projectId} key={project.projectId}>
                    {project.name}
                    {project.projectId === projectsApi.currentProjectId ? '（当前）' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <p className="ta-field__hint">{STATUS_FILTER_HINT}</p>

        {/*
          项目视图但没选中任何项目时，<strong>不能</strong>退回「全部」——
          那样标签页写着「项目」而列出的是全部任务，是一件说了假话的界面。
          这里改成交代清楚「先选一个项目」，并且<strong>不渲染清单</strong>。
        */}
        {projectUnselected ? (
          <p className="ta-banner ta-banner--info" role="status">
            <IconInfo size={18} />
            <span>
              还没有当前项目——请在上面选一个（或先在「项目」卡片里建一个）。
              项目视图是归属判定（`projectId === 项目`），不是区间判定：
              被排到项目区间之外的任务<strong>仍然会出现</strong>在项目清单里，
              只是被归到「区间外」那一组并注明原因。
            </span>
          </p>
        ) : null}

        {selection.length > 0 ? (
          <div className="ta-tasks__batch" role="group" aria-label="批量顺延">
            <span className="ta-tasks__batchCount">已选中 {selection.length} 条</span>
            <label className="ta-tasks__control">
              <span className="ta-field__label">顺延到</span>
              <input
                className="ta-input ta-tasks__select"
                type="date"
                value={batchDate}
                onChange={(event) => setBatchDate(event.target.value)}
                aria-label="顺延到"
              />
            </label>
            <button
              type="button"
              className="ta-btn ta-btn--secondary ta-btn--sm"
              onClick={runBatchReschedule}
              disabled={batchDate === '' || actions.reschedule.isPending}
            >
              {actions.reschedule.isPending ? '正在顺延…' : '顺延'}
            </button>
            <button
              type="button"
              className="ta-btn ta-btn--ghost ta-btn--sm"
              onClick={() => setSelection([])}
            >
              取消选择
            </button>
            {recurringSelected.length > 0 ? (
              <span className="ta-field__hint">（其中 {recurringSelected.length} 条是重复任务）</span>
            ) : null}
          </div>
        ) : null}

        {banner === null ? null : (
          <p
            className={banner.tone === 'error' ? 'ta-banner ta-banner--error' : 'ta-banner ta-banner--info'}
            role={banner.tone === 'error' ? 'alert' : 'status'}
            data-testid="board-banner"
          >
            {banner.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
            <span>{banner.text}</span>
          </p>
        )}

        {/* 删除可撤销（ADR-017 §8）：窗口只在界面上，服务端能撤销任何批次 */}
        {undoState === null ? null : (
          <p className="ta-banner ta-banner--info ta-tasks__undo" role="status">
            <IconInfo size={18} />
            <span>已删除《{undoState.title}》。</span>
            <button
              type="button"
              className="ta-btn ta-btn--secondary ta-btn--sm"
              onClick={runUndo}
              disabled={actions.undo.isPending}
              data-testid="undo-delete"
            >
              撤销（30 秒内）
            </button>
          </p>
        )}

        {projectUnselected ? null : list.isLoading || today === null ? (
          <p className="ta-tasks__hint">正在读取任务…</p>
        ) : list.isError ? (
          <div className="ta-tasks__errorBox">
            <p className="ta-banner ta-banner--error" role="alert">
              <IconAlert size={18} />
              <span>{errorMessage(list.error)}</span>
            </p>
            <button type="button" className="ta-btn ta-btn--secondary" onClick={list.refetch}>
              重试
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="ta-tasks__empty">
            这个视图下没有任务。上面那行输入框可以直接写一条——比如
            <code className="ta-mono">明天 交报告 @科研</code>。
          </p>
        ) : (
          <>
            {outsideRange.length > 0 && inRange.length === 0 ? null : (
              <ul className="ta-tasks__list">
                {inRange.map((item) => (
                  <TaskRow
                    key={`${item.taskId}:${item.occurrenceKey}`}
                    item={item}
                    today={today}
                    projects={projectsApi.projects}
                    actions={actions}
                    selected={selection.includes(item.taskId)}
                    onToggleSelect={toggleSelect}
                    expanded={expanded === item.taskId}
                    onToggleExpand={(taskId) => setExpanded(expanded === taskId ? null : taskId)}
                    onDeleted={(input) => setUndoState({ batchId: input.batchId, title: input.title })}
                    onNotice={handleNotice}
                  />
                ))}
              </ul>
            )}

            {/*
              项目视图的区间分组（ADR-015 §5 / ADR-016 §10 的调和方案）：
              「归属」与「区间」两件事各自可见，而不是让其中一个悄悄失效。
              没有这一组，用户会看到一条十月排期的任务出现在九月就结束的项目里，
              而界面不解释为什么——<strong>看起来像 bug</strong>。
            */}
            {outsideRange.length > 0 ? (
              <div className="ta-tasks__outside">
                <h3 className="ta-tasks__groupHeading">排期在项目区间之外（仍然属于这个项目）</h3>
                <ul className="ta-tasks__list">
                  {outsideRange.map((item) => (
                    <TaskRow
                      key={`${item.taskId}:${item.occurrenceKey}`}
                      item={item}
                      today={today}
                      projects={projectsApi.projects}
                      actions={actions}
                      selected={selection.includes(item.taskId)}
                      onToggleSelect={toggleSelect}
                      expanded={expanded === item.taskId}
                      onToggleExpand={(taskId) => setExpanded(expanded === taskId ? null : taskId)}
                      onDeleted={(input) =>
                        setUndoState({ batchId: input.batchId, title: input.title })
                      }
                      onNotice={handleNotice}
                    />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </section>

      <ProjectPanel projectsApi={projectsApi} projectActions={projectActions} />
      <DayNoteCard dayKey={today} />
      <SettingsCard />
    </>
  )
}

/**
 * 每日备注（ADR-017 §1.4 / §6）。
 *
 * **无到达也可以备注**——这不是疏漏，是 §6 的裁决：FR1 有「休息日」，
 * 而人恰恰在没去实验室的日子才更需要写一句（「发烧在家」「外出开会」）。
 * 故这里**不看打卡状态**，也不显示「先打卡」之类的门槛。
 */
function DayNoteCard({ dayKey }: { dayKey: DayKey | null }) {
  const note = useDayNote(dayKey)
  const save = useSaveDayNote()
  const [draft, setDraft] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  if (dayKey === null) return null

  const text = draft ?? note.note

  return (
    <section className="ta-card ta-tasks__note" aria-labelledby="day-note-heading">
      <h2 className="ta-tasks__sectionHeading" id="day-note-heading">
        这一天的备注
      </h2>
      <p className="ta-field__hint">
        归属日 <span className="ta-mono">{dayKey}</span>
        ——与打卡无关：没有到达记录的日子也能写。清空内容即删除这条备注。
      </p>
      <textarea
        className="ta-input ta-tasks__notes"
        rows={3}
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="这一天的备注"
        placeholder="比如：发烧在家 / 外出开会"
      />
      <div className="ta-tasks__detailActions">
        <button
          type="button"
          className="ta-btn ta-btn--secondary ta-btn--sm"
          disabled={save.isPending || draft === null}
          onClick={() => {
            setFeedback(null)
            save.mutate(
              { dayKey, text },
              {
                onSuccess: () => {
                  setDraft(null)
                  setFeedback(text === '' ? '已清除这一天的备注。' : '已保存。')
                },
                onError: (cause) => setFeedback(errorMessage(cause)),
              },
            )
          }}
        >
          保存备注
        </button>
        {feedback === null ? null : <span className="ta-field__hint">{feedback}</span>}
      </div>
    </section>
  )
}

/**
 * 设置入口：`dayStartHour`（ADR-017 §7，ADR-012 §1 的推迟项之一）。
 *
 * ⚠️ 界面必须说清「**不追溯**」：改 `dayStartHour` 只影响此后写入的事件，
 * 历史事件的 `day_key` 已固化、**永不重算**（ADR-001 §4）。
 * 这里显示 `affectsFrom`——它是服务端算的真实结果，不是一句抽象承诺。
 */
function SettingsCard() {
  const { settings, isLoading, isError, error } = useSettings()
  const update = useUpdateSettings()
  const [feedback, setFeedback] = useState<string | null>(null)

  return (
    <section className="ta-card ta-tasks__settings" aria-labelledby="settings-heading">
      <h2 className="ta-tasks__sectionHeading" id="settings-heading">
        一天从几点开始
      </h2>

      {isLoading ? (
        <p className="ta-tasks__hint">正在读取设置…</p>
      ) : isError || settings === null ? (
        <p className="ta-banner ta-banner--error" role="alert">
          <IconAlert size={18} />
          <span>{errorMessage(error)}</span>
        </p>
      ) : (
        <>
          <label className="ta-tasks__control">
            <span className="ta-field__label">日界（0–23 时）</span>
            <select
              className="ta-input ta-tasks__select"
              value={settings.dayStartHour}
              onChange={(event) => {
                setFeedback(null)
                update.mutate(
                  { dayStartHour: Number(event.target.value) },
                  {
                    onSuccess: (payload) =>
                      setFeedback(`已改为 ${payload.dayStartHour} 时。`),
                    onError: (cause) => setFeedback(errorMessage(cause)),
                  },
                )
              }}
              aria-label="日界小时"
              disabled={update.isPending}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option value={hour} key={hour}>
                  {hour} 时
                </option>
              ))}
            </select>
          </label>

          <p className="ta-field__hint" data-testid="settings-affects-from">
            此设置自 <strong>{formatDayKey(settings.affectsFrom)}</strong>（
            <span className="ta-mono">{settings.affectsFrom}</span>）起生效，
            <strong>此前的记录不会改变</strong>：每条记录的归属日在写入时固化，永不重算。
            时区当前是 <span className="ta-mono">{settings.timeZone}</span>。
          </p>
          {feedback === null ? null : <p className="ta-field__hint">{feedback}</p>}
        </>
      )}
    </section>
  )
}
