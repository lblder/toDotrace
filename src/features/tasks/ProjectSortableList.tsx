import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import type { ProjectRow } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import { cx } from '../../lib/cx'
import './project-sortable.css'

type Drag = {
  id: string
  pointerId: number
  pointerType: string
  button: HTMLButtonElement
  startX: number
  startY: number
  x: number
  y: number
  moved: boolean
  active: boolean
  sourceIndex: number
  targetIndex: number
  original: string[]
  mids: number[]
  scrollStart: number
  slotHeight: number
  offsetX: number
  offsetY: number
  width: number
}

type Preview = Pick<Drag, 'id' | 'sourceIndex' | 'targetIndex' | 'x' | 'y' | 'offsetX' | 'offsetY' | 'width' | 'slotHeight'>

/** 拖动时只移动视觉位置；松手后才提交顺序，避免命中区域随 DOM 重排跳动。 */
export function ProjectSortableList({ projects, selectedId, onSelect, onReorder, onProjectMenu }: {
  projects: readonly ProjectRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  onReorder: (ids: string[]) => Promise<unknown>
  onProjectMenu?: (project: ProjectRow, anchor: { x: number; y: number }) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const [order, setOrder] = useState<string[] | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const instructionsId = useId()
  const byId = new Map(projects.map((project) => [project.projectId, project]))
  const sorted = order === null ? projects : [
    ...order.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []),
    ...projects.filter((project) => !order.includes(project.projectId)),
  ]

  function clearTimers() {
    if (holdRef.current !== null) clearTimeout(holdRef.current)
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    holdRef.current = null
    frameRef.current = null
  }

  function release(drag: Drag) {
    if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId)
  }

  function cancel() {
    const drag = dragRef.current
    dragRef.current = null
    clearTimers()
    if (drag !== null) {
      suppressClick.current = drag.active || drag.moved
      release(drag)
    }
    setPreview(null)
    setOrder(null)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragRef.current !== null) { event.preventDefault(); cancel() }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', cancel)
    return () => {
      clearTimers()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  function showPreview(drag: Drag) {
    setPreview({ id: drag.id, sourceIndex: drag.sourceIndex, targetIndex: drag.targetIndex,
      x: drag.x, y: drag.y, offsetX: drag.offsetX, offsetY: drag.offsetY,
      width: drag.width, slotHeight: drag.slotHeight })
  }

  function placeAt(y: number) {
    const drag = dragRef.current
    const list = listRef.current
    if (drag === null || !drag.active || list === null) return
    const scrollDelta = list.scrollTop - drag.scrollStart
    const targetIndex = drag.mids.filter((mid, index) => index !== drag.sourceIndex && y > mid - scrollDelta).length
    if (targetIndex !== drag.targetIndex) {
      drag.targetIndex = targetIndex
      showPreview(drag)
    }
  }

  function scrollDuringDrag() {
    const drag = dragRef.current
    const list = listRef.current
    if (drag === null || !drag.active || list === null) return
    const bounds = list.getBoundingClientRect()
    const edge = Math.min(38, bounds.height / 4)
    const delta = drag.y < bounds.top + edge ? -Math.min(14, Math.max(4, bounds.top + edge - drag.y) / 3)
      : drag.y > bounds.bottom - edge ? Math.min(14, Math.max(4, drag.y - (bounds.bottom - edge)) / 3) : 0
    if (delta !== 0) {
      const previous = list.scrollTop
      list.scrollTop += delta
      if (list.scrollTop !== previous) placeAt(drag.y)
    }
    frameRef.current = requestAnimationFrame(scrollDuringDrag)
  }

  function activate(drag: Drag) {
    const list = listRef.current
    if (dragRef.current !== drag || drag.active || list === null) return
    clearTimers()
    const rows = [...list.querySelectorAll<HTMLElement>('[data-project-sort-row]')]
    const rect = drag.button.getBoundingClientRect()
    drag.mids = rows.map((row) => {
      const bounds = row.getBoundingClientRect()
      return bounds.top + bounds.height / 2
    })
    drag.scrollStart = list.scrollTop
    drag.slotHeight = rows.length > 1
      ? Math.abs(rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().top)
      : rect.height
    drag.offsetX = drag.startX - rect.left
    drag.offsetY = drag.startY - rect.top
    drag.width = rect.width
    drag.active = true
    suppressClick.current = true
    setError(null)
    setAnnouncement(`正在移动${byId.get(drag.id)?.name ?? '项目'}`)
    showPreview(drag)
    placeAt(drag.y)
    frameRef.current = requestAnimationFrame(scrollDuringDrag)
  }

  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    suppressClick.current = false
    if (saving || projects.length < 2 || !event.isPrimary || event.button !== 0) return
    const button = event.currentTarget
    const ids = sorted.map((project) => project.projectId)
    const sourceIndex = ids.indexOf(id)
    const drag: Drag = {
      id, pointerId: event.pointerId, pointerType: event.pointerType, button,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      moved: false, active: false, sourceIndex, targetIndex: sourceIndex,
      original: ids, mids: [], scrollStart: 0, slotHeight: 0, offsetX: 0, offsetY: 0, width: 0,
    }
    dragRef.current = drag
    button.setPointerCapture(event.pointerId)
    const grip = event.target instanceof Element && event.target.closest('[data-project-grip]') !== null
    if (grip) activate(drag)
    else holdRef.current = setTimeout(() => { if (!drag.moved) activate(drag) }, 200)
  }

  function move(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const previousY = drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.active) {
      const distance = Math.hypot(drag.x - drag.startX, drag.y - drag.startY)
      if (drag.pointerType === 'mouse' && distance >= 5) activate(drag)
      else if (drag.pointerType !== 'mouse' && distance > 8) {
        drag.moved = true
        suppressClick.current = true
        if (holdRef.current !== null) clearTimeout(holdRef.current)
        holdRef.current = null
      }
      if (drag.moved && listRef.current !== null) listRef.current.scrollTop += previousY - drag.y
    }
    if (!drag.active) return
    event.preventDefault()
    showPreview(drag)
    placeAt(drag.y)
  }

  async function save(ids: string[]) {
    setOrder(ids)
    setSaving(true)
    setError(null)
    try {
      await onReorder(ids)
      setAnnouncement('项目顺序已保存')
    } catch (cause) {
      setError(errorMessage(cause))
      setAnnouncement('排序未保存，已恢复原顺序')
    } finally {
      setSaving(false)
      setOrder(null)
    }
  }

  function finish(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    clearTimers()
    release(drag)
    setPreview(null)
    suppressClick.current = drag.active || drag.moved
    if (!drag.active || drag.targetIndex === drag.sourceIndex) return
    const next = drag.original.filter((id) => id !== drag.id)
    next.splice(drag.targetIndex, 0, drag.id)
    void save(next)
  }

  function openMenu(project: ProjectRow, anchor: { x: number; y: number }) {
    cancel()
    suppressClick.current = false
    onProjectMenu?.(project, anchor)
  }

  function anchorOf(element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    return { x: rect.right, y: rect.bottom }
  }

  function rowShift(index: number) {
    if (preview === null) return 0
    const { sourceIndex, targetIndex, slotHeight } = preview
    if (index === sourceIndex) return (targetIndex - sourceIndex) * slotHeight
    if (targetIndex < sourceIndex && index >= targetIndex && index < sourceIndex) return slotHeight
    if (targetIndex > sourceIndex && index > sourceIndex && index <= targetIndex) return -slotHeight
    return 0
  }

  return <>
    <span id={instructionsId} className="ta-sr-only">鼠标拖动或长按项目排序，抓手可立即拖动；也可按 Alt 加上、下方向键移动项目，Escape 取消拖动。Shift 加 F10 打开项目菜单。</span>
    <div ref={listRef} className="ta-tasks__sortableProjects" aria-label="项目排序" aria-busy={saving}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
      onLostPointerCapture={(event) => { if (dragRef.current?.pointerId === event.pointerId) cancel() }}>
      {sorted.map((project, index) => <div key={project.projectId} data-project-sort-row=""
        className={cx('ta-tasks__projectSortRow', preview?.id === project.projectId && 'ta-tasks__projectSortRow--placeholder')}
        style={{ transform: `translateY(${rowShift(index)}px)` }}
        onContextMenu={(event) => {
          if (onProjectMenu === undefined) return
          event.preventDefault()
          openMenu(project, { x: event.clientX, y: event.clientY })
        }}>
        <button type="button" data-project-sort-id={project.projectId}
          className={cx('ta-tasks__sideItem', 'ta-tasks__sortableProject', selectedId === project.projectId && 'ta-tasks__sideItem--on', preview?.id === project.projectId && 'ta-tasks__sortableProject--dragging')}
          aria-current={selectedId === project.projectId ? 'page' : undefined}
          aria-describedby={instructionsId}
          title="拖动排序"
          onPointerDown={(event) => start(event, project.projectId)}
          onClick={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); return } onSelect(project.projectId) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') suppressClick.current = false
            if (event.shiftKey && event.key === 'F10' && onProjectMenu !== undefined) {
              event.preventDefault()
              openMenu(project, anchorOf(event.currentTarget))
              return
            }
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            if (saving || dragRef.current !== null) return
            const nextIndex = index + (event.key === 'ArrowUp' ? -1 : 1)
            if (nextIndex < 0 || nextIndex >= sorted.length) return
            const ids = sorted.map((item) => item.projectId)
            ;[ids[index], ids[nextIndex]] = [ids[nextIndex]!, ids[index]!]
            void save(ids)
          }}>
          <span className="ta-tasks__projectDot" aria-hidden="true"/>
          <span className="ta-tasks__sideTruncate">{project.name}</span>
          <span className="ta-tasks__projectGrip" data-project-grip="" aria-hidden="true">⠿</span>
        </button>
        {onProjectMenu === undefined ? null : <button type="button" className="ta-tasks__projectMenuButton" aria-label={`项目「${project.name}」的操作`}
          title="更多操作" onClick={(event) => openMenu(project, anchorOf(event.currentTarget))}
          onKeyDown={(event) => {
            if (event.shiftKey && event.key === 'F10' && onProjectMenu !== undefined) {
              event.preventDefault()
              openMenu(project, anchorOf(event.currentTarget))
            }
          }}>⋯</button>}
      </div>)}
    </div>
    {preview !== null && typeof document !== 'undefined' ? createPortal(
      <div className="ta-tasks__projectDragGhost" aria-hidden="true"
        style={{ left: preview.x - preview.offsetX, top: preview.y - preview.offsetY, width: preview.width }}>
        <span className="ta-tasks__projectDot"/><span className="ta-tasks__sideTruncate">{byId.get(preview.id)?.name}</span>
        <span className="ta-tasks__projectGrip">⠿</span>
      </div>, document.body) : null}
    <span className="ta-sr-only" role="status">{announcement}</span>
    {error === null ? null : <p className="ta-field__hint" role="alert">排序保存失败：{error}</p>}
  </>
}
