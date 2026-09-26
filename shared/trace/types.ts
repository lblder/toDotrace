import type { DayKey } from '../time'

export type TracePeriod = 'week' | 'month' | '90d' | 'all' | 'project'

export interface TraceTaskRecord {
  taskId: string
  occurrenceKey: DayKey
  title: string
  completedAt: string
}

export interface TraceDay {
  dayKey: DayKey
  future: boolean
  created: number
  completed: number
  completions: TraceTaskRecord[]
  arrival: string | null
  left: string | null
  durationMinutes: number | null
  durationNeedsReview: boolean
  focusSeconds: number
  presenceFocusSeconds: number | null
  presenceOtherSeconds: number | null
}

export interface TraceTrendPoint {
  key: DayKey
  label: string
  created: number
  completed: number
}

export interface TraceRatio {
  numerator: number
  denominator: number
  percent: number | null
}

export interface TraceScore {
  persistence: TraceRatio
  completion: TraceRatio
  timeliness: TraceRatio
  effort: TraceRatio
  firstPass: TraceRatio
  total: number | null
  grade: 'S' | 'A' | 'B' | 'C' | 'D' | null
  missingCheckinDays: number
  missingCreatedTasks: number
  explanation: string
  suggestion: string
}

export interface TraceProjectSummary {
  projectId: string
  name: string
  ownedTotal: number
  ownedCompleted: number
}

export interface FocusSummary {
  from: DayKey
  to: DayKey
  seconds: number
  projects: { projectId: string | null; name: string; seconds: number }[]
}

export interface TracePayload {
  focusWindows: Record<'today' | 'week' | 'all', FocusSummary>
  today: DayKey
  focusRunning: boolean
  focusProjects: { projectId: string | null; name: string; seconds: number }[]
  period: TracePeriod
  range: { from: DayKey; to: DayKey }
  goalMinutes: number
  heatmap: TraceDay[]
  days: TraceDay[]
  trend: TraceTrendPoint[]
  trendUnit: 'day' | 'week' | 'month'
  score: TraceScore
  totals: {
    created: number
    completed: number
    checkinDays: number
    validDurationDays: number
    durationNeedsReviewDays: number
    totalDurationMinutes: number
    totalFocusSeconds: number
  }
  weekdays: number[]
  arrivals: number[]
  planTypes: { day: number; week: number; recurring: number; undated: number }
  project: TraceProjectSummary | null
}
