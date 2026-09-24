import { useEffect, useState } from 'react'
import { useTaskDetail } from '../../hooks/use-tasks'
import { useTimer } from '../../hooks/use-timer'
import { TimerControls } from './TimerControls'

/** 任务清单已有当前实例的行时，停表按钮就在行上；其他视图由 dock 补位。 */
function useTaskRowPresent(taskId: string | null, occurrenceKey: string | null, tasksRoute: boolean): boolean {
  const [present, setPresent] = useState(false)
  useEffect(() => {
    if (!tasksRoute || taskId === null || occurrenceKey === null) {
      setPresent(false)
      return
    }
    const main = document.getElementById('main')
    if (main === null) return
    const check = () => {
      const found = Array.from(main.querySelectorAll<HTMLElement>('.ta-tasks__row')).some((row) =>
        row.dataset.taskId === taskId && row.dataset.occurrenceKey === occurrenceKey && row.getClientRects().length > 0)
      setPresent(found)
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'style'] })
    return () => observer.disconnect()
  }, [taskId, occurrenceKey, tasksRoute])
  return present
}

/** 跨页面持续显示服务端正在计的任务；仅当任务页本身能操作该行时收起。 */
export function TimerDock({ tasksRoute = false }: { readonly tasksRoute?: boolean }) {
  const timer = useTimer()
  const active = timer.snapshot?.active ?? null
  const detail = useTaskDetail(active?.taskId ?? null)
  const rowPresent = useTaskRowPresent(active?.taskId ?? null, active?.occurrenceKey ?? null, tasksRoute)
  if (active === null || rowPresent) return null

  return <aside className={`ta-timer__dock${tasksRoute ? ' ta-timer__dock--tasks' : ''}`} aria-label="正在计时的任务" data-testid="timer-dock">
    <div className="ta-timer__dockHeader"><span>正在计时</span><small>{active.occurrenceKey}</small></div>
    <h2 className="ta-timer__dockTitle">{detail.detail?.task.title ?? '当前任务'}</h2>
    <TimerControls taskId={active.taskId} occurrenceKey={active.occurrenceKey}/>
  </aside>
}
