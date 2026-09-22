/**
 * 三锚点的测试矩阵（ADR-011 §5）。
 *
 * 本文件的第一条用例是**逐字复现 ADR-011 §5 的算例**：
 * `P = 1/5（周一）`、`T = 1/14（周三）`、`byDayOfWeek:[0]` 时 ②=1/19、③=1/26。
 * 它同时钉住三件事：
 * 1. ① 与 ② 的差别（沿用原相位 vs 追赶到今天之后）；
 * 2. **③ ≠ ②**（③ 从完成日加一整个间隔后再对齐，而不是「取 > T 的第一个命中日」
 *    ——后者会让 ③ 塌陷成 ②，把三锚点变成两锚点）；
 * 3. 锚点必须是**命中日**：③ 若写成 `T + I` 会得到 1/21（周三），那是本规则的非法日。
 *
 * 下半段（monthly / yearly）依赖 ADR-009 §8 的月 / 年算术（已落地）。
 */
import { describe, expect, it } from 'vitest'

import { RecurrenceRuleError, addOneInterval, nextAnchorDate, shouldPromptOverdue } from './index'
import type { AnchorInput, NextAnchorMode, RecurrenceRule } from './index'

function anchor(
  mode: NextAnchorMode,
  rule: RecurrenceRule,
  startsOn: string,
  plannedDate: string,
  completedDayKey: string,
): string | null {
  const input: AnchorInput = { rule, startsOn, plannedDate, completedDayKey }
  return nextAnchorDate(mode, input)
}

describe('ADR-011 §5 的算例：weekly + byDayOfWeek:[0]，P = 1/5（周一），T = 1/14（周三）', () => {
  const rule: RecurrenceRule = { freq: 'weekly', interval: 1, byDayOfWeek: [0] }
  const startsOn = '2026-01-05'

  it('① extend = 从 P 推进一次 = 1/12（沿用原相位，故仍 ≤ T）', () => {
    expect(anchor('extend', rule, startsOn, '2026-01-05', '2026-01-14')).toBe('2026-01-12')
  })

  it('② catch_up = 从 P 逐步推进直到 > T = 1/19', () => {
    expect(anchor('catch_up', rule, startsOn, '2026-01-05', '2026-01-14')).toBe('2026-01-19')
  })

  it('③ recompute = 候选 1/21 → 向上对齐到第一个命中日 = 1/26（**不等于 ②**）', () => {
    expect(anchor('recompute', rule, startsOn, '2026-01-05', '2026-01-14')).toBe('2026-01-26')
  })

  it('③ 的候选确实是 T + 一周 = 1/21，而它**不是**命中日（故必须对齐）', () => {
    expect(addOneInterval(rule, '2026-01-14')).toBe('2026-01-21')
    expect(anchor('recompute', rule, startsOn, '2026-01-05', '2026-01-14')).not.toBe('2026-01-21')
  })

  it('三锚点两两不同（若 ③ 实现成「取 > T 的第一个命中日」则 ③ 会等于 ②）', () => {
    const extend = anchor('extend', rule, startsOn, '2026-01-05', '2026-01-14')
    const catchUp = anchor('catch_up', rule, startsOn, '2026-01-05', '2026-01-14')
    const recompute = anchor('recompute', rule, startsOn, '2026-01-05', '2026-01-14')
    expect(new Set([extend, catchUp, recompute]).size).toBe(3)
  })
})

describe('① extend：连续晚做会持续逾期（§5 表）', () => {
  const rule: RecurrenceRule = { freq: 'daily', interval: 1 }

  it('完成日晚于命中的那一天：锚点仍在完成日之前 → 逾期提示触发', () => {
    const nextAnchor = anchor('extend', rule, '2026-01-01', '2026-01-05', '2026-01-08')
    expect(nextAnchor).toBe('2026-01-06')
    expect(shouldPromptOverdue(nextAnchor, '2026-01-08')).toBe(true)
  })

  it('连续晚做：每一天都补一个「昨天该做」的轮次，逾期持续存在', () => {
    expect(anchor('extend', rule, '2026-01-01', '2026-01-06', '2026-01-08')).toBe('2026-01-07')
    expect(anchor('extend', rule, '2026-01-01', '2026-01-07', '2026-01-08')).toBe('2026-01-08')
  })
})

describe('② catch_up：追赶到今天之后（默认，§5 表）', () => {
  const rule: RecurrenceRule = { freq: 'daily', interval: 1 }

  it('完成日晚于命中的那一天：一次追到 > T，不累积逾期', () => {
    expect(anchor('catch_up', rule, '2026-01-01', '2026-01-05', '2026-01-08')).toBe('2026-01-09')
  })

  it('落后 30 天也一次追平（不会产生 30 条逾期轮次）', () => {
    expect(anchor('catch_up', rule, '2026-01-01', '2026-01-05', '2026-02-04')).toBe('2026-02-05')
  })

  it('锚点恒 > T：② 不可能触发逾期提示（§5 表）', () => {
    for (const completed of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      const nextAnchor = anchor('catch_up', rule, '2026-01-01', '2026-01-05', completed)
      expect(nextAnchor).not.toBeNull()
      expect(shouldPromptOverdue(nextAnchor, completed)).toBe(false)
    }
  })

  it('weekly + byDayOfWeek:[0,2]：追赶也落在命中日上，不落在任意一天', () => {
    const weekly: RecurrenceRule = { freq: 'weekly', interval: 1, byDayOfWeek: [0, 2] }
    // 2026-01-05 周一；T = 01-07 周三 → 下一个命中日 01-12（周一）
    expect(anchor('catch_up', weekly, '2026-01-05', '2026-01-05', '2026-01-07')).toBe('2026-01-12')
  })
})

describe('③ recompute：按完成日重算（§5 表）', () => {
  const rule: RecurrenceRule = { freq: 'daily', interval: 1 }

  it('候选 = T 加一个间隔，再向上对齐到第一个命中日', () => {
    expect(anchor('recompute', rule, '2026-01-01', '2026-01-05', '2026-01-08')).toBe('2026-01-09')
  })

  it('锚点恒 > T：③ 不可能触发逾期提示（§5 表）', () => {
    for (const completed of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      const nextAnchor = anchor('recompute', rule, '2026-01-01', '2026-01-05', completed)
      expect(nextAnchor).not.toBeNull()
      expect(shouldPromptOverdue(nextAnchor, completed)).toBe(false)
    }
  })

  it('daily + interval = 3：候选落在两个命中日之间时向上对齐', () => {
    // 命中序列：01-01, 01-04, 01-07, 01-10, 01-13…
    // T = 01-09 → 候选 = T + 3 = 01-12（**不是命中日**）→ 向上对齐到 01-13
    expect(addOneInterval({ freq: 'daily', interval: 3 }, '2026-01-09')).toBe('2026-01-12')
    expect(anchor('recompute', { freq: 'daily', interval: 3 }, '2026-01-01', '2026-01-04', '2026-01-09')).toBe(
      '2026-01-13',
    )
  })

  it('提前完成（T < P）：锚点仍严格 > T，且仍落在命中日上', () => {
    const nextAnchor = anchor('recompute', rule, '2026-01-01', '2026-01-10', '2026-01-08')
    // 候选 = 01-08 + 1 = 01-09，对齐后仍是 01-09：它 **早于** P = 01-10，而 P 那一轮
    // 刚刚完成。锚点若落在 01-09，就等于把「刚做完的那一轮之前的一天」当成下一轮，
    // FR2.5 的「下一轮 X 日」会显示一个比刚完成的轮次更早的日期。
    // 故守卫把它推后到 P 之后的第一个命中日（ADR-011 §5「锚点的不变式」）。
    expect(nextAnchor).toBe('2026-01-11')
    expect((nextAnchor as string) > '2026-01-10').toBe(true)
    expect(shouldPromptOverdue(nextAnchor, '2026-01-08')).toBe(false)
  })

  it('锚点不得等于**刚完成的那一轮**的实例键（T + 间隔 恰好落在 P 上）', () => {
    // P = 01-05、T = 01-04、daily interval 1 → 候选 = 01-05 = P。
    // 若原样返回，锚点就是刚完成的那一轮原计划日期；下一轮与它撞实例键（§4），
    // 整个模板的推导会抛 AnchorInvariantError。守卫取 P 之后的第一个命中日。
    expect(anchor('recompute', rule, '2026-01-01', '2026-01-05', '2026-01-04')).toBe('2026-01-06')
  })

  it('weekly + byDayOfWeek:[0,2]：候选 T + 一周后对齐', () => {
    const weekly: RecurrenceRule = { freq: 'weekly', interval: 1, byDayOfWeek: [0, 2] }
    // T = 01-07（周三）→ 候选 01-14（周三，恰是命中日）→ 01-14
    expect(anchor('recompute', weekly, '2026-01-05', '2026-01-05', '2026-01-07')).toBe('2026-01-14')
  })
})

describe('按期 / 提前完成时的三锚点', () => {
  const rule: RecurrenceRule = { freq: 'daily', interval: 1 }

  it('如期完成（T = P）：三锚点一致', () => {
    expect(anchor('extend', rule, '2026-01-01', '2026-01-05', '2026-01-05')).toBe('2026-01-06')
    expect(anchor('catch_up', rule, '2026-01-01', '2026-01-05', '2026-01-05')).toBe('2026-01-06')
    expect(anchor('recompute', rule, '2026-01-01', '2026-01-05', '2026-01-05')).toBe('2026-01-06')
  })

  it('提前完成（T < P）：① 与 ② 一致地沿用原相位，③ 因守卫退化为「P 之后第一个命中日」', () => {
    expect(anchor('extend', rule, '2026-01-01', '2026-01-10', '2026-01-08')).toBe('2026-01-11')
    expect(anchor('catch_up', rule, '2026-01-01', '2026-01-10', '2026-01-08')).toBe('2026-01-11')
    // ③ 的字面结果（候选 01-09）早于 P —— 见上方用例与报告里的契约缺口 #5
    expect(anchor('recompute', rule, '2026-01-01', '2026-01-10', '2026-01-08')).toBe('2026-01-11')
  })

  it('锚点恒严格晚于本轮计划日（三锚点共同的不变式，ADR-011 §5）', () => {
    const plannedDate = '2026-01-05'
    for (const mode of ['extend', 'catch_up', 'recompute'] as const) {
      for (const completed of ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-20']) {
        const nextAnchor = anchor(mode, rule, '2026-01-01', plannedDate, completed)
        expect(nextAnchor).not.toBeNull()
        expect((nextAnchor as string) > plannedDate).toBe(true)
      }
    }
  })
})

describe('锚点受 count / until 约束：序列终止时返回 null（ADR-011 §4）', () => {
  it('count = 1：本轮就是最后一轮，没有下一轮', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, count: 1 }
    expect(anchor('extend', rule, '2026-01-05', '2026-01-05', '2026-01-05')).toBeNull()
    expect(anchor('catch_up', rule, '2026-01-05', '2026-01-05', '2026-01-09')).toBeNull()
    expect(anchor('recompute', rule, '2026-01-05', '2026-01-05', '2026-01-09')).toBeNull()
  })

  it('count 未耗尽：仍给出下一轮', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, count: 3 }
    // 命中序列：01-05, 01-06, 01-07
    expect(anchor('extend', rule, '2026-01-05', '2026-01-05', '2026-01-05')).toBe('2026-01-06')
    expect(anchor('extend', rule, '2026-01-05', '2026-01-06', '2026-01-06')).toBe('2026-01-07')
    expect(anchor('extend', rule, '2026-01-05', '2026-01-07', '2026-01-07')).toBeNull()
  })

  it('until：最后一个命中日之后返回 null', () => {
    const rule: RecurrenceRule = { freq: 'daily', interval: 1, until: '2026-01-07' }
    expect(anchor('extend', rule, '2026-01-05', '2026-01-05', '2026-01-05')).toBe('2026-01-06')
    expect(anchor('extend', rule, '2026-01-05', '2026-01-07', '2026-01-07')).toBeNull()
    // ② 想追到 > T 但序列已终止 → null，而不是填一个越界日期充数
    expect(anchor('catch_up', rule, '2026-01-05', '2026-01-05', '2026-01-20')).toBeNull()
    expect(anchor('recompute', rule, '2026-01-05', '2026-01-05', '2026-01-20')).toBeNull()
  })

  it('null 时逾期提示不出现（不得拿越界日期充数）', () => {
    expect(shouldPromptOverdue(null, '2026-01-20')).toBe(false)
  })
})

describe('shouldPromptOverdue · FR2.5 的触发条件（§5）', () => {
  it('nextAnchorDate ≤ 今天 时为 true', () => {
    expect(shouldPromptOverdue('2026-01-08', '2026-01-08')).toBe(true)
    expect(shouldPromptOverdue('2026-01-07', '2026-01-08')).toBe(true)
  })

  it('nextAnchorDate > 今天 时为 false', () => {
    expect(shouldPromptOverdue('2026-01-09', '2026-01-08')).toBe(false)
  })
})

describe('nextAnchorDate · 规则不合法时抛错（不在推导里静默兜底）', () => {
  it('count 与 until 并存 → RecurrenceRuleError', () => {
    expect(() =>
      anchor('extend', { freq: 'daily', interval: 1, count: 2, until: '2026-02-01' }, '2026-01-05', '2026-01-05', '2026-01-05'),
    ).toThrow(RecurrenceRuleError)
  })

  it('byMonthDay 给 weekly → RecurrenceRuleError', () => {
    expect(() =>
      anchor('extend', { freq: 'weekly', interval: 1, byMonthDay: [1] }, '2026-01-05', '2026-01-05', '2026-01-05'),
    ).toThrow(RecurrenceRuleError)
  })

  it('未知锚点模式 → RecurrenceRuleError（不是静默返回 undefined）', () => {
    // 类型挡住 TS 调用方，但 JS 调用方与 `as never` 的探针挡不住；静默 undefined
    // 会一路变成「没有下一轮」的假象（§4.1：用户输入错误 → 400，不得吞掉）
    const input: AnchorInput = {
      rule: { freq: 'daily', interval: 1 },
      startsOn: '2026-01-05',
      plannedDate: '2026-01-05',
      completedDayKey: '2026-01-05',
    }
    expect(() => nextAnchorDate('skip' as never, input)).toThrow(RecurrenceRuleError)
    try {
      nextAnchorDate('' as never, input)
      throw new Error('本应抛错')
    } catch (error) {
      expect((error as RecurrenceRuleError).violations.map((v) => v.code)).toContain('invalid-anchor-mode')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 依赖 ADR-009 §8（月 / 年算术）——已落地，照常执行。
// ═══════════════════════════════════════════════════════════════════════════
describe('monthly / yearly 锚点（§5 的「每一步都过夹取」）', () => {
  it('② catch_up 跨过 2 月时落在**夹取日**上，而不是抛错（§5 明写）', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31] }
    // P = 01-31、T = 02-20 → 下一个命中日是 02-28（夹取日）
    expect(anchor('catch_up', rule, '2026-01-31', '2026-01-31', '2026-02-20')).toBe('2026-02-28')
  })

  it('① extend 跨月时同样是夹取日（不会抛 RangeError）', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31] }
    expect(anchor('extend', rule, '2026-01-31', '2026-01-31', '2026-02-05')).toBe('2026-02-28')
  })

  it('③ recompute：候选 = T 加一个月后再对齐（不落在非命中日）', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31] }
    expect(addOneInterval(rule, '2026-02-20')).toBe('2026-03-20')
    expect(anchor('recompute', rule, '2026-01-31', '2026-01-31', '2026-02-20')).toBe('2026-03-31')
  })

  it('yearly + starts_on = 2028-02-29：下一轮是 2029-02-28（夹取），不是抛错', () => {
    const rule: RecurrenceRule = { freq: 'yearly', interval: 1 }
    expect(anchor('extend', rule, '2028-02-29', '2028-02-29', '2028-03-02')).toBe('2029-02-28')
  })

  it('monthly + count：最后一轮之后返回 null', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31], count: 2 }
    expect(anchor('extend', rule, '2026-01-31', '2026-01-31', '2026-02-05')).toBe('2026-02-28')
    expect(anchor('extend', rule, '2026-01-31', '2026-02-28', '2026-03-05')).toBeNull()
  })
})
