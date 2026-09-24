import { useState } from 'react'
import type { DayKey } from '@shared/time'
import {
  bucketReasonOf,
  canChangeStatus,
  canCompleteOccurrence,
  canUncompleteOccurrence,
  isInstanceCompleted,
  urgencyBucket,
  type TodoItem,
} from '@shared/tasks'
import type { ProjectRow } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import type { TaskActions } from '../../hooks/use-tasks'
import { TimerControls } from '../timer/TimerControls'
import { IconAlert } from '../common/Icons'
import { BUCKET_LABEL, IMPORTANCE_TEXT, STATUS_TEXT } from './labels'
import { describeDate, describePlannedWeek } from './day-text'
import { isUpcomingPreview, matchesPlanPeriod } from '@shared/tasks/views'

export interface TaskRowProps {
  readonly item: TodoItem
  /** **服务端回带**的今日归属日（ADR-015 §6）——本组件不自己算一个 */
  readonly today: DayKey
  readonly projects: readonly ProjectRow[]
  readonly actions: TaskActions
  readonly selectionMode: boolean
  readonly selected: boolean
  readonly onToggleSelect: (taskId: string) => void
  readonly expanded: boolean
  readonly onToggleExpand: (taskId: string) => void
  readonly onDeleted: (input: { taskId: string; title: string; batchId: string }) => void
  readonly focused?: boolean
  readonly onToggleFocus?: () => void
  readonly focusBusy?: boolean
}

/**
 * 任务行（FR2.1 / FR2.6）。
 *
 * ## 三条「绝不自动推断」在这里的落法（ADR-013 §2 / 01 FR2.1 v1.3）
 *
 * - **「进行中」只能由显式动作触发**：它有一个自己的按钮（`/`），
 *   打开详情、设日期、建子任务**都不改变状态**。重复任务上它被禁用，
 *   理由来自 `canChangeStatus`——**判据不在这里重写一份**；
 * - **完成/取消完成不是任务级迁移**：复选框走 `canCompleteOccurrence` /
 *   `canUncompleteOccurrence`（ADR-017 §2 的 409 判据同一份）；
 * - **已放弃的任务不得呈现为已完成**（01 FR2.1 v1.4）：它的复选框**不勾**，
 *   完成记录改由下面那行「完成历史」如实陈述——**放弃不抹除历史**（ADR-013 §2）。
 */
export function TaskRow({
  item,
  today,
  projects,
  actions,
  selectionMode,
  selected,
  onToggleSelect,
  expanded,
  onToggleExpand,
  onDeleted,
  focused = false,
  onToggleFocus,
  focusBusy = false,
}: TaskRowProps) {
  const [error, setError] = useState<string | null>(null)

  const completed = isInstanceCompleted(item)
  const abandoned = item.status === 'abandoned'
  const upcoming = isUpcomingPreview(item, today)
  const bucket = urgencyBucket(item, today)
  const bucketReason = bucketReasonOf(bucket)
  // 排序档位合并了“无日期”和“以后”；显示时依据真实排期拆开，周计划也不冒充具体日。
  let bucketLabel = BUCKET_LABEL[bucketReason]
  if (!completed && !abandoned) {
    if (bucket === 4 && matchesPlanPeriod(item, 'scheduled', today)) bucketLabel = '以后'
    if (bucket === 0 && !(item.dueDate !== null && item.dueDate < today)) {
      bucketLabel = item.recurring ? '待补做' : '待调整'
    }
    if (!item.recurring && item.plannedWeek !== null && item.plannedDate === null && item.dueDate === null) {
      bucketLabel = matchesPlanPeriod(item, 'overdue', today) ? '待调整'
        : matchesPlanPeriod(item, 'week', today) ? '本周' : '以后'
    }
  }

  /** 该行展示的是哪一轮实例 —— 勾选与完成都按它走（ADR-013 §4.12） */
  const occurrenceKey = item.occurrenceKey

  const projectName = resolveProjectName(item.projectId, projects)

  function run(action: () => void): void {
    setError(null)
    action()
  }

  const stepsDone = item.steps.filter((step) => step.checkedAt !== null).length

  function toggleComplete(): void {
    const verdict = completed
      ? canUncompleteOccurrence({ instanceCompleted: true })
      : canCompleteOccurrence({ task: { status: item.status, deletedAt: null }, instanceCompleted: false })
    if (!verdict.allowed) {
      setError(verdict.message)
      return
    }
    const mutation = completed ? actions.uncomplete : actions.complete
    run(() => {
      mutation.mutate(
        { taskId: item.taskId, occurrenceKey },
        { onError: (cause) => setError(errorMessage(cause)) },
      )
    })
  }

  function toggleInProgress(): void {
    const to = item.status === 'in_progress' ? 'not_started' : 'in_progress'
    const verdict = canChangeStatus({ from: item.status, to, recurring: item.recurring })
    if (!verdict.allowed) {
      setError(verdict.message)
      return
    }
    run(() => {
      actions.setStatus.mutate(
        { taskId: item.taskId, to },
        { onError: (cause) => setError(errorMessage(cause)) },
      )
    })
  }

  const inProgressVerdict = canChangeStatus({
    from: item.status,
    to: item.status === 'in_progress' ? 'not_started' : 'in_progress',
    recurring: item.recurring,
  })


  function deleteTask(): void {
    run(() => {
      actions.remove.mutate(item.taskId, {
        onSuccess: (payload) => {
          onDeleted({ taskId: item.taskId, title: item.title, batchId: payload.batchId })
        },
        onError: (cause) => setError(errorMessage(cause)),
      })
    })
  }

  return (
    <li
      className={cx('ta-tasks__row', completed && 'ta-tasks__row--done', abandoned && 'ta-tasks__row--abandoned', expanded && 'ta-tasks__row--selected')}
      data-task-id={item.taskId}
      data-occurrence-key={occurrenceKey}
    >
      <div className="ta-tasks__rowMain">
        {selectionMode ? <input
          type="checkbox"
          className="ta-tasks__bulkCheck"
          checked={selected}
          onChange={() => onToggleSelect(item.taskId)}
          aria-label={`选中《${item.title}》用于批量顺延`}
        /> : <input
          type="checkbox"
          className="ta-tasks__check"
          checked={completed && !abandoned}
          onChange={toggleComplete}
          disabled={upcoming || abandoned || actions.complete.isPending || actions.uncomplete.isPending}
          title={upcoming ? '这是下一轮预览，到期后可以完成' : undefined}
          aria-label={completed ? `取消完成《${item.title}》` : `完成《${item.title}》`}
          data-testid={`complete-${item.taskId}`}
        />}

        <div className="ta-tasks__rowBody">
          <p className="ta-tasks__title">
            <button type="button" onClick={() => onToggleExpand(item.taskId)} aria-label={`查看《${item.title}》详情`} className={cx('ta-tasks__titleText', 'ta-tasks__titleButton', completed && !abandoned && 'ta-tasks__titleText--done')}>
              {item.title}
            </button>
            {item.recurring ? (
              <span className="ta-badge" title="按设置的规则重复">
                重复
              </span>
            ) : null}
          </p>

          <p className="ta-tasks__meta">
            {item.recurring ? <span className="ta-tasks__metaItem">{upcoming ? '下一轮' : '本轮'} {describeDate(item.occurrenceKey, today)}{upcoming ? ' · 到期后可执行' : ''}</span> : null}
            {/* 排序理由：FR2.6 要求「规则透明、界面上可见排序理由」 */}
            <span
              className={cx('ta-tasks__bucket', `ta-tasks__bucket--${bucket}`)}
              data-testid={`bucket-${item.taskId}`}
            >
              {bucketLabel}
            </span>

            {item.plannedDate === null ? null : (
              <span className="ta-tasks__metaItem">计划日 {describeDate(item.plannedDate, today)}</span>
            )}
            {item.plannedWeek === null ? null : (
              // 粒度：周级锚点显示成「计划周 9月28日那一周」，绝不折算成某一天（ADR-014 §4.3）
              <span className="ta-tasks__metaItem">计划周 {describePlannedWeek(item.plannedWeek)}</span>
            )}
            {item.dueDate === null ? null : (
              <span
                className={cx('ta-tasks__metaItem', !completed && !abandoned && item.dueDate < today && 'ta-tasks__metaItem--overdue')}
                data-testid={`due-${item.taskId}`}
              >
                期限 {describeDate(item.dueDate, today)}
                {!completed && !abandoned && item.dueDate < today ? ' · 已逾期' : ''}
              </span>
            )}
            {item.projectId === null ? null : (
              <span className="ta-tasks__metaItem">项目 {projectName}</span>
            )}
            {item.tags.map((tag) => (
              <span className="ta-tasks__tag" key={tag}>
                #{tag}
              </span>
            ))}
            {item.importance !== 'low' ? null : (
              <span className="ta-tasks__metaItem">
                重要性 {IMPORTANCE_TEXT[item.importance]}
              </span>
            )}
          </p>

          {/*
            已放弃但仍留有完成记录的<strong>事实陈述</strong>（01 FR2.1 v1.4 / ADR-013 §2）：
            「历史区里留着『X 日完成过一轮』——这是事实陈述，不是矛盾」。
            它必须与「呈现为已完成」区分开：上面那个复选框<strong>不勾</strong>、标题<strong>不划掉</strong>。
          */}
          {abandoned && item.completedDayKey !== null ? (
            <p className="ta-tasks__history" data-testid={`history-${item.taskId}`}>
              完成历史：本实例在 {item.completedDayKey} 完成过（放弃不抹除历史）。
              <button
                type="button"
                className="ta-btn ta-btn--ghost ta-btn--sm"
                onClick={() =>
                  run(() => {
                    actions.uncomplete.mutate(
                      { taskId: item.taskId, occurrenceKey },
                      { onError: (cause) => setError(errorMessage(cause)) },
                    )
                  })
                }
                disabled={actions.uncomplete.isPending}
              >
                取消这条完成记录
              </button>
            </p>
          ) : null}

          {item.steps.length > 0 ? (
            <div className="ta-tasks__steps">
              <p className="ta-tasks__stepsProgress" data-testid={`steps-progress-${item.taskId}`}>
                步骤 {stepsDone}/{item.steps.length}
              </p>
            </div>
          ) : null}

          <TimerControls taskId={item.taskId} occurrenceKey={item.occurrenceKey} canStart={!abandoned && (!item.recurring || item.pending)} completed={completed} compact/>

          {error === null ? null : (
            <p className="ta-banner ta-banner--error ta-tasks__rowError" role="alert">
              <IconAlert size={16} />
              <span>{error}</span>
            </p>
          )}
        </div>

        <div className="ta-tasks__rowActions">
          <button
            type="button"
            className={cx('ta-tasks__star', 'ta-tasks__starButton', item.importance === 'high' && 'ta-tasks__starButton--on')}
            aria-label={item.importance === 'high' ? `取消《${item.title}》的重要标记` : `将《${item.title}》标为重要`}
            aria-pressed={item.importance === 'high'}
            title={item.importance === 'high' ? '取消重要标记' : '标为重要'}
            disabled={actions.update.isPending}
            onClick={() => run(() => actions.update.mutate({ taskId: item.taskId, input: { importance: item.importance === 'high' ? 'normal' : 'high' } }, { onError: (cause) => setError(errorMessage(cause)) }))}
          >{item.importance === 'high' ? '★' : '☆'}</button>
          {onToggleFocus === undefined ? null : (
            <button
              type="button"
              className={cx('ta-tasks__focusButton', focused && 'ta-tasks__focusButton--on')}
              onClick={onToggleFocus}
              disabled={focusBusy || (!focused && (abandoned || completed || upcoming))}
              aria-pressed={focused}
              aria-label={focused ? `从我的一天移除《${item.title}》` : `将《${item.title}》加入我的一天`}
              title={focused ? '移出我的一天，保留任务' : upcoming ? '到期后可加入我的一天' : '加入我的一天'}
            >
              {focused ? '◉' : '◎'}
            </button>
          )}
          {abandoned ? (
            <span className="ta-badge ta-tasks__statusBadge">{STATUS_TEXT.abandoned}</span>
          ) : item.recurring || completed ? null : (
            <button
              type="button"
              className={cx(
                'ta-btn ta-btn--ghost ta-btn--sm',
                item.status === 'in_progress' && 'ta-btn--primary',
              )}
              onClick={toggleInProgress}
              disabled={!inProgressVerdict.allowed || actions.setStatus.isPending}
              aria-pressed={item.status === 'in_progress'}
              title={inProgressVerdict.allowed ? undefined : inProgressVerdict.message}
              data-testid={`in-progress-${item.taskId}`}
            >
              {item.status === 'in_progress' ? '进行中' : '标记进行中'}
            </button>
          )}

          <button
            type="button"
            className="ta-btn ta-btn--ghost ta-btn--sm"
            onClick={() => onToggleExpand(item.taskId)}
            aria-expanded={expanded}
          >
            {expanded ? '收起' : '详情'}
          </button>

          <button
            type="button"
            className="ta-btn ta-btn--ghost ta-btn--sm ta-tasks__danger"
            onClick={deleteTask}
            disabled={actions.remove.isPending}
            aria-label={`删除《${item.title}》`}
          >
            删除
          </button>
        </div>
      </div>

    </li>
  )
}

/**
 * 项目名的解析。
 *
 * ⚠️ **不得假设 `projectId` 一定能解析到项目**（ADR-016 §6 的读取侧）：
 * 项目是软删除，而删除项目时其下任务的 `projectId` **一个都不清**；
 * 而 `GET /api/projects` 只返回未删除的项目——于是「任务还挂着、项目却不在列表里」
 * 是**常态**。故解析不到时显示「已删除的项目」，而不是空白或编一个名字。
 *
 * 代价如实记：一条任务若当初归到一个**被删掉**的项目，界面上只能看到「已删除的项目」，
 * 看不到它当初叫什么——因为那个名字已经不在可读列表里了。
 */
function resolveProjectName(projectId: string | null, projects: readonly ProjectRow[]): string {
  if (projectId === null) return '（无）'
  const found = projects.find((project) => project.projectId === projectId)
  return found === undefined ? '已删除的项目' : found.name
}
