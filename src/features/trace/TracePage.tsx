import { useEffect, useMemo, useState } from 'react'
import type { TraceDay, TracePayload, TracePeriod, TraceRatio } from '@shared/trace/types'
import { useTrace } from '../../hooks/use-trace'
import { useProjects } from '../../hooks/use-projects'
import { errorMessage } from '../../lib/api-client/client'
import './trace.css'

type HeatMode = 'completed' | 'arrival'

const PERIODS: readonly { value: TracePeriod; label: string }[] = [
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: '90d', label: '近 90 天' },
  { value: 'all', label: '全部' },
  { value: 'project', label: '项目周期' },
]

function clock(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso
}

function minutes(value: number): string {
  const hours = Math.floor(value / 60)
  const remain = value % 60
  return hours === 0 ? `${remain} 分钟` : remain === 0 ? `${hours} 小时` : `${hours} 小时 ${remain} 分`
}

function dayLabel(dayKey: string): string {
  return `${Number(dayKey.slice(5, 7))} 月 ${Number(dayKey.slice(8, 10))} 日`
}

function heatLevel(day: TraceDay, mode: HeatMode): string {
  if (day.future) return 'future'
  if (mode === 'completed') return String(Math.min(5, day.completed))
  if (day.arrival === null) return 'rest'
  const hour = Number(clock(day.arrival).slice(0, 2))
  if (hour < 8) return '5'
  if (hour < 9) return '4'
  if (hour < 10) return '3'
  if (hour < 11) return '2'
  return '1'
}

function daySummary(day: TraceDay, mode: HeatMode): string {
  if (day.future) return `${dayLabel(day.dayKey)}，尚未到来`
  if (mode === 'completed') return `${dayLabel(day.dayKey)}，完成 ${day.completed} 个任务实例${day.arrival === null ? '，未到达' : `，${clock(day.arrival)} 到达`}`
  return `${dayLabel(day.dayKey)}，${day.arrival === null ? '休息日' : `${clock(day.arrival)} 到达`}，完成 ${day.completed} 个任务实例`
}

function monthMarkers(days: readonly TraceDay[]): string[] {
  return Array.from({ length: 53 }, (_, week) => {
    const first = days[week * 7]
    const previous = days[(week - 1) * 7]
    if (first === undefined) return ''
    if (week === 0 || first.dayKey.slice(0, 7) !== previous?.dayKey.slice(0, 7)) {
      return `${Number(first.dayKey.slice(5, 7))}月`
    }
    return ''
  })
}

function Heatmap({ data, mode, selected, onSelect }: {
  data: readonly TraceDay[]
  mode: HeatMode
  selected: string | null
  onSelect: (dayKey: string) => void
}) {
  const markers = useMemo(() => monthMarkers(data), [data])
  return (
    <div className="ta-trace__heatScroll" role="region" aria-label="过去 53 周的完成日历" tabIndex={0}>
      <div className="ta-trace__heatInner">
        <div className="ta-trace__monthAxis" aria-hidden="true">
          {markers.map((name, index) => <span key={index}>{name}</span>)}
        </div>
        <div className="ta-trace__heatBody">
          <div className="ta-trace__weekdays" aria-hidden="true"><span>一</span><span>三</span><span>五</span><span>日</span></div>
          <div className="ta-trace__heatGrid">
            {data.map((day) => <button
              type="button"
              key={day.dayKey}
              className={`ta-trace__heatCell ta-trace__heatCell--${heatLevel(day, mode)}${selected === day.dayKey ? ' is-selected' : ''}`}
              aria-label={daySummary(day, mode)}
              aria-pressed={selected === day.dayKey}
              title={daySummary(day, mode)}
              disabled={day.future}
              onClick={() => onSelect(day.dayKey)}
            />)}
          </div>
        </div>
      </div>
    </div>
  )
}

function DailyDetail({ day }: { day: TraceDay | null }) {
  if (day === null) return <p className="ta-trace__subtle">点击日期查看记录。</p>
  return <section className="ta-trace__daily" aria-live="polite" aria-label={`${dayLabel(day.dayKey)}的记录`}>
    <div className="ta-trace__dailyHead">
      <strong>{dayLabel(day.dayKey)}</strong>
      <span className="ta-mono">{day.completed} 个完成次数</span>
    </div>
    <div className="ta-trace__dailyColumns">
      <div>
        <h3>完成的任务</h3>
        {day.completions.length === 0 ? <p className="ta-trace__subtle">这天没有完成记录。</p> :
          <ul className="ta-trace__taskList">{day.completions.map((item) => <li key={`${item.taskId}:${item.occurrenceKey}`}>
            <span className="ta-trace__taskDot" aria-hidden="true" />
            <span>{item.title}<small className="ta-mono">任务日期 {item.occurrenceKey}</small></span>
            <time className="ta-mono">{clock(item.completedAt)}</time>
          </li>)}</ul>}
      </div>
      <div>
        <h3>当日打卡</h3>
        {day.arrival === null ? <p className="ta-trace__subtle">未打卡。</p> : <p className="ta-trace__checkinLine">{clock(day.arrival)} 到达 <span aria-hidden="true">→</span> {day.left === null ? '未记离开' : `${clock(day.left)} 离开`}</p>}
        {day.durationMinutes !== null && <p className="ta-trace__subtle">有效停留 {minutes(day.durationMinutes)}</p>}
        {day.durationNeedsReview && <p className="ta-trace__review">时长超过 18 小时或记录顺序异常，暂不计入投入度。</p>}
      </div>
    </div>
  </section>
}

function linePath(values: readonly number[], max: number): string {
  if (values.length === 0) return ''
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${values.length === 1 ? 350 : 24 + index * 652 / (values.length - 1)} ${164 - value / max * 136}`).join(' ')
}

function Trend({ data }: { data: TracePayload }) {
  const values = data.trend
  const maximum = Math.max(1, ...values.map((row) => Math.max(row.created, row.completed)))
  return <section className="ta-trace__panel" aria-labelledby="trace-trend">
    <div className="ta-trace__panelHead"><div><h2 id="trace-trend">计划与完成</h2></div><span className="ta-trace__legend"><i className="ta-trace__legendNew" />新增 <i className="ta-trace__legendDone" />完成</span></div>
    {values.length === 0 ? <p className="ta-trace__subtle">暂无记录。</p> : <>
      <svg className="ta-trace__trendChart" viewBox="0 0 700 190" role="img" aria-label={`${values.length} 个时间点的新增和完成趋势`} preserveAspectRatio="none">
        <path className="ta-trace__guide" d="M 24 28 H 676 M 24 96 H 676 M 24 164 H 676" />
        <path className="ta-trace__lineNew" d={linePath(values.map((row) => row.created), maximum)} />
        <path className="ta-trace__lineDone" d={linePath(values.map((row) => row.completed), maximum)} />
      </svg>
      <div className="ta-trace__chartFoot ta-mono"><span>{values[0]?.label}</span><span>峰值 {maximum}</span><span>{values.at(-1)?.label}</span></div>
    </>}
  </section>
}

function RatioRow({ label, value }: { label: string; value: TraceRatio }) {
  return <div className="ta-trace__ratioRow">
    <div><span>{label}</span><span className="ta-mono">{value.numerator} / {value.denominator}</span></div>
    <div className="ta-trace__ratioTrack"><span style={{ width: `${value.percent ?? 0}%` }} /></div>
    <b className="ta-mono">{value.percent === null ? '待积累' : `${value.percent}%`}</b>
  </div>
}

function Evaluation({ data }: { data: TracePayload }) {
  const { score } = data
  return <section className="ta-trace__panel ta-trace__evaluation" aria-labelledby="trace-score">
    <div className="ta-trace__panelHead"><div><h2 id="trace-score">本期评价</h2></div>{score.grade !== null && <span className="ta-trace__grade ta-readout" aria-label={`等级 ${score.grade}`}>{score.grade}</span>}</div>
    <div className="ta-trace__ratios">
      <RatioRow label="坚持度" value={score.persistence} />
      <RatioRow label="完成率" value={score.completion} />
      <RatioRow label="按时率" value={score.timeliness} />
      <RatioRow label="投入度" value={score.effort} />
    </div>
    <details className="ta-trace__footnote"><summary>评分说明</summary>
      <p>{score.explanation}</p>
      <p>{score.suggestion}</p>
      <p>一次完成率 {score.firstPass.percent === null ? '待积累' : `${score.firstPass.percent}%`} · {score.firstPass.numerator}/{score.firstPass.denominator} 条完成任务未顺延。</p>
    </details>
  </section>
}

function SupportingCharts({ data }: { data: TracePayload }) {
  const maxDuration = Math.max(data.goalMinutes, ...data.days.map((day) => day.durationMinutes ?? 0), 1)
  const durationDays = data.days.filter((day) => day.durationMinutes !== null)
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日']
  const maxWeekday = Math.max(1, ...data.weekdays)
  const arrivalMax = Math.max(1, ...data.arrivals)
  return <div className="ta-trace__supportGrid">
    <section className="ta-trace__panel" aria-labelledby="trace-duration"><div className="ta-trace__panelHead"><div><h2 id="trace-duration">投入时长</h2></div><small>停留目标 {minutes(data.goalMinutes)} / 日</small></div>
      {durationDays.length === 0 ? <p className="ta-trace__subtle">暂无完整的到达与离开记录。</p> : <div className="ta-trace__bars" role="img" aria-label="每日有效停留时长柱状图">{durationDays.slice(-31).map((day) => <div className="ta-trace__barColumn" key={day.dayKey} title={`${dayLabel(day.dayKey)}：${minutes(day.durationMinutes!)}`}><span style={{ height: `${Math.max(4, day.durationMinutes! / maxDuration * 100)}%` }} /></div>)}</div>}
      <p className="ta-trace__footnote">按到达至离开计算，非专注时长。</p>
      {data.totals.durationNeedsReviewDays > 0 && <p className="ta-trace__footnote">{data.totals.durationNeedsReviewDays} 天的时长待核对，未计分。</p>}
    </section>
    <section className="ta-trace__panel" aria-labelledby="trace-rhythm"><div className="ta-trace__panelHead"><div><h2 id="trace-rhythm">星期节律</h2></div><small>完成次数</small></div>
      <div className="ta-trace__weekdayBars">{data.weekdays.map((count, index) => <div key={index}><div className="ta-trace__weekdayTrack"><span style={{ height: `${count === 0 ? 0 : Math.max(8, count / maxWeekday * 100)}%` }} /></div><span className="ta-mono">{weekdayNames[index]}</span><small>{count}</small></div>)}</div>
    </section>
    <section className="ta-trace__panel" aria-labelledby="trace-arrival"><div className="ta-trace__panelHead"><div><h2 id="trace-arrival">到达时刻</h2></div><small>本地时间</small></div>
      {data.totals.checkinDays === 0 ? <p className="ta-trace__subtle">暂无到达记录。</p> : <div className="ta-trace__arrivalBars" role="img" aria-label="24 小时到达时刻分布">{data.arrivals.map((count, hour) => <span key={hour} style={{ height: `${count === 0 ? 2 : Math.max(9, count / arrivalMax * 100)}%` }} title={`${hour}:00–${hour + 1}:00：${count} 天`} />)}</div>}
      <div className="ta-trace__chartFoot ta-mono"><span>00:00</span><span>12:00</span><span>24:00</span></div>
    </section>
    <section className="ta-trace__panel" aria-labelledby="trace-types"><div className="ta-trace__panelHead"><div><h2 id="trace-types">计划类型</h2></div><small>本期新建</small></div>
      <div className="ta-trace__types">{([['日计划', data.planTypes.day], ['周计划', data.planTypes.week], ['重复', data.planTypes.recurring], ['无日期', data.planTypes.undated]] as const).map(([label, count]) => <div key={label}><span>{label}</span><strong className="ta-readout">{count}</strong></div>)}</div>
      <p className="ta-trace__footnote">按当前任务定义分类；已删除和已放弃的计划已排除。</p>
    </section>
  </div>
}

export function TracePage() {
  const [period, setPeriod] = useState<TracePeriod>('month')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [goalMinutes, setGoalMinutes] = useState(360)
  const [mode, setMode] = useState<HeatMode>('completed')
  const [selected, setSelected] = useState<string | null>(null)
  const projects = useProjects()
  const effectiveProjectId = projectId ?? projects.active[0]?.projectId ?? null
  const enabled = period !== 'project' || effectiveProjectId !== null
  const trace = useTrace({ period, goalMinutes, ...(period === 'project' && effectiveProjectId !== null ? { projectId: effectiveProjectId } : {}) }, enabled)
  useEffect(() => { setSelected(null) }, [period, effectiveProjectId, mode])
  const data = trace.data
  const selectedDay = data?.heatmap.find((day) => day.dayKey === selected) ?? null

  return <div className="ta-trace">
    <header className="ta-trace__header">
      <div><h1>学习轨迹</h1></div>
      {data !== undefined && <div className="ta-trace__heroDate"><small>今天</small><strong className="ta-readout">{dayLabel(data.today)}</strong></div>}
    </header>
    <nav className="ta-trace__periods" aria-label="统计区间">{PERIODS.map((item) => <button key={item.value} type="button" className={period === item.value ? 'is-active' : ''} aria-pressed={period === item.value} onClick={() => setPeriod(item.value)}>{item.label}</button>)}</nav>
    <div className="ta-trace__filters">
      {period === 'project' && <label>项目 <select className="ta-input" value={effectiveProjectId ?? ''} onChange={(event) => setProjectId(event.target.value || null)}><option value="">选择项目</option>{projects.active.map((project) => <option value={project.projectId} key={project.projectId}>{project.name}</option>)}</select></label>}
      <label>每日目标 <select className="ta-input" value={goalMinutes} onChange={(event) => setGoalMinutes(Number(event.target.value))}>{[180, 240, 360, 480].map((value) => <option key={value} value={value}>{value / 60} 小时</option>)}</select></label>
    </div>
    {!enabled ? <section className="ta-trace__empty"><h2>还没有项目周期</h2><p>创建项目后，可以按它的起止日期回看全账号的活动。</p></section> : trace.isPending ? <p className="ta-trace__loading">正在加载…</p> : trace.isError ? <section className="ta-trace__empty" role="alert"><h2>读取失败</h2><p>{errorMessage(trace.error)}</p><button type="button" className="ta-btn ta-btn--secondary" onClick={trace.refetch}>重试</button></section> : data !== undefined && <>
      <section className="ta-trace__hero" aria-labelledby="trace-calendar">
        <div className="ta-trace__heroTop"><div><h2 id="trace-calendar">完成日历</h2></div><div className="ta-trace__modeSwitch" role="group" aria-label="日历展示模式"><button type="button" className={mode === 'completed' ? 'is-active' : ''} aria-pressed={mode === 'completed'} onClick={() => setMode('completed')}>完成任务</button><button type="button" className={mode === 'arrival' ? 'is-active' : ''} aria-pressed={mode === 'arrival'} onClick={() => setMode('arrival')}>到达时刻</button></div></div>
        <Heatmap data={data.heatmap} mode={mode} selected={selected} onSelect={setSelected} />
        <div className="ta-trace__heatLegend"><span>{mode === 'completed' ? '少' : '较晚'}</span>{[0, 1, 2, 3, 4, 5].map((level) => <i className={`ta-trace__heatCell--${level}`} key={level} />)}<span>{mode === 'completed' ? '多' : '较早'}</span>{mode === 'arrival' && <span className="ta-trace__restLegend"><i className="ta-trace__heatCell--rest" />休息日</span>}</div>
        <DailyDetail day={selectedDay} />
      </section>
      <div className="ta-trace__summary" aria-label="本期概览"><div><small>新建计划</small><strong className="ta-readout">{data.totals.created}</strong></div><div><small>完成次数</small><strong className="ta-readout">{data.totals.completed}</strong></div><div><small>到达天数</small><strong className="ta-readout">{data.totals.checkinDays}</strong></div><div><small>有效停留</small><strong className="ta-readout">{minutes(data.totals.totalDurationMinutes)}</strong></div></div>
      {data.project !== null && <p className="ta-trace__projectNote">当前统计：项目周期内的全账号活动。项目任务：{data.project.ownedCompleted} / {data.project.ownedTotal} 条已完成。</p>}
      <div className="ta-trace__mainGrid"><Trend data={data} /><Evaluation data={data} /></div>
      <SupportingCharts data={data} />
    </>}
  </div>
}
