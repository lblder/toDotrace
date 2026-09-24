import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectRow } from '../../lib/api-client'
import { errorMessage } from '../../lib/api-client'
import type { useProjectActions } from '../../hooks/use-projects'
import './project-menu.css'

export type ProjectMenuTarget = { project: ProjectRow; anchor: { x: number; y: number } }

export function ProjectMenu({ target, actions, onClose, onArchived }: {
  target: ProjectMenuTarget
  actions: ReturnType<typeof useProjectActions>
  onClose: () => void
  onArchived: (id: string) => void
}) {
  const { project, anchor } = target
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)

  useEffect(() => () => { if (returnFocus.current?.isConnected) returnFocus.current.focus() }, [])
  useEffect(() => {
    if (renaming) {
      dialogRef.current?.showModal()
      inputRef.current?.select()
      return
    }
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose() }
    const onResize = () => onClose()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', onResize)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', onResize) }
  }, [renaming, onClose])

  async function rename() {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await actions.update.mutateAsync({ projectId: project.projectId, input: { name: name.trim() } })
      onClose()
    } catch (cause) { setError(errorMessage(cause)); setBusy(false) }
  }
  async function archive() {
    setBusy(true)
    setError(null)
    try {
      await actions.archive.mutateAsync({ projectId: project.projectId, archived: !project.archived })
      if (!project.archived) onArchived(project.projectId)
      onClose()
    } catch (cause) { setError(errorMessage(cause)); setBusy(false) }
  }

  return createPortal(renaming ? <dialog ref={dialogRef} className="ta-projectRename" aria-labelledby="project-rename-heading"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={(event) => { event.preventDefault(); void rename() }}>
      <h2 id="project-rename-heading">重命名项目</h2>
      <label className="ta-field"><span className="ta-field__label">项目名称</span>
        <input ref={inputRef} className="ta-input" value={name} onChange={(event) => setName(event.target.value)} autoFocus disabled={busy}/>
      </label>
      {error === null ? null : <p role="alert" className="ta-banner ta-banner--error">{error}</p>}
      <div className="ta-projectRename__actions">
        <button type="button" className="ta-btn ta-btn--ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="ta-btn ta-btn--primary" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </form>
  </dialog> : <div ref={menuRef} className="ta-projectMenu" role="menu" aria-label={`${project.name}的操作`}
    style={{ left: Math.max(8, Math.min(anchor.x, window.innerWidth - 220)), top: Math.max(8, Math.min(anchor.y, window.innerHeight - 170)) }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') { onClose(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
    <button role="menuitem" type="button" disabled={busy} onClick={() => { setError(null); setRenaming(true) }}>重命名项目</button>
    <button role="menuitem" type="button" disabled={busy} onClick={() => void archive()}>{project.archived ? '恢复项目' : '归档项目'}</button>
    {error === null ? null : <p role="alert">{error}</p>}
  </div>, document.body)
}
