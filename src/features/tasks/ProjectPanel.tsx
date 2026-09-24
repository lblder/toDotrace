import { useState } from 'react'
import { uuidv7 } from '@shared/uuid'
import { compareDayKey, formatDayKey, weekEnd, weekStart } from '@shared/time'
import type { DayKey } from '@shared/time'
import type { ProjectRow } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import type { useProjectActions, useProjects } from '../../hooks/use-projects'
import { IconAlert, IconInfo } from '../common/Icons'

const STATE_TEXT: Readonly<Record<'upcoming' | 'active' | 'ended', string>> = {
  upcoming: '还没开始',
  active: '进行中',
  ended: '已结束',
}

export function ProjectPanel({
  projectsApi,
  projectActions,
  onProjectMenu,
}: {
  projectsApi: ReturnType<typeof useProjects>
  projectActions: ReturnType<typeof useProjectActions>
  onProjectMenu: (project: ProjectRow, anchor: { x: number; y: number }) => void
}) {
  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  const active = projectsApi.active

  function create(): void {
    setFeedback(null)
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setFeedback({ tone: 'error', text: '项目名不能为空。' })
      return
    }
    if (startsOn === '' || endsOn === '') {
      setFeedback({ tone: 'error', text: '请选择项目起止日期。' })
      return
    }
    if (compareDayKey(startsOn, endsOn) > 0) {
      setFeedback({ tone: 'error', text: '开始日期不能晚于结束日期。' })
      return
    }
    projectActions.create.mutate(
      // `projectId` 由客户端生成，与任务同一条纪律（ADR-017 §5）
      { projectId: uuidv7(), name: trimmed, startsOn, endsOn },
      {
        onSuccess: () => {
          setName('')
          setStartsOn('')
          setEndsOn('')
          setFeedback({ tone: 'info', text: `已创建项目「${trimmed}」。` })
        },
        onError: (cause) => setFeedback({ tone: 'error', text: errorMessage(cause) }),
      },
    )
  }

  function renderProject(project: ProjectRow) {
    return <li className="ta-tasks__project" key={project.projectId}
      onContextMenu={(event) => { event.preventDefault(); onProjectMenu(project, { x: event.clientX, y: event.clientY }) }}>
      <span className="ta-tasks__projectName">{project.name}</span>
      <span className="ta-tasks__metaItem ta-mono">{formatDayKey(project.startsOn)} – {formatDayKey(project.endsOn)}</span>
      <span className="ta-tasks__metaItem">{project.archived ? '已归档' : STATE_TEXT[project.state]}</span>
      <button type="button" className="ta-projectMore" aria-label={`项目「${project.name}」的操作`} aria-haspopup="menu"
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onProjectMenu(project, { x: rect.right, y: rect.bottom }) }}>⋯</button>
    </li>
  }

  return (
    <section className="ta-card ta-tasks__projects" aria-labelledby="projects-heading">
      <h2 className="ta-tasks__sectionHeading" id="projects-heading">
        项目
      </h2>

      {projectsApi.isLoading ? (
        <p className="ta-tasks__hint">正在读取项目…</p>
      ) : projectsApi.isError ? (
        <p className="ta-banner ta-banner--error" role="alert">
          <IconAlert size={18} />
          <span>{errorMessage(projectsApi.error)}</span>
        </p>
      ) : active.length === 0 ? (
        <p className="ta-tasks__hint">暂无项目。</p>
      ) : (
        <ul className="ta-tasks__projectList">{active.map(renderProject)}</ul>
      )}
      {projectsApi.projects.some((project) => project.archived) ? <details className="ta-tasks__archivedProjects">
        <summary>已归档项目</summary>
        <ul className="ta-tasks__projectList">{projectsApi.projects.filter((project) => project.archived).map(renderProject)}</ul>
      </details> : null}

      <div className="ta-tasks__grid">
        <label className="ta-field">
          <span className="ta-field__label">新项目名</span>
          <input
            className="ta-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="新项目名"
          />
        </label>
        <label className="ta-field">
          <span className="ta-field__label">开始</span>
          <input
            className="ta-input"
            type="date"
            value={startsOn}
            onChange={(event) => setStartsOn(event.target.value)}
            aria-label="项目开始日期"
          />
        </label>
        <label className="ta-field">
          <span className="ta-field__label">结束（含当天）</span>
          <input
            className="ta-input"
            type="date"
            value={endsOn}
            onChange={(event) => setEndsOn(event.target.value)}
            aria-label="项目结束日期"
          />
        </label>
      </div>
      {startsOn === '' || endsOn === '' ? null : (
        <p className="ta-field__hint">
          {weekText(startsOn, endsOn)}（含起止日）
        </p>
      )}
      <div className="ta-tasks__detailActions">
        <button
          type="button"
          className="ta-btn ta-btn--secondary ta-btn--sm"
          onClick={create}
          disabled={projectActions.create.isPending}
        >
          新建项目
        </button>
      </div>

      {feedback === null ? null : (
        <p
          className={cx(
            'ta-banner',
            feedback.tone === 'error' ? 'ta-banner--error' : 'ta-banner--info',
          )}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
          <span>{feedback.text}</span>
        </p>
      )}
    </section>
  )
}

/** 区间覆盖到哪些自然周（首尾通常不完整，这是「周是固定格」的必然结果，不是缺陷） */
function weekText(startsOn: DayKey, endsOn: DayKey): string {
  const first = weekStart(startsOn)
  const last = weekEnd(endsOn)
  return `${formatDayKey(first)} 那一周到 ${formatDayKey(last)} 那一周`
}
