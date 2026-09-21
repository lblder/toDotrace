/**
 * 时间戳显示：ADR-008 的时间一律是「ISO-8601 带偏移」的字符串，
 * 直接摆给用户看太吵，这里统一转成本地时区的「YYYY-MM-DD HH:mm」。
 *
 * 全天粒度（打卡日一类）的换算属于 @shared/time 的职责，不走这里——
 * 本模块只管「某个瞬间怎么显示」。
 */

const pad = (value: number): string => String(value).padStart(2, '0')

/** ISO-8601 → 「2026-09-21 14:30」（本地时区）。解析不了就原样返回，不编造。 */
export function formatInstant(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

/** 该瞬间是否已经过去。解析不了按「未过期」处理，宁可少报错。 */
export function isPastInstant(iso: string, now: number = Date.now()): boolean {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return false
  return at <= now
}
