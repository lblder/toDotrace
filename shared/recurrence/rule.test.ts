/**
 * 规则校验的测试矩阵（ADR-011 §2）。
 *
 * §2 的立场是「既然声称与 RRULE 直译，就必须遵守 RRULE 的语法约束」——
 * 因为违反约束的规则导出时会**静默失真**（`count` 与 `until` 并存只能丢掉一个）。
 * 故每一条约束都配一条「必须被拒」的用例，而不只是测「合法值能通过」。
 */
import { describe, expect, it } from 'vitest'

import {
  RecurrenceRuleError,
  assertValidRule,
  assertValidTemplate,
  normalizeRule,
  validateRule,
  validateTemplate,
} from './index'
import type { RecurrenceRule } from './index'

const STARTS_ON = '2026-01-05' // 周一

function codesOf(rule: unknown, startsOn: unknown = STARTS_ON): string[] {
  return validateRule(rule, startsOn).map((violation) => violation.code)
}

describe('validateRule · 合法规则', () => {
  it('daily：只给 freq 与 interval', () => {
    expect(validateRule({ freq: 'daily', interval: 1 }, STARTS_ON)).toEqual([])
  })

  it('weekly + byDayOfWeek（0=周一 … 6=周日）', () => {
    expect(validateRule({ freq: 'weekly', interval: 1, byDayOfWeek: [0, 2, 6] }, STARTS_ON)).toEqual([])
  })

  it('monthly + byMonthDay，含 -1（月末）与 31', () => {
    expect(validateRule({ freq: 'monthly', interval: 1, byMonthDay: [-1] }, STARTS_ON)).toEqual([])
    expect(validateRule({ freq: 'monthly', interval: 1, byMonthDay: [1, 15, 31] }, STARTS_ON)).toEqual([])
    expect(validateRule({ freq: 'monthly', interval: 1, byMonthDay: [1, -1] }, STARTS_ON)).toEqual([])
  })

  it('yearly：不带任何 BY*（§2：命中日 = starts_on 的月日）', () => {
    expect(validateRule({ freq: 'yearly', interval: 1 }, STARTS_ON)).toEqual([])
  })

  it('count 单独出现', () => {
    expect(validateRule({ freq: 'daily', interval: 1, count: 7 }, STARTS_ON)).toEqual([])
  })

  it('until 单独出现，且 == starts_on 时合法（§2：until 含当日）', () => {
    expect(validateRule({ freq: 'daily', interval: 1, until: '2026-03-01' }, STARTS_ON)).toEqual([])
    expect(validateRule({ freq: 'daily', interval: 1, until: STARTS_ON }, STARTS_ON)).toEqual([])
  })
})

describe('validateRule · interval ≥ 1（§2）', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('interval = %s 被拒', (interval) => {
    expect(codesOf({ freq: 'daily', interval })).toContain('invalid-interval')
  })

  it('interval 缺失被拒', () => {
    expect(codesOf({ freq: 'daily' })).toContain('invalid-interval')
  })

  it('interval = 1 通过（下界是闭的）', () => {
    expect(codesOf({ freq: 'daily', interval: 1 })).not.toContain('invalid-interval')
  })
})

describe('validateRule · count 与 until 互斥（§2，RRULE 的 MUST NOT）', () => {
  it('二者并存被拒', () => {
    expect(codesOf({ freq: 'daily', interval: 1, count: 3, until: '2026-03-01' })).toContain(
      'count-until-exclusive',
    )
  })

  it('互斥是**独立于**其它字段的约束：freq 同时非法也要报出来', () => {
    const codes = codesOf({ freq: 'hourly', interval: 1, count: 3, until: '2026-03-01' })
    expect(codes).toContain('invalid-freq')
    expect(codes).toContain('count-until-exclusive')
  })

  it('count = 0 / 负数 / 小数被拒', () => {
    expect(codesOf({ freq: 'daily', interval: 1, count: 0 })).toContain('invalid-count')
    expect(codesOf({ freq: 'daily', interval: 1, count: -3 })).toContain('invalid-count')
    expect(codesOf({ freq: 'daily', interval: 1, count: 2.5 })).toContain('invalid-count')
  })
})

describe('validateRule · until ≥ starts_on（§4 的推导以它为前提）', () => {
  it('until 早于 starts_on 被拒', () => {
    expect(codesOf({ freq: 'daily', interval: 1, until: '2026-01-04' })).toContain('until-before-starts-on')
  })

  it('until 差一天（2026-01-04 vs starts_on = 2026-01-05）也被拒——边界是闭的', () => {
    expect(codesOf({ freq: 'daily', interval: 1, until: '2026-01-04' }, '2026-01-05')).toContain(
      'until-before-starts-on',
    )
  })

  it('不存在的日历日（2026-02-30 / 2027-02-29）被拒，不静默溢出', () => {
    expect(codesOf({ freq: 'daily', interval: 1, until: '2026-02-30' })).toContain('invalid-until')
    expect(codesOf({ freq: 'daily', interval: 1, until: '2027-02-29' })).toContain('invalid-until')
  })
})

describe('validateRule · byMonthDay ∈ 1..31 ∪ {-1}（§2）', () => {
  it.each([0, 32, -2, 1.5, Number.NaN])('byMonthDay 含 %s 被拒', (value) => {
    expect(codesOf({ freq: 'monthly', interval: 1, byMonthDay: [value] })).toContain('invalid-by-month-day')
  })

  it('空数组被拒', () => {
    expect(codesOf({ freq: 'monthly', interval: 1, byMonthDay: [] })).toContain('invalid-by-month-day')
  })

  it('1 与 31 是闭区间端点，-1 是月末哨兵，三者都合法', () => {
    for (const value of [1, 31, -1]) {
      expect(codesOf({ freq: 'monthly', interval: 1, byMonthDay: [value] })).not.toContain('invalid-by-month-day')
    }
  })

  it('byMonthDay 仅 monthly 使用（§2）——给 weekly 会被拒而不是静默忽略', () => {
    expect(codesOf({ freq: 'weekly', interval: 1, byMonthDay: [1] })).toContain('by-part-not-allowed-for-freq')
  })

  it('byMonthDay 给 yearly 会被拒（§2 把 yearly 的命中日定义为 starts_on 的月日）', () => {
    expect(codesOf({ freq: 'yearly', interval: 1, byMonthDay: [1] })).toContain('by-part-not-allowed-for-freq')
  })
})

describe('validateRule · byDayOfWeek ∈ 0..6（0 = 周一）（§2）', () => {
  it.each([-1, 7, 1.5])('byDayOfWeek 含 %s 被拒', (value) => {
    expect(codesOf({ freq: 'weekly', interval: 1, byDayOfWeek: [value] })).toContain('invalid-by-day-of-week')
  })

  it('byDayOfWeek 仅 weekly 使用（§2）', () => {
    expect(codesOf({ freq: 'monthly', interval: 1, byDayOfWeek: [0] })).toContain('by-part-not-allowed-for-freq')
    expect(codesOf({ freq: 'daily', interval: 1, byDayOfWeek: [0] })).toContain('by-part-not-allowed-for-freq')
  })
})

describe('validateRule · starts_on（相位原点，ADR-011 §1 / §3）', () => {
  it('非法 starts_on 被拒', () => {
    expect(codesOf({ freq: 'daily', interval: 1 }, '2026-02-30')).toContain('invalid-starts-on')
    expect(codesOf({ freq: 'daily', interval: 1 }, 'not-a-date')).toContain('invalid-starts-on')
    expect(codesOf({ freq: 'daily', interval: 1 }, 20260105)).toContain('invalid-starts-on')
  })

  it('starts_on 非法时不连带报 until 早于 starts_on（避免第二条假错）', () => {
    const codes = codesOf({ freq: 'daily', interval: 1, until: '2026-01-05' }, 'bad')
    expect(codes).toContain('invalid-starts-on')
    expect(codes).not.toContain('until-before-starts-on')
  })
})

describe('validateRule · 一次报出全部违规', () => {
  it('多处违规一次说完，而不是只报第一条', () => {
    const codes = codesOf(
      { freq: 'hourly', interval: 0, count: 0, until: '2026-01-01', byDayOfWeek: [9], byMonthDay: [0] },
      '2026-02-30',
    )
    for (const expected of [
      'invalid-freq',
      'invalid-interval',
      'invalid-count',
      'invalid-starts-on',
      'invalid-by-day-of-week',
      'invalid-by-month-day',
    ]) {
      expect(codes).toContain(expected)
    }
  })

  it('rule 不是对象时直接返回单条违规', () => {
    expect(validateRule(null, STARTS_ON)).toHaveLength(1)
    expect(codesOf(undefined)).toEqual(['not-an-object'])
  })
})

describe('validateTemplate · nextAnchorMode（ADR-011 §1 / §5）', () => {
  // 形状照抄 ADR-011 §4 冻结的 `RecurrenceTemplate`（8 个字段，不加不减）
  const base = {
    id: 'tpl-1',
    accountId: 'acc-1',
    title: '喝水',
    rule: { freq: 'daily', interval: 1 },
    nextAnchorMode: 'catch_up',
    startsOn: STARTS_ON,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it.each(['extend', 'catch_up', 'recompute'])('三种锚点模式都合法：%s', (mode) => {
    expect(validateTemplate({ ...base, nextAnchorMode: mode })).toEqual([])
  })

  it('未知锚点模式被拒（模板表的 CHECK 约束同款）', () => {
    expect(validateTemplate({ ...base, nextAnchorMode: 'skip' }).map((v) => v.code)).toContain(
      'invalid-anchor-mode',
    )
  })

  it('空 id 被拒', () => {
    expect(validateTemplate({ ...base, id: '', nextAnchorMode: 'extend' }).map((v) => v.code)).toContain(
      'invalid-template-id',
    )
  })

  it('accountId / createdAt / updatedAt 不参与校验（服务端从会话与时钟填，非客户端输入）', () => {
    expect(validateTemplate({ ...base, accountId: '', createdAt: '', updatedAt: '' })).toEqual([])
  })

  it('模板校验会连带校验规则（单一入口）', () => {
    const codes = validateTemplate({
      ...base,
      rule: { freq: 'weekly', interval: 1, byMonthDay: [1] },
      nextAnchorMode: 'extend',
    }).map((v) => v.code)
    expect(codes).toContain('by-part-not-allowed-for-freq')
  })
})

describe('assertValidRule / assertValidTemplate', () => {
  it('合法时不抛', () => {
    expect(() => assertValidRule({ freq: 'daily', interval: 1 }, STARTS_ON)).not.toThrow()
  })

  it('不合法时抛 RecurrenceRuleError，且 violations 是全部违规', () => {
    try {
      assertValidRule({ freq: 'daily', interval: 0, count: 2, until: '2026-02-01' }, STARTS_ON)
      throw new Error('本应抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(RecurrenceRuleError)
      const violations = (error as RecurrenceRuleError).violations
      expect(violations.map((v) => v.code)).toEqual(
        expect.arrayContaining(['invalid-interval', 'count-until-exclusive']),
      )
      expect((error as RecurrenceRuleError).code).toBe('recurrence/invalid-rule')
    }
  })

  it('模板不合法同样抛错', () => {
    expect(() =>
      assertValidTemplate({
        id: 'tpl-1',
        accountId: 'acc-1',
        title: 'x',
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'nope',
        startsOn: STARTS_ON,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow(RecurrenceRuleError)
  })
})

describe('normalizeRule · 去重 + 升序（命中集合的升序生成依赖它）', () => {
  it('byDayOfWeek 去重并升序：[4, 0, 4] → [0, 4]', () => {
    const normalized = normalizeRule({ freq: 'weekly', interval: 1, byDayOfWeek: [4, 0, 4] })
    expect(normalized.byDayOfWeek).toEqual([0, 4])
  })

  it('byMonthDay 去重并升序：[31, 1, -1, 1] → [-1, 1, 31]', () => {
    const normalized = normalizeRule({ freq: 'monthly', interval: 1, byMonthDay: [31, 1, -1, 1] })
    expect(normalized.byMonthDay).toEqual([-1, 1, 31])
  })

  it('不改动入参', () => {
    const rule: RecurrenceRule = { freq: 'weekly', interval: 1, byDayOfWeek: [4, 0] }
    normalizeRule(rule)
    expect(rule.byDayOfWeek).toEqual([4, 0])
  })

  it('缺省字段不凭空补上（避免把「未给」变成「给了空」）', () => {
    const normalized = normalizeRule({ freq: 'daily', interval: 2 })
    expect(normalized).toEqual({ freq: 'daily', interval: 2 })
    expect('count' in normalized).toBe(false)
    expect('until' in normalized).toBe(false)
  })
})
