import { useCallback, useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, PieChart } from 'echarts/charts'
import { AriaComponent, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import type { TracePayload } from '@shared/trace/types'
import { useTheme } from '../../hooks/use-theme'

echarts.use([BarChart, PieChart, AriaComponent, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent, SVGRenderer])
type Chart = ReturnType<typeof echarts.init>
type Palette = { ink: string; muted: string; line: string; primary: string; success: string; surface: string; colors: string[] }
const colorVars = ['--trace-project-1', '--trace-project-2', '--trace-project-3', '--trace-project-4', '--trace-project-5', '--trace-project-6']

export function timeText(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const rest = Math.floor(seconds % 60)
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}
const dateText = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`

function Plot({ label, build, onSelect, selected, className = '' }: {
  label: string; build: (palette: Palette) => EChartsOption; onSelect?: (index: number) => void; selected?: number; className?: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const instance = useRef<Chart | null>(null)
  const { resolved } = useTheme()
  useEffect(() => {
    if (!element.current) return
    const chart = echarts.init(element.current, undefined, { renderer: 'svg' })
    instance.current = chart
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(element.current)
    return () => { resize.disconnect(); chart.dispose(); instance.current = null }
  }, [])
  useEffect(() => {
    if (!instance.current || !element.current) return
    const style = getComputedStyle(element.current)
    const color = (name: string) => style.getPropertyValue(name).trim()
    const palette = { ink: color('--c-ink'), muted: color('--c-ink-muted'), line: color('--c-border'), primary: color('--c-primary-text'), success: color('--c-success'), surface: color('--c-panel'), colors: colorVars.map(color) }
    instance.current.setOption({ ...build(palette), animation: false, aria: { enabled: true, description: label } }, { notMerge: true })
  }, [build, resolved, label])
  useEffect(() => {
    const chart = instance.current
    if (!chart || !onSelect) return
    const handler = (event: unknown) => {
      const index = (event as { dataIndex?: number }).dataIndex
      if (index !== undefined) onSelect(index)
    }
    chart.on('click', handler)
    return () => { chart.off('click', handler) }
  }, [onSelect])
  useEffect(() => {
    const chart = instance.current
    if (!chart || selected === undefined) return
    chart.dispatchAction({ type: 'downplay', seriesIndex: 0 })
    if (selected >= 0) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: selected })
  }, [selected, build, resolved])
  return <div className={`ta-trace__echart ${className}`} ref={element} role="img" aria-label={label} />
}

function Attendance({ data }: { data: TracePayload }) {
  const [chosen, choose] = useState<string | null>(null)
  const days = data.days
  const selected = days.find(day => day.dayKey === chosen) ?? [...days].reverse().find(day => day.arrival !== null) ?? days.at(-1)
  const valid = days.filter(day => day.durationMinutes !== null)
  const peak = valid.reduce((best, day) => Math.max(best, day.durationMinutes ?? 0), 0)
  const label = (day: typeof selected) => !day ? '暂无记录' : day.durationNeedsReview ? '记录待核对' : day.durationMinutes !== null ? timeText(day.durationMinutes * 60) : day.arrival !== null ? '尚未记录离开' : '未打卡'
  const build = useCallback((p: Palette): EChartsOption => ({
    textStyle: { color: p.ink, fontFamily: 'inherit' },
    grid: { left: 48, right: 18, top: 34, bottom: days.length > 31 ? 82 : 42 },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, axisPointer: { type: 'shadow' }, formatter: (params: unknown) => {
      const index = (params as { dataIndex: number }[])[0]?.dataIndex
      const day = index === undefined ? undefined : days[index]
      return day ? `${day.dayKey}\n在场：${label(day)}${day.presenceFocusSeconds === null ? '' : `\n专注：${timeText(day.presenceFocusSeconds)}\n其他：${timeText(day.presenceOtherSeconds ?? 0)}`}\n目标：${timeText(data.goalMinutes * 60)}` : ''
    } },
    xAxis: { type: 'category', data: days.map(day => day.dayKey), axisTick: { show: false }, axisLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.muted, formatter: dateText, hideOverlap: true } },
    yAxis: { type: 'value', min: 0, minInterval: 1, name: '小时', nameTextStyle: { color: p.muted }, axisLabel: { color: p.muted }, splitLine: { lineStyle: { color: p.line, type: 'dashed' } }, max: Math.max(2, Math.ceil(Math.max(peak, data.goalMinutes) * 1.15 / 120) * 2) },
    dataZoom: days.length > 31 ? [{ type: 'slider', bottom: 4, height: 20, startValue: Math.max(0, days.length - 31), endValue: days.length - 1, textStyle: { color: p.muted }, borderColor: p.line }] : [],
    series: [{ type: 'bar', name: '专注时长', stack: 'presence', barMaxWidth: 24, data: days.map(day => day.presenceFocusSeconds === null ? null : day.presenceFocusSeconds / 3600), itemStyle: { color: p.success } },
    { type: 'bar', name: '其他时长', stack: 'presence', barMaxWidth: 24, data: days.map(day => day.presenceOtherSeconds === null ? null : day.presenceOtherSeconds / 3600),
      itemStyle: { color: p.colors[2], borderRadius: [3, 3, 0, 0] },
      label: { show: days.length <= 31, position: 'top', color: p.ink, fontSize: 10, formatter: (params: { dataIndex: number }) => { const minutes = days[params.dataIndex]?.durationMinutes; return minutes == null ? '' : `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}` } },
      emphasis: { itemStyle: { color: p.primary } },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: p.primary, type: 'dashed' }, label: { formatter: '目标', position: 'insideEndTop', color: p.primary }, data: [{ yAxis: data.goalMinutes / 60 }] },
    }],
  }), [days, peak, data.goalMinutes])
  const select = useCallback((index: number) => { if (days[index]) choose(days[index].dayKey) }, [days])
  return <section className="ta-trace__panel ta-trace__timePanel" aria-labelledby="trace-duration">
    <div className="ta-trace__panelHead"><h2 id="trace-duration">在场时长</h2><small>每日目标 {timeText(data.goalMinutes * 60)}</small></div>
    <div className="ta-trace__timeReadouts"><div><small>本期累计</small><strong>{timeText(data.totals.totalDurationMinutes * 60)}</strong></div><div><small>日均 · {valid.length} 个有效日</small><strong>{timeText(valid.length ? Math.round(data.totals.totalDurationMinutes / valid.length) * 60 : 0)}</strong></div></div>
    <div className="ta-trace__presenceLegend"><span><i />专注时长</span><span><i />其他时长</span></div>
    <Plot label="每日在场时长，由专注时长和其他时长堆叠组成，横轴日期，纵轴小时，虚线为每日目标" build={build} onSelect={select} />
    <div className="ta-trace__dayReadout"><select className="ta-input" aria-label="查看日期的在场时长" value={selected?.dayKey ?? ''} onChange={event => choose(event.target.value)}>{days.map(day => <option key={day.dayKey} value={day.dayKey}>{day.dayKey}</option>)}</select><strong aria-live="polite">{label(selected)}</strong></div>
    <div className="ta-trace__presenceDetail" aria-live="polite">{selected?.presenceFocusSeconds != null && <>专注 {timeText(selected.presenceFocusSeconds)}<span>其他 {timeText(selected.presenceOtherSeconds ?? 0)}</span></>}</div>
    <p className="ta-trace__footnote">扣除暂离；专注仅计在场期间。{data.totals.durationNeedsReviewDays > 0 ? ` ${data.totals.durationNeedsReviewDays} 天待核对，未计入。` : ''}</p>
  </section>
}

function FocusProjects({ data }: { data: TracePayload }) {
  const [active, setActive] = useState(-1)
  const [scope, setScope] = useState<'today' | 'week' | 'all'>('today')
  const window = data.focusWindows[scope]
  const groups = window.projects
  const total = window.seconds
  const scopes = { today: '今日专注', week: '近一周', all: '累计专注' } as const
  const percent = (seconds: number) => total > 0 ? `${(seconds / total * 100).toFixed(1)}%` : '0%'
  useEffect(() => { setActive(-1) }, [groups])
  const build = useCallback((p: Palette): EChartsOption => ({
    color: p.colors,
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true, formatter: (params: unknown) => {
      const group = groups[(params as { dataIndex: number }).dataIndex]
      return group ? `${group.name}\n${timeText(group.seconds)} · ${percent(group.seconds)}` : ''
    } },
    series: [{ type: 'pie', radius: ['66%', '84%'], center: ['50%', '50%'], avoidLabelOverlap: true, stillShowZeroSum: false,
      label: { show: false }, labelLine: { show: false }, emphasis: { scale: false },
      itemStyle: { borderColor: p.surface, borderWidth: 3 },
      data: groups.map(group => ({ id: group.projectId ?? 'unassigned', name: group.name, value: group.seconds })),
    }],
  }), [groups, total])
  const selected = active >= 0 ? groups[active] : undefined
  return <section className="ta-trace__panel ta-trace__timePanel" aria-labelledby="trace-focus">
    <div className="ta-trace__panelHead"><h2 id="trace-focus">专注时长</h2><small>{data.focusRunning ? '正在计时 · 每 15 秒更新' : '按项目分布'}</small></div>
    <div className="ta-trace__modeSwitch ta-trace__focusScopes" role="group" aria-label="专注统计范围">{(Object.keys(scopes) as (keyof typeof scopes)[]).map(key => <button key={key} type="button" className={scope === key ? 'is-active' : ''} aria-pressed={scope === key} onClick={() => setScope(key)}>{scopes[key]}</button>)}</div>
    <small className="ta-trace__focusRange">{window.from} — {window.to}{scope === 'week' ? ' · 含今天的最近 7 天' : ''}</small>
    {groups.length === 0 ? <div className="ta-trace__chartEmpty"><strong>0 秒</strong><p>此范围内暂无专注记录。</p></div> : <div className="ta-trace__focusLayout">
      <div className="ta-trace__donutWrap"><Plot label="各项目专注时长占比环形图" build={build} onSelect={setActive} selected={active} className="ta-trace__donut" /><div className="ta-trace__donutCenter"><small>{selected ? percent(selected.seconds) : scopes[scope]}</small><strong>{timeText(selected?.seconds ?? total)}</strong></div></div>
      <ul className="ta-trace__projectTimes" aria-label="项目专注时长明细">{groups.map((group, index) => <li key={group.projectId ?? 'unassigned'}><button type="button" aria-pressed={active === index} onClick={() => setActive(index)} onFocus={() => setActive(index)}><i style={{ background: `var(${colorVars[index % colorVars.length]})` }} /><span className="ta-trace__projectTimeName" title={group.name}>{group.name}</span><strong>{timeText(group.seconds)}</strong><small>{percent(group.seconds)}</small></button></li>)}</ul>
    </div>}
    <p className="ta-trace__footnote">按开始计时时所属项目统计。暂停时间不计入。</p>
  </section>
}

export default function TimeCharts({ data }: { data: TracePayload }) {
  return <><Attendance data={data} /><FocusProjects data={data} /></>
}
