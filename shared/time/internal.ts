/**
 * 时间口径内部工具 —— **不对外导出**（ADR-009 §1）。
 *
 * 这里放着全模块唯一碰时区的地方，以及 ADR-009「理由」一节要求的**正午锚点**：
 * 凡需要把墙钟时刻落成真实瞬间，一律经由 12:00 附近推导。切换发生在凌晨，
 * 正午远离任何切换点，因此「23 小时的一天」与「25 小时的一天」都不会让日期算错。
 *
 * 零依赖：只用 `Intl.DateTimeFormat` 与内建 `Date`。
 * 禁止 `toISOString().slice(0, 10)` 一类 UTC 序列化切片当日本地日（02 §5 明令）。
 */

const MS_PER_SECOND = 1000
export const MS_PER_DAY = 86_400_000

/** 格里高利历 400 年 = 146097 天，闰年规则在这 400 年里完全重复 */
const DAYS_PER_400_YEARS = 146_097
const MS_PER_400_YEARS = DAYS_PER_400_YEARS * MS_PER_DAY

/** 时区墙钟分量（当地日历 + 当地时刻） */
export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/**
 * 格式化器缓存。缓存的键与值都是确定性的（同一时区必得同一格式化器），
 * 它不是隐藏输入：给定相同入参，本模块的输出与缓存状态无关。
 * 缓存只为免去每次折算都重新构造 `Intl.DateTimeFormat` 的开销。
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23：本地零点给出 00 而不是 24，避免整日错位
    hourCycle: 'h23',
  })
  formatters.set(timeZone, created)
  return created
}

function readPart(parts: Intl.DateTimeFormatPart[], type: string): number {
  const part = parts.find((candidate) => candidate.type === type)
  if (part === undefined) throw new RangeError(`本地时间分量缺失：${type}`)
  return Number(part.value)
}

/** 瞬间 → 指定时区的墙钟分量 */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const hour = readPart(parts, 'hour')
  if (hour < 0 || hour > 23) {
    // 出现 24（h24 口径）会让归属日整体错一天——宁可炸，不可静默错
    throw new RangeError(`本地小时越界（期望 0–23，实得 ${hour}），hourCycle 未被尊重`)
  }
  return {
    year: readPart(parts, 'year'),
    month: readPart(parts, 'month'),
    day: readPart(parts, 'day'),
    hour,
    minute: readPart(parts, 'minute'),
    second: readPart(parts, 'second'),
  }
}

/**
 * 日历分量 → 「墙钟毫秒」：把当地日历分量按 UTC 读出来的毫秒数。
 * 它不是绝对瞬间，而是**无时区的日历坐标**，用于日历算术与偏移推导。
 *
 * 内建 `Date.UTC` 会把 0–99 年映射到 1900+y，故对四位年下界做 400 年同构平移
 * （格里高利 400 年闰年规则完全重复），保证 0001–9999 全程正确。
 */
export function calendarMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return year >= 0 && year <= 99
    ? Date.UTC(year + 400, month - 1, day, hour, minute, second, 0) - MS_PER_400_YEARS
    : Date.UTC(year, month - 1, day, hour, minute, second, 0)
}

/** 「墙钟毫秒」→ 'YYYY-MM-DD'（四位年） */
export function dayKeyFromCalendarMs(wallClockMs: number): string {
  const instant = new Date(wallClockMs)
  const year = String(instant.getUTCFullYear()).padStart(4, '0')
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0')
  const day = String(instant.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 某瞬间在该时区的偏移毫秒数（东为正）。
 * 只到秒——`localParts` 的分辨率就是秒，毫秒部分不属于日历分量。
 */
export function offsetMsAt(epochMs: number, timeZone: string): number {
  const parts = localParts(new Date(epochMs), timeZone)
  const wallClock = calendarMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
  return wallClock - Math.floor(epochMs / MS_PER_SECOND) * MS_PER_SECOND
}

/**
 * 墙钟时刻（当地 y-m-d h:m）→ 真实瞬间。DST 安全：
 *
 * 1. 以目标时刻的**正午锚点**为基准探测跳变前后的两个偏移（±24 小时取样，
 *    任何时区都不会在 24 小时内切换两次偏移）；
 * 2. 用两个候选偏移各推一个瞬间，取能**精确回读**成目标墙钟的那个；
 * 3. 两个候选都精确时（秋季回拨的重复小时）取**较早**的一次；
 * 4. 两个都不精确时说明目标墙钟落在**春季跳变的空洞**里，取空洞结束的瞬间
 *    （当地时钟跳过它的那一刻）。
 */
export function resolveLocalInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = calendarMs(year, month, day, hour, minute, 0)
  const offsetBefore = offsetMsAt(target - MS_PER_DAY, timeZone)
  const offsetAfter = offsetMsAt(target + MS_PER_DAY, timeZone)

  const candidates =
    offsetBefore === offsetAfter ? [target - offsetBefore] : [target - offsetBefore, target - offsetAfter]

  let earliest = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const parts = localParts(new Date(candidate), timeZone)
    const wallClock = calendarMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
    if (wallClock === target && candidate < earliest) earliest = candidate
  }
  if (earliest !== Number.POSITIVE_INFINITY) return new Date(earliest)

  return new Date(target - offsetBefore)
}

/** 某年某月的天数（格里高利闰年规则：4 年一闰、100 年不闰、400 年又闰） */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year)) throw new RangeError(`年份必须是整数，实得 ${String(year)}`)
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`月份必须是 1–12 的整数，实得 ${String(month)}`)
  }
  const monthLength = calendarMs(year, month + 1, 1) - calendarMs(year, month, 1)
  return monthLength / MS_PER_DAY
}

/** dayStartHour 必须是 0–23 的整数（ADR-009 §2） */
export function assertDayStartHour(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new RangeError(`dayStartHour 必须是 0–23 的整数，实得 ${String(value)}`)
  }
}
