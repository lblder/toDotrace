/**
 * 时间戳格式化的唯一出口。
 *
 * ADR-008 §1：全部时间戳为 ISO 8601 带时区偏移的字符串（如 2026-09-21T14:03:00+08:00）。
 * 秒精度、不带毫秒——与 ADR 正文示例逐字符同形。
 *
 * 时刻比较一律走 Date.parse 得到的毫秒数，**不用字符串比较**：
 * 带偏移的 ISO 串只在偏移恒定时才字典序可比，跨 DST 换偏移就会出错。
 */

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** 把 Date 格式化为带本机时区偏移的 ISO 8601（秒精度）。 */
export function toIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  )
}

/** 当前时刻的 ISO 8601 字符串。 */
export function nowIso(): string {
  return toIso(new Date())
}

/** 当前时刻 + n 天的 ISO 8601 字符串。 */
export function isoAfterMs(ms: number): string {
  return toIso(new Date(Date.now() + ms))
}

/** 给定的 ISO 串是否已到期（无法解析视为已到期，宁可要求重新登录）。 */
export function isExpired(iso: string, nowMs: number = Date.now()): boolean {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return true
  return parsed <= nowMs
}
