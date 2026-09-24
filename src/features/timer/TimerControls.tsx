import { useState } from 'react'
import { errorMessage } from '../../lib/api-client'
import { useTaskActions } from '../../hooks/use-tasks'
import {
  getTimerTaskConfig,
  timerElapsedSeconds,
  timerHasRecord,
  useTimer,
  useTimerActions,
  useTimerClock,
} from '../../hooks/use-timer'
import './timer.css'

export interface TimerControlsProps {
  readonly taskId: string
  readonly occurrenceKey: string
  readonly canStart?: boolean
  readonly completed?: boolean
  readonly compact?: boolean
}

export function formatTimerDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3_600)
  const minutes = Math.floor((safe % 3_600) / 60)
  const remainder = safe % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

/** 25 分钟是提醒节点，计时不会在节点处停止。 */
const REMINDER_SECONDS = 25 * 60

export function TimerControls({ taskId, occurrenceKey, canStart = true, completed = false, compact = false }: TimerControlsProps) {
  const timer = useTimer()
  const actions = useTimerActions()
  const [localError, setLocalError] = useState<string | null>(null)
  const active = timer.snapshot?.active ?? null
  const activeHere = active?.taskId === taskId && active.occurrenceKey === occurrenceKey
  const activeElsewhere = active !== null && !activeHere
  const now = useTimerClock(activeHere)
  const serverNow = now + timer.serverOffsetMs
  const seconds = timerElapsedSeconds(timer.snapshot, taskId, occurrenceKey, serverNow)
  const hasRecord = timerHasRecord(timer.snapshot, taskId, occurrenceKey)
  const enabled = getTimerTaskConfig(timer.snapshot, taskId).enabled
  const reminder = activeHere && seconds >= REMINDER_SECONDS
  const pending = actions.start.isPending || actions.pause.isPending

  if (compact && !enabled && !hasRecord) return null
  if (!compact && !enabled && !hasRecord) return null

  async function start(): Promise<void> {
    setLocalError(null)
    try {
      await actions.start.mutateAsync({ taskId, occurrenceKey })
    } catch (cause) { setLocalError(errorMessage(cause)) }
  }

  async function pause(): Promise<void> {
    if (active === null) return
    setLocalError(null)
    try {
      await actions.pause.mutateAsync({ sessionId: active.sessionId })
    } catch (cause) { setLocalError(errorMessage(cause)) }
  }

  return <section className={`ta-timer__controls${compact ? ' ta-timer__controls--compact' : ''}`}
    aria-label={`任务计时 ${occurrenceKey}`} data-testid="timer-controls">
    <div className="ta-timer__readout">
      {compact ? <span className="ta-timer__glyph" aria-hidden="true">◷</span> : <span className="ta-timer__caption">累计专注</span>}
      <strong className="ta-timer__digits" aria-live="off" data-testid="timer-elapsed">{formatTimerDuration(seconds)}</strong>
      {activeHere ? <span className="ta-timer__running">计时中</span> : null}
    </div>
    {activeHere ? <div className={`ta-timer__interval${compact ? ' ta-timer__interval--compact' : ''}`} role="progressbar" aria-label="当前番茄计时目标"
      aria-valuemin={0} aria-valuemax={REMINDER_SECONDS} aria-valuenow={Math.min(seconds, REMINDER_SECONDS)}
      aria-valuetext={reminder ? '已到25分钟，继续计时' : `已计时 ${formatTimerDuration(seconds)}`}>
      <span style={{ width: `${Math.min(100, seconds / REMINDER_SECONDS * 100)}%` }}/></div> : null}
    {reminder ? <p className={`ta-timer__reminder${compact ? ' ta-timer__reminder--compact' : ''}`} role="status">已到25分钟，继续计时</p> : null}
    {completed ? null : <div className="ta-timer__buttons">
      {activeHere
        ? <button type="button" className="ta-btn ta-btn--secondary ta-btn--sm" disabled={pending} onClick={() => void pause()}>暂停</button>
        : enabled ? <button type="button" className="ta-btn ta-btn--secondary ta-btn--sm"
          disabled={pending || !canStart || activeElsewhere || timer.isLoading || timer.isError}
          title={activeElsewhere ? '另一项任务正在计时，请先暂停它' : !canStart ? '当前轮次不能开始计时' : undefined}
          onClick={() => void start()}>{hasRecord ? '继续' : '开始任务'}</button> : null}
      {canStart && (!compact || activeHere) ? <TimerCompleteButton taskId={taskId} occurrenceKey={occurrenceKey} disabled={pending}/> : null}
    </div>}
    {activeElsewhere && !compact && !completed ? <p className="ta-timer__note">另一项任务正在计时。暂停后可开始这一项。</p> : null}
    {localError ? <p className="ta-timer__error" role="alert">{localError}</p> : null}
  </section>
}

function TimerCompleteButton({ taskId, occurrenceKey, disabled }: { taskId: string; occurrenceKey: string; disabled: boolean }) {
  const taskActions = useTaskActions()
  const timer = useTimer()
  const [localError, setLocalError] = useState<string | null>(null)
  async function complete(): Promise<void> {
    setLocalError(null)
    try {
      // 完成接口在同一事务内停止该实例的计时；失败时计时继续。
      await taskActions.complete.mutateAsync({ taskId, occurrenceKey })
      timer.refetch()
    } catch (cause) { setLocalError(errorMessage(cause)) }
  }
  return <>
    <button type="button" className="ta-btn ta-btn--primary ta-btn--sm" disabled={disabled || taskActions.complete.isPending}
      onClick={() => void complete()}>完成任务</button>
    {localError ? <p className="ta-timer__error" role="alert">{localError}</p> : null}
  </>
}

/** 任务级开关；一条任务的不同轮次分别累计真实计时片段。 */
export function TimerTaskSettings({ taskId, occurrenceKey, canStart = true, completed = false }: Omit<TimerControlsProps, 'compact'>) {
  const timer = useTimer()
  const actions = useTimerActions()
  const [localError, setLocalError] = useState<string | null>(null)
  const enabled = getTimerTaskConfig(timer.snapshot, taskId).enabled
  const activeOnTask = timer.snapshot?.active?.taskId === taskId
  const locked = activeOnTask && enabled

  async function configure(next: boolean): Promise<void> {
    setLocalError(null)
    try { await actions.configure.mutateAsync({ taskId, enabled: next }) }
    catch (cause) { setLocalError(errorMessage(cause)) }
  }

  return <section className="ta-timer__settings" aria-label="番茄计时设置">
    <label className="ta-timer__toggle"><input type="checkbox" checked={enabled}
      disabled={timer.isLoading || timer.isError || actions.configure.isPending || locked}
      onChange={(event) => void configure(event.target.checked)}/><span>番茄计时</span></label>
    {locked ? <p className="ta-timer__note">这项任务正在计时。暂停后可关闭开关。</p> : null}
    {timer.isError ? <p className="ta-timer__error" role="alert">计时数据读取失败。<button type="button" onClick={timer.refetch}>重试</button></p> : null}
    {localError ? <p className="ta-timer__error" role="alert">{localError}</p> : null}
    <TimerControls taskId={taskId} occurrenceKey={occurrenceKey} canStart={canStart} completed={completed}/>
  </section>
}
