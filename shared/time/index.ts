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
  MAX_RENDERABLE_INSTANT_MS,
  MIN_RENDERABLE_INSTANT_MS,
  MS_PER_DAY,
  assertDayStartHour,
  calendarMs,
  dayKeyFromCalendarMs,
  daysInMonth,
  localParts,
  offsetMsAt,
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

// --- §8 月 / 年算术（v1.1 补）---------------------------------------------
// 夹取与非夹取**两个都提供，不替调用方选**：夹取与否是业务口径，不是日期算术的性质。
// 抛错版的存在理由与 §7 一致——静默夹取会污染数据；想要夹取的调用方必须显式写出来。

function assertMonthCount(n: number): void {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`月 / 年增量必须是整数，实得 ${String(n)}`)
  }
}

/** 年月分量整体平移 n 个月（只动年月，不校验日号） */
function shiftYearMonth(year: number, month: number, n: number): { year: number; month: number } {
  const totalMonths = year * 12 + (month - 1) + n
  const movedYear = Math.floor(totalMonths / 12)
  return { year: movedYear, month: totalMonths - movedYear * 12 + 1 }
}

/** 该 dayKey 所在月份的天数（28/29/30/31） */
export function daysInMonthOf(dk: DayKey): number {
  const { year, month } = parseDayKey(dk)
  return daysInMonth(year, month)
}

/**
 * 加 N 个自然月。**目标日在该月不存在时抛 `RangeError`**（如 2026-01-31 加 1 月），
 * 绝不静默夹取——要夹取请显式用 `addMonthsClamped`。
 */
export function addMonths(dk: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(dk)
  assertMonthCount(n)
  const target = shiftYearMonth(year, month, n)
  return makeDayKey(target.year, target.month, day)
}

/** 加 N 个自然年。2 月 29 日加到平年时抛 `RangeError`，同 `addMonths` */
export function addYears(dk: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(dk)
  assertMonthCount(n)
  return makeDayKey(year + n, month, day)
}

/** 按「夹取到该月最后一天」的惯例加 N 个月 —— 重复模块应当使用的那个 */
export function addMonthsClamped(dk: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(dk)
  assertMonthCount(n)
  const target = shiftYearMonth(year, month, n)
  return makeDayKey(target.year, target.month, Math.min(day, daysInMonth(target.year, target.month)))
}

/** 同上，年粒度：2028-02-29 加 1 年 → 2029-02-28 */
export function addYearsClamped(dk: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(dk)
  assertMonthCount(n)
  const targetYear = year + n
  return makeDayKey(targetYear, month, Math.min(day, daysInMonth(targetYear, month)))
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

/** 两位补零（月 / 日 / 时 / 分 / 秒） */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 四位补零（年）。年域 0001–9999 已在入口拦掉，故不会出现 5 位年份 */
function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

/**
 * 偏移取整到整分，**半值远离零**（对称）。
 *
 * 与 `Math.round` 的差别只在恰好 :30 秒的偏移上：`Math.round(-17.5)` 得 -17（向 +∞），
 * 而这里得 -18，与正向的 +18 对称。见 `toIsoInZone` 的整分取舍。
 */
function roundToMinute(offsetMs: number): number {
  const minutes = offsetMs / 60_000
  return minutes < 0 ? -Math.round(-minutes) : Math.round(minutes)
}

/**
 * 把瞬间渲染成**以 `timeZone` 为偏移**的 ISO 8601 串（ADR-009 §9，v1.2）。
 *
 * 偏移是该瞬间在该时区的**实际偏移**（含 DST），不是常量；墙钟与偏移取自**同一个瞬间**。
 * 全程不碰进程时区——这是 ADR-010 §1 的要求（进程时区不进入任何持久化数据）。
 *
 * 语义边界（§9 已钉死，逐条有测试）：
 *
 * - **整分渲染**：1972 年前的 LMT 偏移不是整分钟（`Europe/Amsterdam` 1880 年为
 *   `+00:17:30`），渲染为 `+00:18`，**差 30 秒**——该取舍由 §9 显式记录，当前不可达；
 * - **秒精度**：毫秒被截断（ADR-010 §1 的 `occurred_at` 同为此形态）；
 * - **年域与 DayKey 同界**（0001–9999）：界外抛 `RangeError`（理由见 `internal.ts` 的常量注释）；
 * - **时区名大小写不敏感**（`Intl` 会规范化）；判据是「`Intl` **无法解析**」而非
 *   「与 IANA 注册表逐字不符」，故 `asia/shanghai` 合法而 `Not/AZone` 抛 `RangeError`。
 *
 * @param instant 待渲染的瞬间（`Invalid Date` 抛 `RangeError`）
 * @param timeZone IANA 时区名，即输出串尾部偏移的取处
 * @throws RangeError 当 `instant` 非法 / 超出 0001–9999，或 `timeZone` 无法解析
 */
export function toIsoInZone(instant: Date, timeZone: string): string {
  const ms = instant.getTime()
  if (Number.isNaN(ms)) {
    throw new RangeError('toIsoInZone：Invalid Date 无法渲染')
  }
  if (ms < MIN_RENDERABLE_INSTANT_MS || ms > MAX_RENDERABLE_INSTANT_MS) {
    throw new RangeError(`toIsoInZone：瞬间超出可渲染的年域（0001–9999）：${instant.toISOString()}`)
  }

  const parts = localParts(instant, timeZone)
  const offsetMinutes = roundToMinute(offsetMsAt(ms, timeZone))
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)

  const date = `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`
  const time = `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
  const offset = `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  return `${date}T${time}${offset}`
}
