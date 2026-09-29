import { useEffect, useMemo, useRef, useState } from 'react'
import { toIsoInZone } from '@shared/time'
import type { CheckinApi } from '../../hooks/use-checkin'
import { errorMessage } from '../../lib/api-client'
import type { AttendanceAnomaly } from '../../lib/api-client'

export function DepartureCorrection({ anomalies, correct }: Pick<CheckinApi, 'anomalies' | 'correct'>) {
  const [dismissed, setDismissed] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  const record = anomalies.find(day => !dismissed.includes(day.dayKey))
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (record && !dialog.current?.open) dialog.current?.showModal()
  }, [record])
  function dismiss() {
    if (correct.isPending || !record) return
    setDismissed(items => [...items, record.dayKey]); setEditing(false); correct.reset()
  }
  return <>
    {anomalies.length > 0 && <button className="ta-btn ta-btn--secondary" onClick={() => setDismissed([])}>
      打卡记录待确认（{anomalies.length}）
    </button>}
    {record && <dialog ref={dialog} className="ta-departure" aria-labelledby="departure-title" onCancel={event => { event.preventDefault(); dismiss() }}>
      <h2 id="departure-title">{editing ? '修正离开时间' : '打卡记录待确认'}</h2>
      <p>{record.leftAt && Date.parse(record.leftAt) > Date.parse(record.boundaryAt)
        ? `${record.dayKey} 的离开时间跨过了日界，请确认实际离开时间。`
        : `${record.dayKey} 未在日界前记录离开，已按 ${record.boundaryAt.slice(11, 16)} 结束计时。`}</p>
      <p className="ta-departure__arrival">到达：{record.arrivedAt.slice(0, 16).replace('T', ' ')}（固定）</p>
      {editing ? <TimeRing key={record.dayKey} record={record} pending={correct.isPending} onSave={leftAt => correct.mutate({ dayKey: record.dayKey, leftAt }, { onSuccess: () => setEditing(false) })} /> :
        <div className="ta-departure__actions">
          <button className="ta-btn ta-btn--primary" onClick={() => setEditing(true)}>修正时间</button>
          <button className="ta-btn ta-btn--secondary" disabled={correct.isPending} onClick={() => correct.mutate({ dayKey: record.dayKey, leftAt: record.boundaryAt })}>确认日界时间</button>
        </div>}
      {correct.isError && <p role="alert">{errorMessage(correct.error)}</p>}
      <button className="ta-btn ta-btn--ghost" disabled={correct.isPending} onClick={dismiss}>稍后处理</button>
    </dialog>}
  </>
}

function TimeRing({ record, pending, onSave }: { record: AttendanceAnomaly; pending: boolean; onSave: (value: string) => void }) {
  const min = Date.parse(record.arrivedAt)
  const max = Date.parse(record.boundaryAt)
  const [selected, setSelected] = useState(max)
  const [input, setInput] = useState(record.boundaryAt.slice(0, 16))
  const [invalid, setInvalid] = useState(false)
  const iso = toIsoInZone(new Date(selected), record.timeZone)
  const minutes = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
  const angle = minutes / 1440 * Math.PI * 2
  const candidates = useMemo(() => {
    const values: { t: number; wall: string; minutes: number }[] = []
    for (let t = Math.ceil(min / 60000) * 60000; t <= max; t += 60000) {
      const wall = toIsoInZone(new Date(t), record.timeZone)
      values.push({ t, wall: wall.slice(0, 16), minutes: Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16)) })
    }
    return values
  }, [min, max, record.timeZone])
  function select(value: number) {
    const next = Math.min(max, Math.max(min, value))
    setSelected(next); setInput(toIsoInZone(new Date(next), record.timeZone).slice(0, 16)); setInvalid(false)
  }
  function byClock(target: number) {
    let best = selected, distance = Infinity
    for (const { t, minutes: m } of candidates) {
      const delta = Math.abs(m - target)
      const score = Math.min(delta, 1440 - delta) + Math.abs(t - selected) / 1e12
      if (score < distance) { best = t; distance = score }
    }
    select(best)
  }
  function pointer(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const angle = Math.atan2(event.clientX - box.left - box.width / 2, -(event.clientY - box.top - box.height / 2))
    byClock(Math.round(((angle + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 1440) % 1440)
  }
  function manual(value: string) {
    setInput(value)
    // Resolve against valid instants in the saved account timezone, not the browser timezone.
    const match = candidates.find(candidate => candidate.wall === value)
    if (match) { setSelected(match.t); setInvalid(false); return }
    setInvalid(true)
  }
  return <form onSubmit={event => { event.preventDefault(); if (!invalid && !pending) onSave(toIsoInZone(new Date(selected), record.timeZone)) }}>
    <svg className="ta-departure__ring" viewBox="0 0 280 280" role="slider" tabIndex={pending ? -1 : 0}
      aria-label="离开时间" aria-valuemin={0} aria-valuemax={Math.floor((max - min) / 60000)} aria-valuenow={Math.floor((selected - min) / 60000)} aria-valuetext={input.replace('T', ' ')}
      onPointerDown={event => { if (pending) return; event.currentTarget.setPointerCapture(event.pointerId); pointer(event) }}
      onPointerMove={event => { if (!pending && event.currentTarget.hasPointerCapture(event.pointerId)) pointer(event) }}
      onKeyDown={event => {
        const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 60, PageDown: -60 }[event.key]
        if (delta !== undefined && !pending) { event.preventDefault(); select(selected + delta * 60000) }
        if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); if (!pending) select(event.key === 'Home' ? min : max) }
      }}>
      <circle cx="140" cy="140" r="104" fill="none" stroke="currentColor" strokeWidth="2" opacity=".25" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = i / 8 * Math.PI * 2
        return <text key={i} x={140 + Math.sin(a) * 125} y={145 - Math.cos(a) * 125} textAnchor="middle" fontSize="12" fill="currentColor">{String(i * 3).padStart(2, '0')}</text>
      })}
      <line x1="140" y1="140" x2={140 + Math.sin(angle) * 104} y2={140 - Math.cos(angle) * 104} stroke="currentColor" strokeWidth="2" opacity=".3" />
      <circle cx={140 + Math.sin(angle) * 104} cy={140 - Math.cos(angle) * 104} r="10" fill="currentColor" />
      <rect x="83" y="113" width="114" height="55" rx="8" className="ta-departure__clockBg" />
      <text x="140" y="147" textAnchor="middle" fill="currentColor" fontSize="30">{iso.slice(11, 16)}</text>
    </svg>
    <label className="ta-departure__input">离开日期与时间
      <input type="datetime-local" value={input} min={record.arrivedAt.slice(0, 16)} max={record.boundaryAt.slice(0, 16)} required disabled={pending} onChange={event => manual(event.target.value)} aria-invalid={invalid} />
    </label>
    {invalid && <p role="alert">请选择到达时间与日界之间的离开时间。</p>}
    <div className="ta-departure__actions"><button className="ta-btn ta-btn--primary" disabled={pending || invalid}>{pending ? '保存中…' : '保存修正'}</button></div>
  </form>
}
