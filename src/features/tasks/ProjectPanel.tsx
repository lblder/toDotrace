import { useState } from 'react'
import { uuidv7 } from '@shared/uuid'
import { compareDayKey, formatDayKey, weekEnd, weekStart } from '@shared/time'
import type { DayKey } from '@shared/time'
import { errorMessage } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import type { useProjectActions, useProjects } from '../../hooks/use-projects'
import { IconAlert, IconInfo } from '../common/Icons'

const STATE_TEXT: Readonly<Record<'upcoming' | 'active' | 'ended', string>> = {
  upcoming: '还没开始',
  active: '进行中',
  ended: '已结束',
}

/**
 * 项目面板（ADR-016 / FR2.8）：列表、新建、改期、切换当前项目、取消当前项目。
 *
 * 三条口径在这里必须可见：
 *
 * 1. **「当前项目」绝不参与归属推导**（ADR-016 §4 的禁令）：切换它**不会**改任何任务的
 *    `projectId`。界面因此把它画成一个纯粹的「指针」，并在下面那句话里说明；
 * 2. **「至多一个」而不是「恰好一个」**：一个项目都没有时、或当前项目被删除时，
 *    当前项目必然是 `null`。故「取消当前项目」是一个**必需的**显式动作
 *    （ADR-017 §1.3）——只能被事件推入、不能主动进入的状态没法诚实呈现；
 * 3. **同名项目合法**（ADR-016 §6）：界面按 id 索引，不使用名字做键。
 */
export function ProjectPanel({
  projectsApi,
  projectActions,
}: {
  projectsApi: ReturnType<typeof useProjects>
  projectActions: ReturnType<typeof useProjectActions>
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
      setFeedback({ tone: 'error', text: '项目的起止日期是必需的——FR2.8 的项目一定有周期。' })
      return
    }
    if (compareDayKey(startsOn, endsOn) > 0) {
      setFeedback({ tone: 'error', text: '开始日期不能晚于结束日期（服务端也会以 400 拒绝）。' })
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

  return (
    <section className="ta-card ta-tasks__projects" aria-labelledby="projects-heading">
      <h2 className="ta-tasks__sectionHeading" id="projects-heading">
        项目
      </h2>
      <p className="ta-field__hint">
        周期 = 自建项目：名称 + 起止日期，长短完全自定义（FR2.8）。多个项目可以<strong>重叠</strong>，
        同名也合法——名字不是标识。切换「当前项目」<strong>不会改任何任务的归属</strong>：
        归属只由任务自己的 `projectId` 决定。
      </p>

      {projectsApi.isLoading ? (
        <p className="ta-tasks__hint">正在读取项目…</p>
      ) : projectsApi.isError ? (
        <p className="ta-banner ta-banner--error" role="alert">
          <IconAlert size={18} />
          <span>{errorMessage(projectsApi.error)}</span>
        </p>
      ) : active.length === 0 ? (
        <p className="ta-tasks__hint">还没有项目。快速录入里的 `#名字` 在项目存在之前不会识别。</p>
      ) : (
        <ul className="ta-tasks__projectList">
          {active.map((project) => {
            /*
             * 状态直接用**服务端算好的** `state`（ADR-016 §4 的派生量）。
             * 本地再调一次 `projectState` 也得到同一个答案，但那就成了同一件事的
             * 两个来源——一个走服务端的 `today`、一个走本地的时钟，跨零点时会分叉。
             */
            const state = project.state
            return (
              <li className="ta-tasks__project" key={project.projectId}>
                <span className="ta-tasks__projectName">
                  {project.name}
                  {project.projectId === projectsApi.currentProjectId ? (
                    <span className="ta-badge ta-badge--primary">当前</span>
                  ) : null}
                </span>
                <span className="ta-tasks__metaItem ta-mono">
                  {formatDayKey(project.startsOn)} – {formatDayKey(project.endsOn)}
                </span>
                <span className="ta-tasks__metaItem">{STATE_TEXT[state]}</span>
                <span className="ta-tasks__projectActions">
                  {project.projectId === projectsApi.currentProjectId ? null : (
                    <button
                      type="button"
                      className="ta-btn ta-btn--ghost ta-btn--sm"
                      onClick={() =>
                        projectActions.activate.mutate(project.projectId, {
                          onError: (cause) =>
                            setFeedback({ tone: 'error', text: errorMessage(cause) }),
                        })
                      }
                      disabled={projectActions.activate.isPending}
                    >
                      设为当前
                    </button>
                  )}
                  <button
                    type="button"
                    className="ta-btn ta-btn--ghost ta-btn--sm ta-tasks__danger"
                    onClick={() =>
                      projectActions.remove.mutate(project.projectId, {
                        onSuccess: () =>
                          setFeedback({
                            tone: 'info',
                            text: `已删除项目「${project.name}」。它下面的任务一条都没删，projectId 也一个都没清——那是发生过的事实。`,
                          }),
                        onError: (cause) => setFeedback({ tone: 'error', text: errorMessage(cause) }),
                      })
                    }
                    disabled={projectActions.remove.isPending}
                    aria-label={`删除项目「${project.name}」`}
                  >
                    删除
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {projectsApi.currentProjectId === null ? null : (
        <div className="ta-tasks__detailActions">
          <button
            type="button"
            className="ta-btn ta-btn--ghost ta-btn--sm"
            onClick={() =>
              projectActions.clearCurrent.mutate(undefined, {
                onSuccess: () =>
                  setFeedback({ tone: 'info', text: '已取消当前项目（当前项目可以是「没有」）。' }),
                onError: (cause) => setFeedback({ tone: 'error', text: errorMessage(cause) }),
              })
            }
            disabled={projectActions.clearCurrent.isPending}
          >
            取消当前项目
          </button>
        </div>
      )}

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
          这一段包含 {weekText(startsOn, endsOn)}；区间是<strong>闭区间</strong>，起止两天都算在项目里。
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
