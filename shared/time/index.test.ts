/**
 * ADR-009「后果」测试矩阵。
 *
 * 纪律：本文件的期望值全部来自**独立于实现的证据**（以 node 直接调 `Intl.DateTimeFormat`
 * 逐条核对过的 UTC 瞬间），不使用被测模块自证，也不使用 `toISOString().slice(0, 10)`
 * 一类 UTC 序列化切片当日本地日（02 §5 明令禁止）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DAY_START_HOUR,
  addDays,
  addMonths,
  addMonthsClamped,
  addYears,
  addYearsClamped,
  compareDayKey,
  dayEndInstant,
  dayStartInstant,
  daysInMonthOf,
  diffDays,
  formatDayKey,
  isDayKey,
  makeDayKey,
  parseDayKey,
  toDayKey,
  today,
  weekEnd,
  weekKey,
  weekStart,
  type TimeContext,
} from './index'

/** 时间上下文：与账号设置同形（ADR-009 §2） */
const SHANGHAI: TimeContext = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }
const SHANGHAI_NATURAL: TimeContext = { timeZone: 'Asia/Shanghai', dayStartHour: 0 }
const NEW_YORK: TimeContext = { timeZone: 'America/New_York', dayStartHour: 4 }
const NEW_YORK_NATURAL: TimeContext = { timeZone: 'America/New_York', dayStartHour: 0 }
/** +05:45，非整小时偏移；用来证伪任何「小时偏移是整数」的隐含假设 */
const KATHMANDU: TimeContext = { timeZone: 'Asia/Kathmandu', dayStartHour: 4 }
const KATHMANDU_NATURAL: TimeContext = { timeZone: 'Asia/Kathmandu', dayStartHour: 0 }

/** 瞬间字面量 → epoch 毫秒；避免在断言里比较对象引用 */
const t = (iso: string): number => new Date(iso).getTime()

const HOUR = 3_600_000

afterEach(() => {
  vi.useRealTimers()
})

describe('toDayKey · dayStartHour 边界（Asia/Shanghai，UTC+8，无 DST）', () => {
  // 本地 2026-09-21 03:59 = 2026-09-20T19:59Z
  it('本地 03:59 → 前一天', () => {
    expect(toDayKey(new Date('2026-09-20T19:59:00Z'), SHANGHAI)).toBe('2026-09-20')
  })

  it('本地 03:59:59.999 → 前一天（毫秒级不改变归属）', () => {
    expect(toDayKey(new Date('2026-09-20T19:59:59.999Z'), SHANGHAI)).toBe('2026-09-20')
  })

  it('本地 04:00 → 当天（边界为闭区间左端）', () => {
    expect(toDayKey(new Date('2026-09-20T20:00:00Z'), SHANGHAI)).toBe('2026-09-21')
  })

  it('本地 04:00:00.001 → 当天', () => {
    expect(toDayKey(new Date('2026-09-20T20:00:00.001Z'), SHANGHAI)).toBe('2026-09-21')
  })

  it('本地 23:59 → 当天（同一天的晚段）', () => {
    // 本地 2026-09-21 23:59 = 2026-09-21T15:59Z
    expect(toDayKey(new Date('2026-09-21T15:59:00Z'), SHANGHAI)).toBe('2026-09-21')
  })

  it('本地 12:00 → 当天', () => {
    expect(toDayKey(new Date('2026-09-21T04:00:00Z'), SHANGHAI)).toBe('2026-09-21')
  })
})

describe('toDayKey · 跨零点', () => {
  it('本地 00:00 且 dayStartHour=4 → 前一天', () => {
    expect(toDayKey(new Date('2026-09-20T16:00:00Z'), SHANGHAI)).toBe('2026-09-20')
  })

  it('本地 01:30 且 dayStartHour=4 → 前一天', () => {
    expect(toDayKey(new Date('2026-09-20T17:30:00Z'), SHANGHAI)).toBe('2026-09-20')
  })

  it('同一归属日横跨自然日零点：23:30 与次日 03:00 同属一天', () => {
    const lateEvening = toDayKey(new Date('2026-09-21T15:30:00Z'), SHANGHAI) // 本地 09-21 23:30
    const beforeDawn = toDayKey(new Date('2026-09-21T19:00:00Z'), SHANGHAI) // 本地 09-22 03:00
    expect(lateEvening).toBe('2026-09-21')
    expect(beforeDawn).toBe('2026-09-21')
  })

  it('04:00 整是归属日的切点：切点前后分属两日', () => {
    const before = toDayKey(new Date('2026-09-21T19:59:59.999Z'), SHANGHAI) // 本地 09-22 03:59:59.999
    const after = toDayKey(new Date('2026-09-21T20:00:00Z'), SHANGHAI) // 本地 09-22 04:00
    expect(before).toBe('2026-09-21')
    expect(after).toBe('2026-09-22')
  })
})

describe('toDayKey · dayStartHour=0 无偏移（退化为自然日）', () => {
  it('一天之内的任意小时都归当天', () => {
    const instants = [
      '2026-09-20T16:00:00Z', // 本地 09-21 00:00
      '2026-09-20T19:59:00Z', // 本地 09-21 03:59
      '2026-09-20T20:00:00Z', // 本地 09-21 04:00
      '2026-09-21T04:00:00Z', // 本地 09-21 12:00
      '2026-09-21T15:59:00Z', // 本地 09-21 23:59
    ]
    for (const iso of instants) {
      expect(toDayKey(new Date(iso), SHANGHAI_NATURAL)).toBe('2026-09-21')
    }
  })

  it('自然日边界：本地 23:59:59.999 与次日 00:00 分属两日', () => {
    expect(toDayKey(new Date('2026-09-20T15:59:59.999Z'), SHANGHAI_NATURAL)).toBe('2026-09-20')
    expect(toDayKey(new Date('2026-09-20T16:00:00Z'), SHANGHAI_NATURAL)).toBe('2026-09-21')
  })

  it('dayStartHour=0 与自然日折算等价（与 12:00 锚点无关）', () => {
    const noon = new Date('2026-09-21T04:00:00Z')
    expect(toDayKey(noon, SHANGHAI_NATURAL)).toBe('2026-09-21')
  })
})

describe('today · 显式传入 now（不读系统时钟）', () => {
  it('today(ctx, now) 恒等于 toDayKey(now, ctx)', () => {
    const now = new Date('2026-09-20T19:59:00Z')
    expect(today(SHANGHAI, now)).toBe(toDayKey(now, SHANGHAI))
    expect(today(SHANGHAI, now)).toBe('2026-09-20')
  })

  it('同一 now 在不同上下文下给出各自的归属日', () => {
    const now = new Date('2026-09-21T20:30:00Z')
    expect(today(SHANGHAI, now)).toBe('2026-09-22')
    expect(today(NEW_YORK, now)).toBe('2026-09-21')
  })
})

describe('时区一致性 · 同一瞬间在不同时区得到不同归属日', () => {
  it('2026-09-21T20:30Z：上海已跨入 09-22 凌晨，纽约仍是 09-21 下午', () => {
    const instant = new Date('2026-09-21T20:30:00Z')
    expect(toDayKey(instant, SHANGHAI)).toBe('2026-09-22') // 本地 09-22 04:30
    expect(toDayKey(instant, NEW_YORK)).toBe('2026-09-21') // 本地 09-21 16:30
    expect(toDayKey(instant, SHANGHAI)).not.toBe(toDayKey(instant, NEW_YORK))
  })

  it('2026-09-21T04:30Z：上海是 09-21 中午，纽约还在 09-20 深夜（dayStartHour=4 → 09-20）', () => {
    const instant = new Date('2026-09-21T04:30:00Z')
    expect(toDayKey(instant, SHANGHAI)).toBe('2026-09-21') // 本地 09-21 12:30
    expect(toDayKey(instant, NEW_YORK)).toBe('2026-09-20') // 本地 09-21 00:30
  })

  it('dayStartHour=0 时同一瞬间仍按时区各自归属（UTC 切片会给出第三种错误答案）', () => {
    const instant = new Date('2026-09-21T20:30:00Z')
    expect(toDayKey(instant, SHANGHAI_NATURAL)).toBe('2026-09-22')
    expect(toDayKey(instant, NEW_YORK_NATURAL)).toBe('2026-09-21')
  })
})

describe('非整小时偏移时区（Asia/Kathmandu +05:45）', () => {
  it('本地 2026-09-21 00:00 恰为 2026-09-20T18:15Z', () => {
    // dayStartHour=4：00:00 < 4 → 前一天
    expect(toDayKey(new Date('2026-09-20T18:15:00Z'), KATHMANDU)).toBe('2026-09-20')
    // dayStartHour=0：不平移 → 当天
    expect(toDayKey(new Date('2026-09-20T18:15:00Z'), KATHMANDU_NATURAL)).toBe('2026-09-21')
  })

  it('本地 2026-09-20 23:59:59 → 自然日口径下仍是 09-20', () => {
    expect(toDayKey(new Date('2026-09-20T18:14:59Z'), KATHMANDU_NATURAL)).toBe('2026-09-20')
  })

  it('dayStartInstant 落在非整小时偏移上（本地 04:00 = 2026-09-20T22:15Z）', () => {
    expect(dayStartInstant('2026-09-21', KATHMANDU).getTime()).toBe(t('2026-09-20T22:15:00Z'))
    expect(dayStartInstant('2026-09-21', KATHMANDU_NATURAL).getTime()).toBe(t('2026-09-20T18:15:00Z'))
  })
})

describe('dayStartInstant / dayEndInstant · 半开区间 [start, end)', () => {
  it('dayStartHour=4：归属日起于当日 04:00，止于次日 04:00', () => {
    expect(dayStartInstant('2026-09-21', SHANGHAI).getTime()).toBe(t('2026-09-20T20:00:00Z'))
    expect(dayEndInstant('2026-09-21', SHANGHAI).getTime()).toBe(t('2026-09-21T20:00:00Z'))
  })

  it('dayStartHour=0：归属日即自然日', () => {
    expect(dayStartInstant('2026-09-21', SHANGHAI_NATURAL).getTime()).toBe(t('2026-09-20T16:00:00Z'))
    expect(dayEndInstant('2026-09-21', SHANGHAI_NATURAL).getTime()).toBe(t('2026-09-21T16:00:00Z'))
  })

  it('dayEndInstant(dk) ≡ dayStartInstant(addDays(dk, 1))（止 = 次日 dayStartHour，不含端点）', () => {
    const dks = ['2026-01-01', '2026-03-07', '2026-03-08', '2026-09-21', '2026-12-31', '2028-02-29']
    for (const dk of dks) {
      for (const ctx of [SHANGHAI, SHANGHAI_NATURAL, NEW_YORK, NEW_YORK_NATURAL]) {
        expect(dayEndInstant(dk, ctx).getTime()).toBe(dayStartInstant(addDays(dk, 1), ctx).getTime())
      }
    }
  })

  it('区间左闭右开：起点归当日，终点前 1ms 归当日，终点归次日', () => {
    for (const ctx of [SHANGHAI, SHANGHAI_NATURAL, NEW_YORK, NEW_YORK_NATURAL]) {
      const start = dayStartInstant('2026-09-21', ctx)
      const end = dayEndInstant('2026-09-21', ctx)
      expect(toDayKey(start, ctx)).toBe('2026-09-21')
      expect(toDayKey(new Date(end.getTime() - 1), ctx)).toBe('2026-09-21')
      expect(toDayKey(end, ctx)).toBe('2026-09-22')
    }
  })
})

describe('DST · 春季跳变（America/New_York 2026-03-08，02:00 EST → 03:00 EDT）', () => {
  it('跳变前一日 04:00 是 EST（09:00Z），跳变当日 04:00 已是 EDT（08:00Z）', () => {
    expect(dayStartInstant('2026-03-07', NEW_YORK).getTime()).toBe(t('2026-03-07T09:00:00Z'))
    expect(dayStartInstant('2026-03-08', NEW_YORK).getTime()).toBe(t('2026-03-08T08:00:00Z'))
    expect(dayStartInstant('2026-03-09', NEW_YORK).getTime()).toBe(t('2026-03-09T08:00:00Z'))
  })

  it('跳变使 2026-03-07 只有 23 小时，而 2026-03-08 是 24 小时', () => {
    const d07 = dayEndInstant('2026-03-07', NEW_YORK).getTime() - dayStartInstant('2026-03-07', NEW_YORK).getTime()
    const d08 = dayEndInstant('2026-03-08', NEW_YORK).getTime() - dayStartInstant('2026-03-08', NEW_YORK).getTime()
    expect(d07).toBe(23 * HOUR)
    expect(d08).toBe(24 * HOUR)
  })

  it('dayStartHour=0 时凌晨零点仍被正确定位（正午锚点不因 23 小时的一天而偏移）', () => {
    expect(dayStartInstant('2026-03-07', NEW_YORK_NATURAL).getTime()).toBe(t('2026-03-07T05:00:00Z'))
    expect(dayStartInstant('2026-03-08', NEW_YORK_NATURAL).getTime()).toBe(t('2026-03-08T05:00:00Z'))
    expect(dayStartInstant('2026-03-09', NEW_YORK_NATURAL).getTime()).toBe(t('2026-03-09T04:00:00Z'))
    const d08 = dayEndInstant('2026-03-08', NEW_YORK_NATURAL).getTime() - dayStartInstant('2026-03-08', NEW_YORK_NATURAL).getTime()
    expect(d08).toBe(23 * HOUR)
  })

  it('不存在本地时刻（2026-03-08 02:00 被跳变吞掉）→ 定位到跳变瞬间 03:00 EDT', () => {
    const ctx: TimeContext = { timeZone: 'America/New_York', dayStartHour: 2 }
    expect(dayStartInstant('2026-03-08', ctx).getTime()).toBe(t('2026-03-08T07:00:00Z'))
    // 该瞬间本地为 03:00，仍属 2026-03-08，往返成立
    expect(toDayKey(dayStartInstant('2026-03-08', ctx), ctx)).toBe('2026-03-08')
  })

  it('04:00 切点跨过跳变空洞：03:59:59 EDT 归前一日，04:00 EDT 归当日', () => {
    // 跳变把本地 02:00–02:59 整段吞掉，但切点 04:00 依然精确
    expect(toDayKey(new Date('2026-03-08T06:59:00Z'), NEW_YORK)).toBe('2026-03-07') // 本地 01:59 EST
    expect(toDayKey(new Date('2026-03-08T07:59:59Z'), NEW_YORK)).toBe('2026-03-07') // 本地 03:59:59 EDT
    expect(toDayKey(new Date('2026-03-08T08:00:00Z'), NEW_YORK)).toBe('2026-03-08') // 本地 04:00 EDT
  })

  it('切点落在空洞内（dayStartHour=2）时，归属日在跳变瞬间翻页', () => {
    const ctx: TimeContext = { timeZone: 'America/New_York', dayStartHour: 2 }
    expect(toDayKey(new Date('2026-03-08T06:59:00Z'), ctx)).toBe('2026-03-07') // 本地 01:59 EST
    expect(toDayKey(new Date('2026-03-08T07:00:00Z'), ctx)).toBe('2026-03-08') // 本地 03:00 EDT（02:00 不存在）
  })

  it('addDays 跨跳变日仍是纯日历日', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDays('2026-03-09', -1)).toBe('2026-03-08')
  })
})

describe('DST · 秋季回拨（America/New_York 2026-11-01，02:00 EDT → 01:00 EST）', () => {
  it('回拨前一日 04:00 是 EDT（08:00Z），回拨当日 04:00 已是 EST（09:00Z）', () => {
    expect(dayStartInstant('2026-10-31', NEW_YORK).getTime()).toBe(t('2026-10-31T08:00:00Z'))
    expect(dayStartInstant('2026-11-01', NEW_YORK).getTime()).toBe(t('2026-11-01T09:00:00Z'))
  })

  it('回拨使 2026-10-31 有 25 小时，而 2026-11-01 是 24 小时', () => {
    const d31 = dayEndInstant('2026-10-31', NEW_YORK).getTime() - dayStartInstant('2026-10-31', NEW_YORK).getTime()
    const d01 = dayEndInstant('2026-11-01', NEW_YORK).getTime() - dayStartInstant('2026-11-01', NEW_YORK).getTime()
    expect(d31).toBe(25 * HOUR)
    expect(d01).toBe(24 * HOUR)
  })

  it('dayStartHour=0 时凌晨零点仍被正确定位（25 小时的一天不偏移）', () => {
    expect(dayStartInstant('2026-11-01', NEW_YORK_NATURAL).getTime()).toBe(t('2026-11-01T04:00:00Z')) // 00:00 EDT
    expect(dayStartInstant('2026-11-02', NEW_YORK_NATURAL).getTime()).toBe(t('2026-11-02T05:00:00Z')) // 00:00 EST
    const d01 = dayEndInstant('2026-11-01', NEW_YORK_NATURAL).getTime() - dayStartInstant('2026-11-01', NEW_YORK_NATURAL).getTime()
    expect(d01).toBe(25 * HOUR)
  })

  it('重复出现的本地 01:30 两个瞬间同属一天（回拨不制造额外归属日）', () => {
    expect(toDayKey(new Date('2026-11-01T05:30:00Z'), NEW_YORK)).toBe('2026-10-31') // 01:30 EDT
    expect(toDayKey(new Date('2026-11-01T06:30:00Z'), NEW_YORK)).toBe('2026-10-31') // 01:30 EST
  })

  it('重复的本地时刻取较早的一次（05:00Z，EDT 那次）', () => {
    const ctx: TimeContext = { timeZone: 'America/New_York', dayStartHour: 1 }
    expect(dayStartInstant('2026-11-01', ctx).getTime()).toBe(t('2026-11-01T05:00:00Z'))
  })

  it('04:00 边界跨过回拨：08:59Z 归 10-31，09:00Z 归 11-01', () => {
    expect(toDayKey(new Date('2026-11-01T08:59:59.999Z'), NEW_YORK)).toBe('2026-10-31')
    expect(toDayKey(new Date('2026-11-01T09:00:00Z'), NEW_YORK)).toBe('2026-11-01')
  })

  it('addDays 跨回拨日仍是纯日历日', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
  })
})

describe('DST 安全 · 全年逐日往返（正午锚点的核心性质）', () => {
  const contexts: TimeContext[] = [
    SHANGHAI,
    SHANGHAI_NATURAL,
    NEW_YORK,
    NEW_YORK_NATURAL,
    // dayStartHour=2 在 America/New_York 2026-03-08 落在跳变空洞里，是最难的一天
    { timeZone: 'America/New_York', dayStartHour: 2 },
    { timeZone: 'America/New_York', dayStartHour: 23 },
  ]

  it('2026 全年每一天：起止瞬间往返折算回同一 dayKey', () => {
    let dk = '2026-01-01'
    for (let i = 0; i < 365; i += 1) {
      for (const ctx of contexts) {
        const start = dayStartInstant(dk, ctx)
        const end = dayEndInstant(dk, ctx)
        expect(end.getTime()).toBeGreaterThan(start.getTime())
        expect(toDayKey(start, ctx)).toBe(dk)
        expect(toDayKey(new Date(start.getTime() + 1), ctx)).toBe(dk)
        expect(toDayKey(new Date(end.getTime() - 1), ctx)).toBe(dk)
        expect(toDayKey(new Date(Math.floor((start.getTime() + end.getTime()) / 2)), ctx)).toBe(dk)
      }
      dk = addDays(dk, 1)
    }
    expect(dk).toBe('2027-01-01')
  })

  it('2028 闰年全年（含 02-29）同样成立', () => {
    let dk = '2028-01-01'
    for (let i = 0; i < 366; i += 1) {
      for (const ctx of contexts) {
        expect(toDayKey(dayStartInstant(dk, ctx), ctx)).toBe(dk)
        expect(toDayKey(new Date(dayEndInstant(dk, ctx).getTime() - 1), ctx)).toBe(dk)
      }
      dk = addDays(dk, 1)
    }
    expect(dk).toBe('2029-01-01')
  })
})

describe('addDays / diffDays / compareDayKey · 纯日历算术（不接触时区）', () => {
  it('addDays 基本推进与回退', () => {
    expect(addDays('2026-09-21', 0)).toBe('2026-09-21')
    expect(addDays('2026-09-21', 1)).toBe('2026-09-22')
    expect(addDays('2026-09-21', -1)).toBe('2026-09-20')
    expect(addDays('2026-09-21', 10)).toBe('2026-10-01')
    expect(addDays('2026-09-21', -30)).toBe('2026-08-22')
  })

  it('跨月跨年', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01')
  })

  it('跨年推进 365 天', () => {
    expect(addDays('2026-01-15', 365)).toBe('2027-01-15')
    expect(addDays('2028-01-15', 366)).toBe('2029-01-15')
  })

  it('diffDays 按 ADR-009 §4 的注释口径：返回 b - a（即 a → b 的方向）', () => {
    expect(diffDays('2026-09-21', '2026-09-21')).toBe(0)
    expect(diffDays('2026-09-21', '2026-09-24')).toBe(3)
    expect(diffDays('2026-09-24', '2026-09-21')).toBe(-3)
    expect(diffDays('2026-01-01', '2027-01-01')).toBe(365)
    expect(diffDays('2028-01-01', '2029-01-01')).toBe(366)
    expect(diffDays('2025-12-31', '2026-01-01')).toBe(1)
  })

  it('diffDays 与 addDays 互逆', () => {
    for (let n = -400; n <= 400; n += 7) {
      expect(diffDays('2026-09-21', addDays('2026-09-21', n))).toBe(n)
    }
  })

  it('compareDayKey 返回 -1 / 0 / 1', () => {
    expect(compareDayKey('2026-09-21', '2026-09-21')).toBe(0)
    expect(compareDayKey('2026-09-20', '2026-09-21')).toBe(-1)
    expect(compareDayKey('2026-09-22', '2026-09-21')).toBe(1)
    expect(compareDayKey('2025-12-31', '2026-01-01')).toBe(-1)
    expect(compareDayKey('0001-01-01', '9999-12-31')).toBe(-1)
  })

  it('逐日推进严格单调，且 diffDays 与推进次数一致', () => {
    let dk = '2026-01-01'
    let prev = dk
    for (let i = 1; i <= 400; i += 1) {
      dk = addDays('2026-01-01', i)
      expect(compareDayKey(prev, dk)).toBe(-1)
      expect(diffDays('2026-01-01', dk)).toBe(i)
      prev = dk
    }
  })
})

describe('闰年与世纪', () => {
  it('addDays 跨闰日', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28')
  })

  it('格里高利闰年规则：4 年一闰、100 年不闰、400 年又闰', () => {
    expect(isDayKey('2028-02-29')).toBe(true)
    expect(isDayKey('2027-02-29')).toBe(false)
    expect(isDayKey('2000-02-29')).toBe(true) // 400 的倍数 → 闰
    expect(isDayKey('2100-02-29')).toBe(false) // 100 的倍数但非 400 → 不闰
    expect(isDayKey('1900-02-29')).toBe(false)
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01')
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29')
  })

  it('diffDays 跨闰年得到 366 天', () => {
    expect(diffDays('2028-02-28', '2029-02-28')).toBe(366)
    expect(diffDays('2027-02-28', '2028-02-28')).toBe(365)
  })

  it('四位年下界同样往返正确（Date.UTC 的 0–99 年偏置不得泄漏）', () => {
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01')
    expect(addDays('0100-01-01', -1)).toBe('0099-12-31')
    expect(toDayKey(dayStartInstant('0050-01-01', SHANGHAI), SHANGHAI)).toBe('0050-01-01')
  })
})

describe('自然周 · 周一至周日（全系统唯一口径）', () => {
  it('周一返回自身', () => {
    expect(weekStart('2026-09-21')).toBe('2026-09-21') // 2026-09-21 是周一
    expect(weekStart('2026-08-31')).toBe('2026-08-31')
    expect(weekStart('2026-12-28')).toBe('2026-12-28')
  })

  it('周日返回其周一（不是次日）', () => {
    expect(weekStart('2026-09-27')).toBe('2026-09-21')
    expect(weekStart('2026-09-20')).toBe('2026-09-14')
  })

  it('一周七天共享同一 weekStart，weekEnd 为周日', () => {
    const days = [
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]
    for (const dk of days) {
      expect(weekStart(dk)).toBe('2026-09-21')
      expect(weekEnd(dk)).toBe('2026-09-27')
    }
    expect(weekEnd('2026-09-21')).toBe(addDays('2026-09-21', 6))
  })

  it('跨月的周', () => {
    expect(weekStart('2026-09-06')).toBe('2026-08-31') // 周日，属 08-31~09-06 那一周
    expect(weekEnd('2026-08-31')).toBe('2026-09-06')
    expect(weekStart('2026-09-01')).toBe('2026-08-31')
  })

  it('跨年的周', () => {
    expect(weekStart('2027-01-03')).toBe('2026-12-28') // 2027-01-03 是周日
    expect(weekEnd('2026-12-28')).toBe('2027-01-03')
    expect(weekStart('2027-01-01')).toBe('2026-12-28')
  })

  it('weekKey ≡ weekStart，可作稳定可排序的周标识', () => {
    expect(weekKey('2026-09-21')).toBe(weekStart('2026-09-21'))
    expect(weekKey('2026-09-27')).toBe(weekStart('2026-09-27'))
    expect(compareDayKey(weekKey('2026-09-21'), weekKey('2026-09-28'))).toBe(-1)
  })

  it('全年任意一天：weekStart 是周一、weekEnd 是周日、weekEnd = weekStart + 6', () => {
    let dk = '2026-01-01'
    for (let i = 0; i < 365; i += 1) {
      const start = weekStart(dk)
      const end = weekEnd(dk)
      expect(daysFromMonday(start)).toBe(0)
      expect(daysFromMonday(end)).toBe(6)
      expect(end).toBe(addDays(start, 6))
      expect(compareDayKey(start, dk)).toBeLessThanOrEqual(0)
      expect(compareDayKey(dk, end)).toBeLessThanOrEqual(0)
      dk = addDays(dk, 1)
    }
  })

  it('周与 dayStartHour / 时区无关（DayKey 已无时区含义）', () => {
    // weekStart 只吃 DayKey，不接受 TimeContext：签名本身即约束
    expect(weekStart('2026-09-27')).toBe('2026-09-21')
  })
})

/** 0 = 周一 … 6 = 周日（测试侧独立实现，不复用被测模块的周函数） */
function daysFromMonday(dk: string): number {
  const [y, m, d] = dk.split('-').map(Number) as [number, number, number]
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

describe('isDayKey / parseDayKey / makeDayKey', () => {
  it('接受合法的 YYYY-MM-DD', () => {
    for (const dk of ['2026-09-21', '2026-01-01', '2026-12-31', '2028-02-29', '2000-02-29', '0001-01-01', '9999-12-31']) {
      expect(isDayKey(dk)).toBe(true)
    }
  })

  it('拒绝格式不符与不存在的日历日', () => {
    const invalid = [
      '',
      '2026-9-21',
      '2026-09-2',
      '26-09-21',
      '2026/09/21',
      '20260921',
      '2026-09-21T00:00:00Z',
      '2026-09-21 ',
      ' 2026-09-21',
      '2026-09-32',
      '2026-00-10',
      '2026-13-01',
      '2026-02-30',
      '2027-02-29',
      '2100-02-29',
      '2026-04-31',
      '2026-09-00',
      'abcd-ef-gh',
      'not a date',
      '-2026-09-21',
      '2026-09-21-',
    ]
    for (const value of invalid) {
      expect(isDayKey(value)).toBe(false)
    }
  })

  it('非字符串输入返回 false（校验面向导入文件等不可信输入）', () => {
    for (const value of [undefined, null, 123, {}, [], true, new Date()]) {
      expect(isDayKey(value as unknown as string)).toBe(false)
    }
  })

  it('parseDayKey 拆出日历分量', () => {
    expect(parseDayKey('2026-09-21')).toEqual({ year: 2026, month: 9, day: 21 })
    expect(parseDayKey('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 })
    expect(parseDayKey('0001-01-01')).toEqual({ year: 1, month: 1, day: 1 })
  })

  it('parseDayKey 不缓存、不共享可变对象', () => {
    const a = parseDayKey('2026-09-21')
    a.day = 1
    expect(parseDayKey('2026-09-21')).toEqual({ year: 2026, month: 9, day: 21 })
  })

  it('parseDayKey 拒绝非法输入', () => {
    expect(() => parseDayKey('2026-02-30')).toThrow(RangeError)
    expect(() => parseDayKey('2026-9-21')).toThrow(RangeError)
    expect(() => parseDayKey(123 as unknown as string)).toThrow(TypeError)
  })

  it('makeDayKey 补零到四位年 / 两位月日', () => {
    expect(makeDayKey(2026, 9, 21)).toBe('2026-09-21')
    expect(makeDayKey(2026, 9, 1)).toBe('2026-09-01')
    expect(makeDayKey(2026, 1, 5)).toBe('2026-01-05')
    expect(makeDayKey(50, 1, 1)).toBe('0050-01-01')
  })

  it('makeDayKey ↔ parseDayKey 往返恒等', () => {
    for (const dk of ['2026-09-21', '2028-02-29', '2026-01-01', '2026-12-31']) {
      const { year, month, day } = parseDayKey(dk)
      expect(makeDayKey(year, month, day)).toBe(dk)
      expect(isDayKey(dk)).toBe(true)
    }
  })

  it('makeDayKey 拒绝不存在的日历日与非整数', () => {
    expect(() => makeDayKey(2026, 2, 30)).toThrow(RangeError)
    expect(() => makeDayKey(2027, 2, 29)).toThrow(RangeError)
    expect(() => makeDayKey(2100, 2, 29)).toThrow(RangeError)
    expect(() => makeDayKey(2026, 13, 1)).toThrow(RangeError)
    expect(() => makeDayKey(2026, 0, 1)).toThrow(RangeError)
    expect(() => makeDayKey(2026, 9, 0)).toThrow(RangeError)
    expect(() => makeDayKey(2026, 9, 31)).toThrow(RangeError)
    expect(() => makeDayKey(2026.5, 9, 1)).toThrow(RangeError)
    expect(() => makeDayKey(2026, 9.5, 1)).toThrow(RangeError)
    expect(() => makeDayKey(0, 1, 1)).toThrow(RangeError)
    expect(() => makeDayKey(10000, 1, 1)).toThrow(RangeError)
    expect(() => makeDayKey(2026, 9, Number.NaN)).toThrow(RangeError)
  })
})

describe('formatDayKey', () => {
  it('short：月日（默认）', () => {
    expect(formatDayKey('2026-09-21')).toBe('9月21日')
    expect(formatDayKey('2026-09-21', 'short')).toBe('9月21日')
  })

  it('long：含年', () => {
    expect(formatDayKey('2026-09-21', 'long')).toBe('2026年9月21日')
  })

  it('不补零（呈现层口径，非机器可读格式）', () => {
    expect(formatDayKey('2026-01-05')).toBe('1月5日')
    expect(formatDayKey('2026-01-05', 'long')).toBe('2026年1月5日')
  })

  it('非法 DayKey 与非法 style 一律拒绝，不在组件里静默拼字符串', () => {
    expect(() => formatDayKey('2026-9-21')).toThrow(RangeError)
    expect(() => formatDayKey('2026-09-21', 'medium' as 'short')).toThrow(RangeError)
  })
})

describe('纯函数与重放安全', () => {
  it('固定 (instant, ctx) 反复调用结果恒等', () => {
    const instant = new Date('2026-09-20T19:59:00Z')
    const first = toDayKey(instant, SHANGHAI)
    for (let i = 0; i < 5; i += 1) {
      expect(toDayKey(instant, SHANGHAI)).toBe(first)
    }
    expect(first).toBe('2026-09-20')
  })

  it('不修改传入的 Date 与 TimeContext', () => {
    const instant = new Date('2026-09-20T19:59:00Z')
    const before = instant.getTime()
    const ctx: TimeContext = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }
    const snapshot = JSON.stringify(ctx)
    toDayKey(instant, ctx)
    dayStartInstant('2026-09-21', ctx)
    weekStart('2026-09-21')
    expect(instant.getTime()).toBe(before)
    expect(JSON.stringify(ctx)).toBe(snapshot)
  })

  it('冻结的上下文也能用（任何写入都会在严格模式下抛错）', () => {
    const frozen = Object.freeze({ timeZone: 'Asia/Shanghai', dayStartHour: 4 })
    expect(toDayKey(new Date('2026-09-20T19:59:00Z'), frozen)).toBe('2026-09-20')
    expect(dayStartInstant('2026-09-21', frozen).getTime()).toBe(t('2026-09-20T20:00:00Z'))
  })

  it('无隐藏时钟：伪造系统时间不改变任何结果（重放确定性的前提）', () => {
    const instant = new Date('2026-09-20T19:59:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })

    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    const early = {
      dayKey: toDayKey(instant, SHANGHAI),
      start: dayStartInstant('2026-09-21', SHANGHAI).getTime(),
      week: weekStart('2026-09-21'),
      fmt: formatDayKey('2026-09-21'),
    }

    vi.setSystemTime(new Date('2035-06-01T00:00:00Z'))
    expect(toDayKey(instant, SHANGHAI)).toBe(early.dayKey)
    expect(dayStartInstant('2026-09-21', SHANGHAI).getTime()).toBe(early.start)
    expect(weekStart('2026-09-21')).toBe(early.week)
    expect(formatDayKey('2026-09-21')).toBe(early.fmt)
  })

  it('相等的上下文（不同对象实例）给出相同结果', () => {
    const a: TimeContext = { timeZone: 'America/New_York', dayStartHour: 4 }
    const b: TimeContext = { timeZone: 'America/New_York', dayStartHour: 4 }
    const instant = new Date('2026-11-01T06:30:00Z')
    expect(toDayKey(instant, a)).toBe(toDayKey(instant, b))
  })

  it('默认 dayStartHour 常量为 4（与 ADR-009 §2 一致）', () => {
    expect(DEFAULT_DAY_START_HOUR).toBe(4)
  })
})

describe('非法输入', () => {
  it('Invalid Date 被拒绝', () => {
    expect(() => toDayKey(new Date(Number.NaN), SHANGHAI)).toThrow(RangeError)
    expect(() => today(SHANGHAI, new Date(Number.NaN))).toThrow(RangeError)
  })

  it('非 Date 的 instant 被拒绝', () => {
    expect(() => toDayKey('2026-09-21' as unknown as Date, SHANGHAI)).toThrow(TypeError)
  })

  it('dayStartHour 必须为 0–23 的整数', () => {
    for (const dayStartHour of [-1, 24, 4.5, Number.NaN, 100]) {
      const ctx: TimeContext = { timeZone: 'Asia/Shanghai', dayStartHour }
      expect(() => toDayKey(new Date('2026-09-21T04:00:00Z'), ctx)).toThrow(RangeError)
      expect(() => dayStartInstant('2026-09-21', ctx)).toThrow(RangeError)
    }
  })

  it('非法时区被拒绝（不静默退回 UTC）', () => {
    const ctx: TimeContext = { timeZone: 'Not/AZone', dayStartHour: 4 }
    expect(() => toDayKey(new Date('2026-09-21T04:00:00Z'), ctx)).toThrow(RangeError)
    expect(() => dayStartInstant('2026-09-21', ctx)).toThrow(RangeError)
  })

  it('addDays 的 n 必须为整数', () => {
    expect(() => addDays('2026-09-21', 1.5)).toThrow(RangeError)
    expect(() => addDays('2026-09-21', Number.NaN)).toThrow(RangeError)
    expect(() => addDays('2026-09-21', Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('算术与格式化入口一律校验 DayKey', () => {
    expect(() => addDays('2026-2-30' as string, 1)).toThrow(RangeError)
    expect(() => diffDays('2026-02-30', '2026-03-01')).toThrow(RangeError)
    expect(() => compareDayKey('2026-09-21', 'oops')).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// ADR-009 §8（v1.1 补）：月 / 年算术
// 夹取与非夹取两个都提供、不替调用方选；抛错支与夹取支都要有证据。
// ---------------------------------------------------------------------------

describe('daysInMonthOf · 月长', () => {
  it('各月天数', () => {
    expect(daysInMonthOf('2026-01-15')).toBe(31)
    expect(daysInMonthOf('2026-02-15')).toBe(28)
    expect(daysInMonthOf('2026-04-15')).toBe(30)
    expect(daysInMonthOf('2026-12-15')).toBe(31)
  })

  it('闰年 2 月 = 29', () => {
    expect(daysInMonthOf('2024-02-15')).toBe(29)
    expect(daysInMonthOf('2028-02-15')).toBe(29)
    expect(daysInMonthOf('2027-02-15')).toBe(28)
  })

  it('世纪年写死：1900 年 2 月 = 28、2000 年 2 月 = 29（格里高利规则）', () => {
    expect(daysInMonthOf('1900-02-15')).toBe(28)
    expect(daysInMonthOf('2000-02-15')).toBe(29)
    expect(daysInMonthOf('2100-02-15')).toBe(28)
    expect(daysInMonthOf('2400-02-15')).toBe(29)
  })

  it('与 dayKey 所在月份一致（不因日号不同而变）', () => {
    expect(daysInMonthOf('2026-02-01')).toBe(daysInMonthOf('2026-02-28'))
  })

  it('非法 DayKey 抛错', () => {
    expect(() => daysInMonthOf('2026-02-30')).toThrow(RangeError)
    expect(() => daysInMonthOf('2026-13-01')).toThrow(RangeError)
    expect(() => daysInMonthOf('2026-2-1')).toThrow(RangeError)
    expect(() => daysInMonthOf('oops')).toThrow(RangeError)
  })
})

describe('§8 抛错支 · addMonths / addYears 不静默夹取', () => {
  it('addMonths：目标日在该月不存在 → RangeError', () => {
    expect(() => addMonths('2026-01-31', 1)).toThrow(RangeError) // 2026-02-31 不存在
    expect(() => addMonths('2026-03-31', -1)).toThrow(RangeError) // 2026-02-31 不存在
    expect(() => addMonths('2026-08-31', 1)).toThrow(RangeError) // 2026-09-31 不存在
    expect(() => addMonths('2026-05-31', 1)).toThrow(RangeError) // 2026-06-31 不存在
    expect(() => addMonths('2024-02-29', 12)).toThrow(RangeError) // 2025-02-29 不存在
  })

  it('addYears：2 月 29 日加到平年 → RangeError', () => {
    expect(() => addYears('2028-02-29', 1)).toThrow(RangeError) // 2029-02-29 不存在
    expect(() => addYears('2028-02-29', 2)).toThrow(RangeError)
    expect(() => addYears('2028-02-29', 3)).toThrow(RangeError)
  })

  it('合法目标日照常返回（抛错支不是「一律拒绝」）', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15')
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31')
    expect(addMonths('2026-01-31', 12)).toBe('2027-01-31')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-31') // ADR 矩阵的负向用例
    expect(addYears('2028-02-29', 4)).toBe('2032-02-29') // 4 年后仍是闰年
    expect(addYears('2026-09-21', 1)).toBe('2027-09-21')
    expect(addYears('2026-09-21', -1)).toBe('2025-09-21')
  })
})

describe('§8 夹取支 · addMonthsClamped / addYearsClamped', () => {
  it('月夹取到该月最后一天', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29') // 闰年
    expect(addMonthsClamped('2026-05-31', 1)).toBe('2026-06-30')
    expect(addMonthsClamped('2026-03-30', -1)).toBe('2026-02-28')
    expect(addMonthsClamped('2026-05-31', -3)).toBe('2026-02-28')
    expect(addMonthsClamped('2026-12-31', 2)).toBe('2027-02-28')
  })

  it('不需要夹取时与 addMonths 结果相同', () => {
    expect(addMonthsClamped('2026-01-31', 2)).toBe('2026-03-31')
    expect(addMonthsClamped('2026-01-31', 12)).toBe('2027-01-31')
    expect(addMonthsClamped('2026-01-31', -1)).toBe('2025-12-31')
    expect(addMonthsClamped('2026-01-15', 1)).toBe('2026-02-15')
  })

  it('年夹取到该年该月最后一天', () => {
    expect(addYearsClamped('2028-02-29', 1)).toBe('2029-02-28')
    expect(addYearsClamped('2028-02-29', 4)).toBe('2032-02-29')
    expect(addYearsClamped('2028-02-29', 2)).toBe('2030-02-28')
    expect(addYearsClamped('2026-09-21', 1)).toBe('2027-09-21')
    expect(addYearsClamped('2026-02-28', 1)).toBe('2027-02-28')
  })

  it('世纪年夹取：2000-02-29 加 100 年 → 2100-02-28（2100 非闰），加 400 年 → 2400-02-29', () => {
    expect(addYearsClamped('2000-02-29', 100)).toBe('2100-02-28')
    expect(addYearsClamped('2000-02-29', 400)).toBe('2400-02-29')
  })

  it('夹取不可逆：先加后减会停在夹取点（重复模块需知）', () => {
    expect(addMonthsClamped(addMonthsClamped('2026-01-31', 1), -1)).toBe('2026-01-28')
    expect(addYearsClamped(addYearsClamped('2028-02-29', 1), -1)).toBe('2028-02-28')
  })

  it('结果恒为合法 DayKey，且日号 = min(原日号, 目标月月长)', () => {
    const starts = ['2024-01-31', '2026-01-31', '2026-03-31', '2026-05-31', '2028-02-29', '2027-02-28', '2026-12-31']
    for (const dk of starts) {
      for (let n = -25; n <= 25; n += 1) {
        const result = addMonthsClamped(dk, n)
        expect(isDayKey(result)).toBe(true)
        const origin = parseDayKey(dk)
        const moved = parseDayKey(result)
        const expectedMonth = (((origin.month - 1 + n) % 12) + 12) % 12 + 1
        const expectedYear = origin.year + Math.floor((origin.month - 1 + n) / 12)
        expect(moved.year).toBe(expectedYear)
        expect(moved.month).toBe(expectedMonth)
        expect(moved.day).toBe(Math.min(origin.day, daysInMonthOf(result)))
      }
    }
  })
})

describe('§8 零与负', () => {
  it('n = 0 时四个函数均返回原值（含 addYears*）', () => {
    for (const dk of ['2026-09-21', '2026-01-31', '2028-02-29', '2026-12-31', '0001-01-01']) {
      expect(addMonths(dk, 0)).toBe(dk)
      expect(addYears(dk, 0)).toBe(dk)
      expect(addMonthsClamped(dk, 0)).toBe(dk)
      expect(addYearsClamped(dk, 0)).toBe(dk)
    }
  })

  it('负向跨年', () => {
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-31')
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01')
    expect(addMonthsClamped('2026-01-31', -1)).toBe('2025-12-31')
    expect(addYears('2026-01-01', -1)).toBe('2025-01-01')
    expect(addYearsClamped('2026-03-01', -1)).toBe('2025-03-01')
  })

  it('±12 个月 ≡ ±1 年（两族函数在各自口径下一致）', () => {
    const dks = ['2026-09-21', '2026-01-31', '2028-02-29', '2026-12-31', '2026-02-28']
    for (const dk of dks) {
      expect(addMonthsClamped(dk, 12)).toBe(addYearsClamped(dk, 1))
      expect(addMonthsClamped(dk, -12)).toBe(addYearsClamped(dk, -1))
      // 抛错支：两边要么都得同一个值，要么都抛（用结果比对，不吞异常）
      const monthOutcome = outcomeOf(() => addMonths(dk, 12))
      const yearOutcome = outcomeOf(() => addYears(dk, 1))
      expect(monthOutcome).toBe(yearOutcome)
    }
  })
})

/** 把「返回值或抛错」压成可比较的字符串，用于断言两族函数口径一致 */
function outcomeOf(action: () => string): string {
  try {
    return `ok:${action()}`
  } catch (error) {
    return `throw:${(error as Error).constructor.name}`
  }
}

describe('§8 范围与参数校验', () => {
  it('越过 0001–9999 年范围抛错', () => {
    expect(() => addMonths('9999-12-15', 1)).toThrow(RangeError)
    expect(() => addYears('9999-01-01', 1)).toThrow(RangeError)
    expect(() => addMonths('0001-01-15', -1)).toThrow(RangeError)
    expect(() => addYears('0001-01-01', -1)).toThrow(RangeError)
    expect(() => addMonthsClamped('9999-12-15', 1)).toThrow(RangeError)
    expect(() => addYearsClamped('9999-06-15', 1)).toThrow(RangeError)
  })

  it('n 必须为整数', () => {
    for (const n of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addMonths('2026-01-15', n)).toThrow(RangeError)
      expect(() => addYears('2026-01-15', n)).toThrow(RangeError)
      expect(() => addMonthsClamped('2026-01-15', n)).toThrow(RangeError)
      expect(() => addYearsClamped('2026-01-15', n)).toThrow(RangeError)
    }
  })

  it('入口一律校验 DayKey', () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-1', 'oops']) {
      expect(() => addMonths(bad, 1)).toThrow(RangeError)
      expect(() => addYears(bad, 1)).toThrow(RangeError)
      expect(() => addMonthsClamped(bad, 1)).toThrow(RangeError)
      expect(() => addYearsClamped(bad, 1)).toThrow(RangeError)
      expect(() => daysInMonthOf(bad)).toThrow(RangeError)
    }
  })

  it('纯函数恒等：固定入参反复调用结果恒等', () => {
    const first = addMonthsClamped('2026-01-31', 14)
    for (let i = 0; i < 5; i += 1) {
      expect(addMonthsClamped('2026-01-31', 14)).toBe(first)
      expect(addMonths('2026-01-15', 14)).toBe(addMonths('2026-01-15', 14))
      expect(addYearsClamped('2028-02-29', 1)).toBe('2029-02-28')
    }
  })
})
