/**
 * 时间口径模块 —— 全系统唯一的「日」口径（ADR-009）。
 *
 * 02 §5 纪律：一切「日」口径（打卡日、期限日、热力图、按期判定）统一用它，
 * 禁止混用 UTC 日期；任何模块不得私写日期折算。服务端与前端都从这里导入。
 *
 * - 零依赖：不引 dayjs / date-fns / luxon / moment，只用 `Intl.DateTimeFormat` 与内建 `Date`；
 * - 纯函数：不读系统时钟（`now` 显式传入）、不读全局状态、不写存储；
 * - DST 安全：时刻 ↔ 日历日的换算一律经正午锚点（见 `internal.ts`），
 *   禁止 `toISOString().slice(0, 10)` 这类 UTC 序列化切片当日本地日。
 */
import {
  MS_PER_DAY,
  assertDayStartHour,
  calendarMs,
  dayKeyFromCalendarMs,
  daysInMonth,
  localParts,
  resolveLocalInstant,
} from './internal'

/** 'YYYY-MM-DD'，无时区的日历日 */
export type DayKey = string

/** 时间上下文：由账号设置包成，组件不自行拼装（ADR-009 §2 / §5） */
export interface TimeContext {
  /** IANA 时区，如 'Asia/Shanghai' */
  timeZone: string
  /** 0–23，默认 4：归属日的切点小时 */
  dayStartHour: number
}

/** ADR-009 §2 的默认切点：凌晨 4:00 */
export const DEFAULT_DAY_START_HOUR = 4

/** 支持的日历范围（四位年，与 DayKey 的 'YYYY-MM-DD' 形态一致） */
const MIN_YEAR = 1
const MAX_YEAR = 9999

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function assertDayKeyText(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`DayKey 必须是字符串，实得 ${value === null ? 'null' : typeof value}`)
  }
}

function assertInstant(instant: unknown): asserts instant is Date {
  if (!(instant instanceof Date)) {
    throw new TypeError('instant 必须是 Date')
  }
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError('instant 不是有效瞬间（Invalid Date）')
  }
}

/**
 * 形状与日历双重校验：既看 'YYYY-MM-DD' 格式，也拒绝 2026-02-30、2027-02-29 这类
 * 格式合法但不存在的日子。面向导入文件等不可信输入，因此任何非字符串一律 false，
 * 不抛错。
 */
export function isDayKey(value: string): boolean {
  if (typeof value !== 'string') return false
  const matched = DAY_KEY_PATTERN.exec(value)
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (year < MIN_YEAR || year > MAX_YEAR) return false
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/** 'YYYY-MM-DD' → 日历分量；非法输入抛错（RangeError / TypeError） */
export function parseDayKey(dk: DayKey): { year: number; month: number; day: number } {
  assertDayKeyText(dk)
  const matched = DAY_KEY_PATTERN.exec(dk)
  if (matched === null) {
    throw new RangeError(`DayKey 必须是 'YYYY-MM-DD' 形态，实得 '${dk}'`)
  }
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(`年份超出支持范围 ${MIN_YEAR}–${MAX_YEAR}，实得 ${year}`)
  }
  if (month < 1 || month > 12) {
    throw new RangeError(`月份超出 1–12，实得 ${month}（来自 '${dk}'）`)
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`日期超出该月天数，实得 ${day}（来自 '${dk}'）`)
  }
  return { year, month, day }
}

/** 日历分量 → 'YYYY-MM-DD'；不存在的日历日抛错，绝不静默溢出 */
export function makeDayKey(year: number, month: number, day: number): DayKey {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(`年份必须是 ${MIN_YEAR}–${MAX_YEAR} 的整数，实得 ${String(year)}`)
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`月份必须是 1–12 的整数，实得 ${String(month)}`)
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`日期必须是 1–${daysInMonth(year, month)} 的整数，实得 ${String(day)}`)
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 瞬间 → 归属日。ADR-001：结果在事件写入时固化，此后永不重算。
 *
 * 折算规则：按 `timeZone` 化为本地日历分量，取本地小时 h；
 * `h < dayStartHour` 时归属日 = 本地日期**减一天**，否则 = 本地日期。
 * `dayStartHour = 0` 时不平移（退化为自然日）。
 */
export function toDayKey(instant: Date, ctx: TimeContext): DayKey {
  assertInstant(instant)
  assertDayStartHour(ctx.dayStartHour)
  const parts = localParts(instant, ctx.timeZone)
  const dk = makeDayKey(parts.year, parts.month, parts.day)
  return ctx.dayStartHour > 0 && parts.hour < ctx.dayStartHour ? addDays(dk, -1) : dk
}

/** 取「今天」的归属日。`now` 必须显式传入——本模块不读系统时钟（ADR-009「理由」） */
export function today(ctx: TimeContext, now: Date): DayKey {
  return toDayKey(now, ctx)
}

/**
 * 日历日加减。`DayKey` 无时区含义，因此**不接触时区**，直接对日历分量运算——
 * 引入时区只会带来 DST 歧义。
 */
export function addDays(dk: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(dk)
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`加减天数必须是整数，实得 ${String(n)}`)
  }
  const shifted = dayKeyFromCalendarMs(calendarMs(year, month, day + n))
  if (!isDayKey(shifted)) {
    throw new RangeError(`加减 ${n} 天后超出支持的日期范围（${MIN_YEAR}–${MAX_YEAR} 年）：'${dk}'`)
  }
  return shifted
}

/** b - a（即 a → b 的日历天数），与 ADR-009 §4 的签名注释一致 */
export function diffDays(a: DayKey, b: DayKey): number {
  const from = parseDayKey(a)
  const to = parseDayKey(b)
  return (calendarMs(to.year, to.month, to.day) - calendarMs(from.year, from.month, from.day)) / MS_PER_DAY
}

/** 日历日比较：a < b 返回 -1，相等 0，a > b 返回 1 */
export function compareDayKey(a: DayKey, b: DayKey): -1 | 0 | 1 {
  const left = parseDayKey(a)
  const right = parseDayKey(b)
  const leftMs = calendarMs(left.year, left.month, left.day)
  const rightMs = calendarMs(right.year, right.month, right.day)
  if (leftMs < rightMs) return -1
  if (leftMs > rightMs) return 1
  return 0
}

/** 该周周一（周一返回自身）。自然周 = 周一至周日，全系统唯一口径 */
export function weekStart(dk: DayKey): DayKey {
  const { year, month, day } = parseDayKey(dk)
  // getUTCDay(): 0 = 周日 … 6 = 周六；换算成「距本周周一的天数」
  const weekday = new Date(calendarMs(year, month, day)).getUTCDay()
  const offsetFromMonday = (weekday + 6) % 7
  return offsetFromMonday === 0 ? dk : addDays(dk, -offsetFromMonday)
}

/** 该周周日 */
export function weekEnd(dk: DayKey): DayKey {
  return addDays(weekStart(dk), 6)
}

/** ≡ weekStart(dk)，可排序的稳定周标识 */
export function weekKey(dk: DayKey): DayKey {
  return weekStart(dk)
}

/** 归属日的起始瞬间 = 该日 dayStartHour:00（当地） */
export function dayStartInstant(dk: DayKey, ctx: TimeContext): Date {
  assertDayStartHour(ctx.dayStartHour)
  const { year, month, day } = parseDayKey(dk)
  return resolveLocalInstant(year, month, day, ctx.dayStartHour, 0, ctx.timeZone)
}

/**
 * 归属日的结束瞬间 = **次日** dayStartHour:00（当地）。
 * 即归属日区间是半开的 [dayStartInstant, dayEndInstant)。
 */
export function dayEndInstant(dk: DayKey, ctx: TimeContext): Date {
  return dayStartInstant(addDays(dk, 1), ctx)
}

/**
 * 界面上「9月21日」这类呈现集中在此，**不得**在组件里各自拼日期字符串（ADR-009 §6）。
 * 输出只用中文日历口径，且不随宿主 locale 变化——呈现必须是确定的。
 */
export function formatDayKey(dk: DayKey, style: 'short' | 'long' = 'short'): string {
  if (style !== 'short' && style !== 'long') {
    throw new RangeError(`style 只能是 'short' 或 'long'，实得 '${String(style)}'`)
  }
  const { year, month, day } = parseDayKey(dk)
  return style === 'long' ? `${year}年${month}月${day}日` : `${month}月${day}日`
}
