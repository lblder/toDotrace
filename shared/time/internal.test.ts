/**
 * `internal.ts` 的测试：时区折算原语与正午锚点。
 *
 * 这些工具不对外导出（ADR-009 §1），但它们是全模块 DST 安全性的所在地，
 * 因此与公开函数同等要求证据。期望值同样来自独立核对过的 UTC 瞬间。
 */
import { describe, expect, it } from 'vitest'

import { calendarMs, dayKeyFromCalendarMs, daysInMonth, localParts, offsetMsAt, resolveLocalInstant } from './internal'

const HOUR = 3_600_000
const DAY = 86_400_000
const t = (iso: string): number => new Date(iso).getTime()

describe('localParts · 本地日历分量', () => {
  it('取上海本地分量（UTC+8 无 DST）', () => {
    expect(localParts(new Date('2026-09-20T19:59:00Z'), 'Asia/Shanghai')).toEqual({
      year: 2026,
      month: 9,
      day: 21,
      hour: 3,
      minute: 59,
      second: 0,
    })
  })

  it('本地零点的小时是 00 而不是 24（h23 口径）', () => {
    expect(localParts(new Date('2026-09-21T04:00:00Z'), 'America/New_York').hour).toBe(0)
    expect(localParts(new Date('2026-09-20T16:00:00Z'), 'Asia/Shanghai').hour).toBe(0)
  })

  it('跳变后的小时正确（2026-03-08T07:00Z 纽约已是 03:00 EDT）', () => {
    expect(localParts(new Date('2026-03-08T07:00:00Z'), 'America/New_York')).toEqual({
      year: 2026,
      month: 3,
      day: 8,
      hour: 3,
      minute: 0,
      second: 0,
    })
    expect(localParts(new Date('2026-03-08T06:59:59Z'), 'America/New_York').hour).toBe(1)
  })

  it('秒级精度不丢失（用于推导偏移）', () => {
    expect(localParts(new Date('2026-11-01T06:30:45Z'), 'America/New_York')).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 45,
    })
  })
})

describe('offsetMsAt · 时区偏移', () => {
  it('整小时偏移', () => {
    expect(offsetMsAt(t('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * HOUR)
    expect(offsetMsAt(t('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * HOUR)
    expect(offsetMsAt(t('2026-09-21T04:00:00Z'), 'Asia/Shanghai')).toBe(8 * HOUR)
    expect(offsetMsAt(t('2026-09-21T04:00:00Z'), 'UTC')).toBe(0)
  })

  it('非整小时偏移（Asia/Kathmandu +05:45）', () => {
    expect(offsetMsAt(t('2026-09-21T04:00:00Z'), 'Asia/Kathmandu')).toBe(5 * HOUR + 45 * 60_000)
  })

  it('跳变瞬间两侧偏移不同（2026-03-08T07:00Z 是纽约的分界）', () => {
    expect(offsetMsAt(t('2026-03-08T06:59:59Z'), 'America/New_York')).toBe(-5 * HOUR)
    expect(offsetMsAt(t('2026-03-08T07:00:00Z'), 'America/New_York')).toBe(-4 * HOUR)
  })

  it('回拨瞬间两侧偏移不同（2026-11-01T06:00Z 是纽约的分界）', () => {
    expect(offsetMsAt(t('2026-11-01T05:59:59Z'), 'America/New_York')).toBe(-4 * HOUR)
    expect(offsetMsAt(t('2026-11-01T06:00:00Z'), 'America/New_York')).toBe(-5 * HOUR)
  })
})

describe('resolveLocalInstant · 本地墙钟时刻 → 瞬间（正午锚点）', () => {
  it('常规时刻', () => {
    expect(resolveLocalInstant(2026, 9, 21, 4, 0, 'Asia/Shanghai').getTime()).toBe(t('2026-09-20T20:00:00Z'))
    expect(resolveLocalInstant(2026, 9, 21, 0, 0, 'Asia/Shanghai').getTime()).toBe(t('2026-09-20T16:00:00Z'))
    expect(resolveLocalInstant(2026, 9, 21, 4, 0, 'Asia/Kathmandu').getTime()).toBe(t('2026-09-20T22:15:00Z'))
    expect(resolveLocalInstant(2026, 9, 21, 12, 0, 'UTC').getTime()).toBe(t('2026-09-21T12:00:00Z'))
  })

  it('正午锚点在跳变日两侧都成立', () => {
    expect(resolveLocalInstant(2026, 3, 8, 12, 0, 'America/New_York').getTime()).toBe(t('2026-03-08T16:00:00Z'))
    expect(resolveLocalInstant(2026, 11, 1, 12, 0, 'America/New_York').getTime()).toBe(t('2026-11-01T17:00:00Z'))
  })

  it('跳变日上仍能定位存在的墙钟时刻（01:00 EST / 03:00 EDT）', () => {
    expect(resolveLocalInstant(2026, 3, 8, 1, 0, 'America/New_York').getTime()).toBe(t('2026-03-08T06:00:00Z'))
    expect(resolveLocalInstant(2026, 3, 8, 3, 0, 'America/New_York').getTime()).toBe(t('2026-03-08T07:00:00Z'))
    expect(resolveLocalInstant(2026, 11, 1, 2, 0, 'America/New_York').getTime()).toBe(t('2026-11-01T07:00:00Z'))
  })

  it('不存在的墙钟时刻（春季空洞）落到跳变瞬间，不产生错误的日期', () => {
    // 2026-03-08 02:00 被 02:00→03:00 的跳变吞掉
    expect(resolveLocalInstant(2026, 3, 8, 2, 0, 'America/New_York').getTime()).toBe(t('2026-03-08T07:00:00Z'))
    // 结果仍在 2026-03-08
    const resolved = resolveLocalInstant(2026, 3, 8, 2, 0, 'America/New_York')
    expect(localParts(resolved, 'America/New_York').day).toBe(8)
    expect(localParts(resolved, 'America/New_York').hour).toBe(3)
  })

  it('重复的墙钟时刻（秋季重叠）取较早的一次', () => {
    // 2026-11-01 01:00 出现两次：05:00Z（EDT）与 06:00Z（EST）
    expect(resolveLocalInstant(2026, 11, 1, 1, 0, 'America/New_York').getTime()).toBe(t('2026-11-01T05:00:00Z'))
    expect(resolveLocalInstant(2026, 11, 1, 1, 30, 'America/New_York').getTime()).toBe(t('2026-11-01T05:30:00Z'))
  })

  it('四位年下界不因 Date.UTC 的 0–99 偏置而算错', () => {
    // 上海在 1901 年前用 LMT +08:05:43
    const instant = resolveLocalInstant(50, 1, 1, 12, 0, 'Asia/Shanghai')
    expect(localParts(instant, 'Asia/Shanghai').year).toBe(50)
    expect(localParts(instant, 'Asia/Shanghai').hour).toBe(12)
    expect(localParts(instant, 'UTC').year).toBe(50)
  })
})

describe('正午锚点的普适性：全球各时区全年正午都能被精确定位', () => {
  // 覆盖：北半球常规 DST、南半球、半夜跳变、30 分钟 DST、非整小时标准偏移
  const zones = [
    'America/New_York',
    'Europe/London',
    'Asia/Shanghai',
    'America/Santiago',
    'Australia/Lord_Howe',
    'Pacific/Chatham',
    'Asia/Kathmandu',
  ]

  it('2026 年每一天的当地 12:00 都存在且回读一致', () => {
    for (const zone of zones) {
      let dk = '2026-01-01'
      for (let i = 0; i < 365; i += 1) {
        const [year, month, day] = dk.split('-').map(Number) as [number, number, number]
        const instant = resolveLocalInstant(year, month, day, 12, 0, zone)
        const parts = localParts(instant, zone)
        expect(`${zone} ${dk} ${parts.hour}`).toBe(`${zone} ${dk} 12`)
        expect(parts.year).toBe(year)
        expect(parts.month).toBe(month)
        expect(parts.day).toBe(day)
        dk = dayKeyFromCalendarMs(calendarMs(year, month, day) + DAY)
      }
    }
  })
})

describe('calendarMs / dayKeyFromCalendarMs · 日历分量与毫秒的互转', () => {
  it('同日内递增', () => {
    expect(calendarMs(2026, 9, 21) < calendarMs(2026, 9, 22)).toBe(true)
    expect(calendarMs(2026, 9, 21, 3, 59) < calendarMs(2026, 9, 21, 4, 0)).toBe(true)
  })

  it('闰日存在：2028-02-29 与 2028-02-28 相距一天', () => {
    expect(calendarMs(2028, 3, 1) - calendarMs(2028, 2, 28)).toBe(2 * DAY)
    expect(calendarMs(2027, 3, 1) - calendarMs(2027, 2, 28)).toBe(DAY)
  })

  it('世纪闰年规则不被 0–99 年平移破坏（平移必须保持 400 年同构）', () => {
    expect(calendarMs(50, 3, 1) - calendarMs(50, 2, 28)).toBe(DAY) // 50 非闰年
    expect(calendarMs(52, 3, 1) - calendarMs(52, 2, 28)).toBe(2 * DAY) // 52 闰年
    expect(calendarMs(100, 1, 1) - calendarMs(99, 12, 31)).toBe(DAY) // 跨 99→100
  })

  it('dayKeyFromCalendarMs 回读日历日', () => {
    expect(dayKeyFromCalendarMs(calendarMs(2026, 9, 21, 23, 59))).toBe('2026-09-21')
    expect(dayKeyFromCalendarMs(calendarMs(2028, 2, 29))).toBe('2028-02-29')
    expect(dayKeyFromCalendarMs(calendarMs(50, 1, 1))).toBe('0050-01-01')
  })
})

describe('daysInMonth · 格里高利闰年规则', () => {
  it('各月天数', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('闰年：4 年一闰、100 年不闰、400 年又闰', () => {
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2027, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
    expect(daysInMonth(2100, 2)).toBe(28)
  })

  it('非法月份与年份被拒绝', () => {
    expect(() => daysInMonth(2026, 0)).toThrow(RangeError)
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError)
    expect(() => daysInMonth(2026, 1.5)).toThrow(RangeError)
  })
})
