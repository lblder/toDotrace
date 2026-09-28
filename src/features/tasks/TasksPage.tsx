import { useCallback, useEffect, useMemo, useState } from 'react'
import { compareDayKey, formatDayKey, weekEnd, weekStart } from '@shared/time'
import type { DayKey } from '@shared/time'
import { queryItems, sortItems, type SortMode, type StatusFilter, type TodoItem } from '@shared/tasks'
import { itemKey, matchesPlanPeriod, matchesCompletionPeriod, upcomingTaskItem, isUpcomingPreview, planCreationDefaults, type PlanPeriod, type CompletionPeriod } from '@shared/tasks/views'
import type { RescheduleItem, TaskListQuery } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import { useDayNote, useSaveDayNote, useSettings, useUpdateSettings } from '../../hooks/use-settings'
import { useProjectActions, useProjects } from '../../hooks/use-projects'
import { useTaskActions, useTaskList } from '../../hooks/use-tasks'
import { useFocusActions, useTodayFocus } from '../../hooks/use-focus'
import { IconAlert, IconInfo } from '../common/Icons'
import { TaskComposer } from './TaskComposer'
import { TimerControls } from '../timer/TimerControls'
import { TaskRow } from './TaskRow'
import { TaskDetailForm } from './TaskDetailForm'
import { ProjectMenu, type ProjectMenuTarget } from './ProjectMenu'
import { ProjectPanel } from './ProjectPanel'
import { ProjectSortableList } from './ProjectSortableList'
import { SORT_TEXT } from './labels'
import './tasks.css'

type View = 'focus' | 'planned' | 'completed' | 'project' | 'all'
const SMART_VIEWS = [
  { value: 'focus', label: '我的一天', glyph: '☀' },
  { value: 'planned', label: '计划', glyph: '▦' },
  { value: 'all', label: '全部任务', glyph: '☷' },
] as const
const VIEW_TITLES: Record<View, string> = {
  focus: '我的一天', planned: '计划', completed: '已完成', project: '项目任务', all: '全部任务',
}
const PLAN_PERIODS: { value: PlanPeriod; label: string }[] = [
  { value: 'scheduled', label: '已安排' }, { value: 'overdue', label: '逾期 / 待调整' },
  { value: 'today', label: '今天' }, { value: 'week', label: '本周' },
  { value: 'later', label: '以后' }, { value: 'unscheduled', label: '未安排' },
]
const UNDO_WINDOW_MS = 30_000

export function TasksPage() {
  const [projectMenu, setProjectMenu] = useState<ProjectMenuTarget | null>(null)
  const closeProjectMenu = useCallback(() => setProjectMenu(null), [])
  const [view, setView] = useState<View>('focus')
  const [planPeriod, setPlanPeriod] = useState<PlanPeriod>('scheduled')
  const [completionPeriod, setCompletionPeriod] = useState<CompletionPeriod>('all')
  const [sortMode, setSortMode] = useState<SortMode>('smart')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selection, setSelection] = useState<readonly string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [batchDate, setBatchDate] = useState('')
  const [banner, setBanner] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [undoState, setUndoState] = useState<{ batchId: string; title: string } | null>(null)
  const [panelMode, setPanelMode] = useState<'overview' | 'create' | 'projects' | 'note' | 'settings'>('overview')
  const projectsApi = useProjects()
  const projectActions = useProjectActions()
  const actions = useTaskActions()
  const focus = useTodayFocus()
  const focusActions = useFocusActions()
  const effectiveProject = selectedProject
  const currentProject = projectsApi.projects.find((project) => project.projectId === effectiveProject)
  const projectUnselected = view === 'project' && currentProject === undefined
  const listQuery: TaskListQuery = view === 'completed' ? { scope: 'completed' }
    : view === 'project' && effectiveProject !== null ? { scope: 'project', projectId: effectiveProject } : { scope: 'all' }
  const list = useTaskList(listQuery)
  // 一次读取历史轮次，避免逐条请求详情；其他视图不额外查询完成历史。
  const history = useTaskList({ scope: 'completed' }, { enabled: view === 'focus' })
  const { today } = list
  const refreshList = list.refetch
  const refreshHistory = history.refetch
  const historyReady = history.today === today
  const dayReady = today !== null && focus.dayKey === today
  const focusKeys = useMemo(() => new Set(dayReady ? focus.items.map(itemKey) : []), [dayReady, focus.items])
  const currentKeys = useMemo(() => new Set(list.items.map(itemKey)), [list.items])
  const myDayItems = useMemo(() => [...list.items, ...(historyReady ? history.items.filter((item) => !currentKeys.has(itemKey(item))) : [])]
    .filter((item) => focusKeys.has(itemKey(item)) && item.status !== 'abandoned'), [list.items, history.items, historyReady, currentKeys, focusKeys])

  useEffect(() => {
    if (today !== null && focus.dayKey !== null && focus.dayKey !== today) {
      refreshList()
      void focus.refetch()
    }
  }, [today, focus.dayKey, focus.refetch, refreshList])
  useEffect(() => {
    if (view === 'focus' && today !== null && history.today !== null && !historyReady) {
      refreshHistory()
      refreshList()
    }
  }, [view, today, history.today, historyReady, refreshHistory, refreshList])

  const visible = useMemo(() => {
    if (today === null || projectUnselected) return []
    if (view === 'completed') return list.items.filter((item) => matchesCompletionPeriod(item, completionPeriod, today))
    if (view === 'focus') return sortItems(myDayItems, today, sortMode)
    const source = list.items.map((item) => upcomingTaskItem(item, today))
    const filtered = queryItems(source, {
      status: view === 'all' || view === 'project' ? statusFilter : 'active',
      ...(view === 'project' && currentProject !== undefined ? {
        scope: { kind: 'project' as const, projectId: currentProject.projectId },
        projectInterval: { startsOn: currentProject.startsOn, endsOn: currentProject.endsOn },
      } : {}),
    })
    return sortItems(filtered.filter((item) => view === 'planned' ? matchesPlanPeriod(item, planPeriod, today) : true), today, sortMode)
  }, [today, projectUnselected, view, list.items, completionPeriod, myDayItems, sortMode, statusFilter, currentProject, planPeriod])

  const canCreate = view !== 'completed' && !projectUnselected && !(view === 'planned' && planPeriod === 'overdue')
  const expandedItem = visible.find((item) => itemKey(item) === expanded) ?? null
  const pendingItems = visible.filter((item) => item.completedAt === null && item.status !== 'abandoned')
  const inRange = pendingItems.filter((item) => !item.reasons.includes('outside_project_range'))
  const outsideRange = pendingItems.filter((item) => item.reasons.includes('outside_project_range'))
  const doneItems = visible.filter((item) => item.completedAt !== null && item.status !== 'abandoned')
  const abandonedItems = visible.filter((item) => item.status === 'abandoned')
  const selectedItems = visible.filter((item) => selection.includes(item.taskId))
  const recurringSelected = selectedItems.filter((item) => item.recurring)
  const progressTotal = myDayItems.length
  const progressCompleted = myDayItems.filter((item) => item.completedAt !== null).length
  const isReading = list.isLoading || today === null || (view === 'focus' && (focus.isLoading || history.isLoading || !dayReady || !historyReady))
  const readError = list.isError ? list.error : view === 'focus' && focus.isError ? focus.error : view === 'focus' && history.isError ? history.error : null
  const quickContext = view === 'focus' ? { kind: 'my-day' as const }

    : view === 'project' ? { kind: 'project' as const, projectId: effectiveProject ?? undefined, label: currentProject?.name }
    : view === 'planned' ? { kind: 'planned' as const, planPeriod, ...(today === null ? {} : planCreationDefaults(planPeriod, today)), label: PLAN_PERIODS.find((option) => option.value === planPeriod)?.label }
    : { kind: 'all' as const }

  function changeView(next: View, projectId?: string): void {
    setView(next)
    setSelectionMode(false)
    if (projectId !== undefined) setSelectedProject(projectId)
    setStatusFilter(next === 'project' ? 'active' : 'all')
    setSelection([])
    setExpanded(null)
    setBanner(null)
    setPanelMode('overview')
  }
  function toggleSelect(taskId: string): void {
    setSelection((previous) => previous.includes(taskId) ? previous.filter((id) => id !== taskId) : [...previous, taskId])
  }
  function toggleFocus(item: TodoItem): void {
    const removing = focusKeys.has(itemKey(item))
    const mutation = removing ? focusActions.remove : focusActions.add
    mutation.mutate({ taskId: item.taskId, occurrenceKey: item.occurrenceKey }, {
      onSuccess: () => setBanner({ tone: 'info', text: removing ? '已移出我的一天，任务仍保留在原处。' : '已加入我的一天。' }),
      onError: (cause) => setBanner({ tone: 'error', text: errorMessage(cause) }),
    })
  }
  function renderRows(items: readonly TodoItem[]) {
    return <ul className="ta-tasks__list">{items.map((item) => <TaskRow
      key={itemKey(item)} item={item} today={today!} projects={projectsApi.projects} actions={actions}
      selectionMode={selectionMode} selected={selection.includes(item.taskId)} onToggleSelect={toggleSelect}
      expanded={expanded === itemKey(item)} onToggleExpand={() => { setExpanded(expanded === itemKey(item) ? null : itemKey(item)); setPanelMode('overview') }}
      onDeleted={(input) => setUndoState({ batchId: input.batchId, title: input.title })}
      focused={focusKeys.has(itemKey(item))} onToggleFocus={() => toggleFocus(item)}
      focusBusy={focusActions.add.isPending || focusActions.remove.isPending || !dayReady}
    />)}</ul>
  }
  function renderHistoryRows(items: readonly TodoItem[]) {
    return <ul className="ta-tasks__list">{items.map((item) => <li className="ta-tasks__row ta-tasks__historyEntry" key={itemKey(item)} data-task-id={item.taskId} data-occurrence-key={item.occurrenceKey}>
      <span className="ta-tasks__historicalMark" aria-hidden="true">✓</span>
      <div className="ta-tasks__rowBody"><strong>{item.title}</strong><p className="ta-tasks__meta">
        <span>完成于 {item.completedDayKey}</span>{item.recurring ? <span>原计划 {item.occurrenceKey}</span> : null}
        {item.status === 'abandoned' ? <span>任务已放弃 · 此次完成仍保留</span> : null}
      </p><TimerControls taskId={item.taskId} occurrenceKey={item.occurrenceKey} completed compact/></div>
      <button type="button" className="ta-btn ta-btn--ghost ta-btn--sm" onClick={() => { setExpanded(itemKey(item)); setPanelMode('overview') }}>详情</button>
      <button type="button" className="ta-btn ta-btn--ghost ta-btn--sm" disabled={actions.uncomplete.isPending}
        onClick={() => actions.uncomplete.mutate({ taskId: item.taskId, occurrenceKey: item.occurrenceKey }, { onError: (cause) => setBanner({ tone: 'error', text: errorMessage(cause) }) })}>取消这次完成</button>
    </li>)}</ul>
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
          text: `《${item.title}》是重复任务，请取消选中后再批量顺延。`,
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
        setBanner({ tone: 'info', text: `已顺延 ${payload.tasks.length} 条。` })
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
    <div className="ta-tasks__workspace ta-tasks__workspace--detail">
      {projectMenu === null ? null : <ProjectMenu key={projectMenu.project.projectId} target={projectMenu} actions={projectActions} onClose={closeProjectMenu} onArchived={(id) => { if (selectedProject === id) { setView('all'); setSelectedProject(null); setExpanded(null) } }}/> }
      <aside className="ta-tasks__sidebar" aria-label="待办导航">
        <div className="ta-tasks__sidebarTop"><span className="ta-tasks__sidebarMark" aria-hidden="true">✓</span><div><strong>计划待办</strong></div></div>
        <p className="ta-tasks__navLabel">智能视图</p>
        <nav className="ta-tasks__sideNav" aria-label="智能视图">{SMART_VIEWS.map((option) => <button key={option.value} type="button"
          className={cx('ta-tasks__sideItem', view === option.value && 'ta-tasks__sideItem--on')}
          aria-current={view === option.value ? 'page' : undefined} onClick={() => changeView(option.value)}>
          <span className="ta-tasks__sideGlyph" aria-hidden="true">{option.glyph}</span><span>{option.label}</span>
        </button>)}</nav>
        <p className="ta-tasks__navLabel">我的项目</p>
        <nav className="ta-tasks__projectNav" aria-label="我的项目">
          <ProjectSortableList projects={projectsApi.active} selectedId={view === 'project' ? effectiveProject : null}
            onSelect={(id) => changeView('project', id)} onReorder={projectActions.reorder.mutateAsync} onProjectMenu={(project, anchor) => setProjectMenu({ project, anchor })}/>
          {projectsApi.isError ? <p className="ta-field__hint" role="alert">项目读取失败，请刷新重试。</p> : null}
          <button type="button" className="ta-tasks__sideItem ta-tasks__sideItem--subtle" onClick={() => { setExpanded(null); setPanelMode('projects') }}><span aria-hidden="true">＋</span><span>管理项目</span></button>
        </nav>
        <p className="ta-tasks__navLabel">记录</p>
        <button type="button" className={cx('ta-tasks__sideItem', view === 'completed' && 'ta-tasks__sideItem--on')} aria-current={view === 'completed' ? 'page' : undefined} onClick={() => changeView('completed')}><span className="ta-tasks__sideGlyph" aria-hidden="true">✓</span><span>已完成</span></button>
        <div className="ta-tasks__sidebarBottom">
          <button type="button" className="ta-tasks__sideItem ta-tasks__sideItem--subtle" onClick={() => { setExpanded(null); setPanelMode('note') }}>每日备注</button>
          <button type="button" className="ta-tasks__sideItem ta-tasks__sideItem--subtle" onClick={() => { setExpanded(null); setPanelMode('settings') }}>日界设置</button>
        </div>
      </aside>
      <div className="ta-tasks__center">
        <label className="ta-tasks__viewPicker">查看
          <select className="ta-input" aria-label="切换任务视图" value={view === 'project' ? `project:${effectiveProject}` : view}
            onChange={(event) => event.target.value.startsWith('project:') ? changeView('project', event.target.value.slice(8)) : changeView(event.target.value as View)}>
            <optgroup label="智能视图">{SMART_VIEWS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
            <optgroup label="我的项目">{projectsApi.active.map((project) => <option key={project.projectId} value={`project:${project.projectId}`}>{project.name}</option>)}</optgroup>
            <optgroup label="记录"><option value="completed">已完成</option></optgroup>
          </select>
        </label>
        <section className="ta-tasks__head" aria-labelledby="tasks-heading">
          <h1 className="ta-tasks__heading" id="tasks-heading">{view === 'project' ? currentProject?.name ?? '选择项目' : VIEW_TITLES[view]}</h1>
          <div className="ta-tasks__todayLine"><time data-testid="server-today">{today ?? '正在读取日期…'}</time>
            <button type="button" className="ta-btn ta-btn--ghost ta-btn--sm" onClick={() => { list.refetch(); if (view === 'focus') { history.refetch(); void focus.refetch() } }}>刷新</button>
            {canCreate ? <button type="button" className="ta-btn ta-btn--primary ta-btn--sm ta-tasks__newButton" onClick={() => { setExpanded(null); setPanelMode('create') }}>＋ 新建任务</button> : null}
            {view === 'focus' && dayReady && progressTotal > 0 ? <span className="ta-tasks__compactProgress" aria-label="我的一天进度">已完成 {progressCompleted} / {progressTotal}<progress max={progressTotal} value={progressCompleted}/></span> : null}
          </div>
        </section>
        <div className="ta-tasks__mobileTools" aria-label="任务工具">
          <button type="button" onClick={() => { setExpanded(null); setPanelMode('projects') }}>管理项目</button>
          <button type="button" onClick={() => { setExpanded(null); setPanelMode('note') }}>今日备注</button>
          <button type="button" onClick={() => { setExpanded(null); setPanelMode('settings') }}>日界设置</button>
        </div>
        {view === 'planned' ? <section className="ta-tasks__planFilter" aria-label="计划时间范围">
          <div className="ta-tasks__periods" role="group" aria-label="计划时间筛选">{PLAN_PERIODS.map((option) => <button key={option.value} type="button" aria-pressed={planPeriod === option.value}
            onClick={() => { setPlanPeriod(option.value); setSelection([]); setExpanded(null) }}>{option.label}</button>)}</div>
          {planPeriod === 'week' && today !== null ? <p className="ta-field__hint">{weekStart(today)} — {weekEnd(today)}</p> : null}
        </section> : null}
        <section className="ta-card ta-tasks__board" aria-labelledby="task-list-heading">
          <div className="ta-tasks__boardHead"><h2 className="ta-tasks__sectionHeading" id="task-list-heading">{view === 'focus' ? '今日任务' : view === 'completed' ? '完成记录' : '任务'}</h2><span className="ta-mono ta-tasks__boardCount">{visible.length} {view === 'completed' ? '次完成' : '项'}</span></div>
          <div className="ta-tasks__toolbar">
            {view !== 'completed' && visible.length > 0 ? <button type="button" className="ta-btn ta-btn--ghost ta-btn--sm" aria-pressed={selectionMode} onClick={() => { setSelectionMode(!selectionMode); setSelection([]) }}>{selectionMode ? '退出批量选择' : '批量选择'}</button> : null}
            {view === 'completed' ? <label className="ta-tasks__control"><span className="ta-field__label">完成时间</span><select className="ta-input" aria-label="完成时间筛选" value={completionPeriod} onChange={(event) => { setCompletionPeriod(event.target.value as CompletionPeriod); setExpanded(null) }}><option value="all">全部时间</option><option value="today">今天</option><option value="week">本周</option></select></label>
              : <label className="ta-tasks__control"><span className="ta-field__label">排序</span><select className="ta-input ta-tasks__select" aria-label="排序" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>{(Object.keys(SORT_TEXT) as SortMode[]).map((mode) => <option value={mode} key={mode}>{SORT_TEXT[mode]}</option>)}</select></label>}
            {view === 'all' || view === 'project' ? <label className="ta-tasks__control"><span className="ta-field__label">显示</span><select className="ta-input ta-tasks__select" aria-label="状态筛选" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as StatusFilter); setSelection([]); setExpanded(null) }}><option value="all">所有状态</option><option value="active">未完成</option><option value="completed">已完成</option><option value="abandoned">已放弃</option></select></label> : null}
          </div>
          {projectUnselected ? <p className="ta-tasks__empty">请选择或新建项目。</p> : null}
          {selection.length > 0 ? <div className="ta-tasks__batch" role="group" aria-label="批量顺延"><span>已选中 {selection.length} 条</span><label className="ta-tasks__control"><span className="ta-field__label">顺延到</span><input type="date" className="ta-input" aria-label="顺延到" value={batchDate} onChange={(event) => setBatchDate(event.target.value)}/></label><button type="button" className="ta-btn ta-btn--secondary ta-btn--sm" disabled={batchDate === '' || actions.reschedule.isPending} onClick={runBatchReschedule}>顺延</button><button type="button" className="ta-btn ta-btn--ghost ta-btn--sm" onClick={() => { setSelection([]); setSelectionMode(false) }}>取消选择</button>{recurringSelected.length > 0 ? <span className="ta-field__hint">重复任务按规则安排，不能批量顺延。</span> : null}</div> : null}
          {banner === null ? null : <p className={banner.tone === 'error' ? 'ta-banner ta-banner--error' : 'ta-banner ta-banner--info'} role={banner.tone === 'error' ? 'alert' : 'status'} data-testid="board-banner">{banner.tone === 'error' ? <IconAlert size={18}/> : <IconInfo size={18}/>}<span>{banner.text}</span></p>}
          {undoState === null ? null : <p className="ta-banner ta-banner--info ta-tasks__undo" role="status"><span>已删除《{undoState.title}》。</span><button type="button" className="ta-btn ta-btn--secondary ta-btn--sm" onClick={runUndo} disabled={actions.undo.isPending} data-testid="undo-delete">撤销（30 秒内）</button></p>}
          {readError !== null ? <div className="ta-tasks__errorBox"><p className="ta-banner ta-banner--error" role="alert">{errorMessage(readError)}</p><button type="button" className="ta-btn ta-btn--secondary" onClick={() => { list.refetch(); history.refetch(); void focus.refetch() }}>重试</button></div>
            : isReading ? <p className="ta-tasks__hint">正在读取任务…</p>
              : projectUnselected ? null : visible.length === 0 ? <p className="ta-tasks__empty">{view === 'focus' ? '暂无任务。' : view === 'completed' ? '暂无完成记录。' : '暂无任务。'}</p>
                : view === 'completed' ? renderHistoryRows(visible) : <>
                  {inRange.length > 0 ? renderRows(inRange) : null}
                  {outsideRange.length > 0 ? <div className="ta-tasks__group"><h3 className="ta-tasks__groupHeading">项目周期之外 <span>{outsideRange.length}</span></h3>{renderRows(outsideRange)}</div> : null}
                  {doneItems.length > 0 ? <details className="ta-tasks__completedGroup" open={view === 'focus' || statusFilter === 'completed'}><summary>已完成 · {doneItems.length}</summary>{renderRows(doneItems)}</details> : null}
                  {abandonedItems.length > 0 ? <details className="ta-tasks__completedGroup" open={statusFilter === 'abandoned'}><summary>已放弃 · {abandonedItems.length}</summary>{renderRows(abandonedItems)}</details> : null}
                </>}
        </section>
      </div>
      <aside className={cx('ta-tasks__right', (expandedItem !== null || panelMode !== 'overview') && 'ta-tasks__right--detail')} aria-label="任务详情与辅助信息">
        <div className="ta-tasks__rightHead"><span>{expandedItem === null ? ({ overview: canCreate ? '新建任务' : '任务详情', create: '新建任务', projects: '管理项目', note: '今日备注', settings: '日界设置' } as const)[panelMode] : '编辑任务'}</span>{expandedItem !== null || panelMode !== 'overview' ? <button type="button" aria-label="关闭侧栏" onClick={() => { setExpanded(null); setPanelMode('overview') }}>×</button> : null}</div>
        {expandedItem !== null && today !== null ? <>
          <div className="ta-tasks__selectedHeading"><p className="ta-mono">{view === 'completed' ? '完成记录' : isUpcomingPreview(expandedItem, today) ? '下一轮预览' : expandedItem.recurring ? '重复任务' : expandedItem.completedDayKey === null ? '待完成' : '已完成'}</p><h2>{expandedItem.title}</h2><span>{expandedItem.projectId === null ? '未归属项目' : projectsApi.projects.find((project) => project.projectId === expandedItem.projectId)?.name ?? '已删除的项目'}</span>
          </div>
          <TaskDetailForm key={itemKey(expandedItem)} item={expandedItem} today={today} projects={projectsApi.projects} actions={actions} onNotice={handleNotice}/>
        </> : panelMode === 'projects' ? <ProjectPanel projectsApi={projectsApi} projectActions={projectActions} onProjectMenu={(project, anchor) => setProjectMenu({ project, anchor })}/>
          : panelMode === 'note' ? <DayNoteCard dayKey={today}/>
            : panelMode === 'settings' ? <SettingsCard/>
                : canCreate ? <TaskComposer context={quickContext}/> : <p className="ta-tasks__panelEmpty">选择任务查看详情</p>}
      </aside>
    </div>
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
        <span className="ta-mono">{dayKey}</span> · 清空后保存可删除备注。
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
            自 {formatDayKey(settings.affectsFrom)}（{settings.affectsFrom}）起生效，历史记录不变。时区：{settings.timeZone}。
          </p>
          {feedback === null ? null : <p className="ta-field__hint">{feedback}</p>}
        </>
      )}
    </section>
  )
}
