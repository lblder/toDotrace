/**
 * 命中集合（落库日序列）的测试矩阵。
 *
 * 对应 03 §9 的已知风险「重复任务三锚点的边界（月末 / 闰年 / 跨周）」，
 * 按 03 §5「先测后实现该模块」的要求，本文件的期望值**先于实现写出**，
 * 且全部是手算的日历事实，不用实现自证。
 *
 * 分两段，现在**都照常执行**：
 * - daily / weekly 不依赖 ADR-009 §8；
 * - 月末夹取 / 多值碰撞 / 闰年依赖 §8 的月 / 年算术（`daysInMonthOf` /
 *   `addMonthsClamped` / `addYearsClamped`），§8 已于 ADR-009 v1.1 落地。
 */
import { describe, expect, it } from 'vitest'

import { MAX_PROGRESSION_ITERATIONS, ProgressionLimitError, hitSequence, hitsBetween } from './index'
import type { RecurrenceRule } from './index'

/** 取出前 n 个，避免无限序列把测试挂死 */
function take(sequence: Generator<string>, count: number): string[] {
  const collected: string[] = []
  for (const value of sequence) {
    collected.push(value)
    if (collected.length >= count) break
  }
  return collected
}

function drain(sequence: Generator<string>): string[] {
  const collected: string[] = []
  for (const value of sequence) collected.push(value)
  return collected
}

describe('daily · 推进 = 在命中集合中取下一个（§5 新文本）', () => {
  const startsOn = '2026-01-05'

  it('interval = 1：逐日', () => {
    expect(take(hitSequence({ freq: 'daily', interval: 1 }, startsOn), 4)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
    ])
  })

  it('interval = 3：每隔两天', () => {
    expect(take(hitSequence({ freq: 'daily', interval: 3 }, startsOn), 4)).toEqual([
      '2026-01-05',
      '2026-01-08',
      '2026-01-11',
      '2026-01-14',
    ])
  })

  it('跨月跨年：2026-12-30 → 2027-01-01', () => {
    expect(take(hitSequence({ freq: 'daily', interval: 1 }, '2026-12-30'), 3)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ])
  })

  it('首轮恒为 starts_on（ADR-011 §1：它是「首轮的原计划日期起点」）', () => {
    expect(take(hitSequence({ freq: 'daily', interval: 5 }, '2026-03-09'), 1)).toEqual(['2026-03-09'])
  })
})

describe('weekly · 跨周与 byDayOfWeek（§2：0 = 周一 … 6 = 周日）', () => {
  it('无 byDayOfWeek：沿用 starts_on 的星期几，按 interval 周推进', () => {
    // 2026-01-05 是周一
    expect(take(hitSequence({ freq: 'weekly', interval: 1 }, '2026-01-05'), 3)).toEqual([
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
    ])
  })

  it('无 byDayOfWeek + interval = 2：隔周', () => {
    expect(take(hitSequence({ freq: 'weekly', interval: 2 }, '2026-01-05'), 3)).toEqual([
      '2026-01-05',
      '2026-01-19',
      '2026-02-02',
    ])
  })

  it('byDayOfWeek: [0]（周一）', () => {
    expect(
      take(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [0] }, '2026-01-05'), 3),
    ).toEqual(['2026-01-05', '2026-01-12', '2026-01-19'])
  })

  it('byDayOfWeek: [0,2]（周一 + 周三）—— 从周一起推，下一个应是**周三**而不是下周一', () => {
    expect(
      take(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [0, 2] }, '2026-01-05'), 6),
    ).toEqual(['2026-01-05', '2026-01-07', '2026-01-12', '2026-01-14', '2026-01-19', '2026-01-21'])
  })

  it('byDayOfWeek 的书写顺序不影响结果（归一化后升序：命中集合的升序生成依赖它）', () => {
    const ascending = take(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [0, 2] }, '2026-01-05'), 4)
    const shuffled = take(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [2, 0] }, '2026-01-05'), 4)
    expect(shuffled).toEqual(ascending)
  })

  it('byDayOfWeek: [0,2] + interval = 2：周步长是 2 周（14 天）', () => {
    expect(
      take(hitSequence({ freq: 'weekly', interval: 2, byDayOfWeek: [0, 2] }, '2026-01-05'), 6),
    ).toEqual(['2026-01-05', '2026-01-07', '2026-01-19', '2026-01-21', '2026-02-02', '2026-02-04'])
  })

  it('starts_on 不满足 byDayOfWeek 时，它仍是第 1 轮（ADR-011 §4 规则 2）', () => {
    // 2026-01-05 是周一，而规则要的是周五（4）——首轮仍是 starts_on，其后接规则命中日。
    // §4 规则 2：「`starts_on` 恒为第 1 个命中日，即使它不满足 `by*`」——依据是 §1 把
    // starts_on 定义为「首轮的原计划日期」起点（同 RRULE 的 DTSTART）。
    // 用户可见后果：周一创建一条「每周五」的任务，第一轮显示为今天。
    expect(take(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [4] }, '2026-01-05'), 4)).toEqual([
      '2026-01-05',
      '2026-01-09',
      '2026-01-16',
      '2026-01-23',
    ])
  })

  it('跨年跨周：2026-12-30（周三）起，规则只要周一', () => {
    expect(take(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [0] }, '2026-12-30'), 3)).toEqual([
      '2026-12-30',
      '2027-01-04',
      '2027-01-11',
    ])
  })
})

describe('count / until 的边界 · 一律以**落库日**为准（§4 规则 3）', () => {
  it('count 截断：只产出前 count 条', () => {
    expect(take(hitSequence({ freq: 'daily', interval: 1, count: 3 }, '2026-01-05'), 10)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
    ])
  })

  it('count = 1：只剩首轮', () => {
    expect(drain(hitSequence({ freq: 'daily', interval: 1, count: 1 }, '2026-01-05'))).toEqual(['2026-01-05'])
  })

  it('until 是**含当日**的上界（§2：until = 截止日（含））', () => {
    expect(drain(hitSequence({ freq: 'daily', interval: 1, until: '2026-01-08' }, '2026-01-05'))).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
    ])
  })

  it('until 恰落在某个命中日上：该日计入', () => {
    expect(
      drain(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [0], until: '2026-01-12' }, '2026-01-05')),
    ).toEqual(['2026-01-05', '2026-01-12'])
  })

  it('until 落在两个命中日之间：不产生额外轮次', () => {
    expect(
      drain(hitSequence({ freq: 'weekly', interval: 1, byDayOfWeek: [0], until: '2026-01-11' }, '2026-01-05')),
    ).toEqual(['2026-01-05'])
  })

  it('until == starts_on：只有首轮（§2 允许，§4 的推导以它为前提）', () => {
    expect(drain(hitSequence({ freq: 'daily', interval: 1, until: '2026-01-05' }, '2026-01-05'))).toEqual([
      '2026-01-05',
    ])
  })
})

describe('推进上限保护（§4 规则 4：超过 10000 次抛错，不静默截断）', () => {
  it('起点过早（1000-01-01 的每日规则）时抛 ProgressionLimitError', () => {
    expect(() => drain(hitSequence({ freq: 'daily', interval: 1 }, '1000-01-01'))).toThrow(ProgressionLimitError)
  })

  it('抛出的错里带着起点与上限，便于定位', () => {
    try {
      drain(hitSequence({ freq: 'daily', interval: 1 }, '1000-01-01'))
      throw new Error('本应抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ProgressionLimitError)
      expect((error as ProgressionLimitError).startsOn).toBe('1000-01-01')
      expect((error as ProgressionLimitError).limit).toBe(MAX_PROGRESSION_ITERATIONS)
      expect((error as ProgressionLimitError).code).toBe('recurrence/progression-limit')
    }
  })

  it('**不静默截断**：不是返回一个短的序列，而是抛错', () => {
    // 「返回 10000 条然后装作正常」是最危险的形态——热力图与按时率里极难发现（§4 理由）
    let thrown: unknown = null
    try {
      drain(hitSequence({ freq: 'daily', interval: 1 }, '1000-01-01'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProgressionLimitError)
  })

  it('正常跨度（2001-01-01 起）不触发上限——上限挡的是异常数据，不是日常使用', () => {
    const sequence = hitSequence({ freq: 'daily', interval: 1 }, '2001-01-01')
    expect(take(sequence, 3)).toEqual(['2001-01-01', '2001-01-02', '2001-01-03'])
  })

  it('上限可用 maxIterations 覆盖（供诊断用）', () => {
    expect(() => drain(hitSequence({ freq: 'daily', interval: 1 }, '2026-01-01', { maxIterations: 2 }))).toThrow(
      ProgressionLimitError,
    )
  })
})

describe('hitsBetween · 区间枚举（ADR-011 §8 的 RDATE 补入靠它）', () => {
  it('闭区间：两端都是落库日口径', () => {
    expect(hitsBetween({ freq: 'daily', interval: 1 }, '2026-01-05', '2026-01-07', '2026-01-09')).toEqual([
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
    ])
  })

  it('from > to 时返回空数组', () => {
    expect(hitsBetween({ freq: 'daily', interval: 1 }, '2026-01-05', '2026-01-09', '2026-01-07')).toEqual([])
  })

  it('区间内没有命中日时返回空数组', () => {
    expect(
      hitsBetween({ freq: 'weekly', interval: 1, byDayOfWeek: [0] }, '2026-01-05', '2026-01-06', '2026-01-11'),
    ).toEqual([])
  })

  it('受 count / until 约束（导出范围之外的部分不产出）', () => {
    expect(
      hitsBetween({ freq: 'daily', interval: 1, until: '2026-01-07' }, '2026-01-05', '2026-01-05', '2026-12-31'),
    ).toEqual(['2026-01-05', '2026-01-06', '2026-01-07'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 以下依赖 ADR-009 §8 的月 / 年算术（`daysInMonthOf` / `addMonthsClamped` /
// `addYearsClamped`）。§8 已落地（`shared/time` 转出，接缝在 `./calendar`），
// 故整段**照常执行**——期望值是 §8 落地前就写死的手算日历事实，未据实现回填。
// ═══════════════════════════════════════════════════════════════════════════
describe('monthly · 月末夹取：落库日 = min(规则日, 该月天数)（§3）', () => {
  it('byMonthDay: [31] 连续 12 个月 —— 夹取日**不得**成为下一轮的基数', () => {
    // 这条是 §5「新文本」点名的核心断言：拿上一轮落库日当基数会一路漂到 28 号
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [31] }, '2026-01-31'), 12)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
    ])
  })

  it('byMonthDay: [31] 遇**闰年** 2 月：夹到 2 月 29 日', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [31] }, '2028-01-31'), 3)).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
    ])
  })

  it('byMonthDay: [30] 遇 2 月平年 → 2/28，闰年 → 2/29；3 月回到 30 号（不漂到 28）', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [30] }, '2026-01-30'), 4)).toEqual([
      '2026-01-30',
      '2026-02-28',
      '2026-03-30',
      '2026-04-30',
    ])
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [30] }, '2028-01-30'), 3)).toEqual([
      '2028-01-30',
      '2028-02-29',
      '2028-03-30',
    ])
  })

  it('byMonthDay: [29] 遇**平年** 2 月 → 2/28', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [29] }, '2026-01-29'), 3)).toEqual([
      '2026-01-29',
      '2026-02-28',
      '2026-03-29',
    ])
  })

  it('byMonthDay: [29] 遇闰年 2 月：2/29 本身存在，不夹取', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [29] }, '2028-01-29'), 2)).toEqual([
      '2028-01-29',
      '2028-02-29',
    ])
  })

  it('byMonthDay: [-1]（月末）**永不夹取**，且与 [31] 同解（§3 明说两者等价）', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [-1] }, '2026-01-31'), 12)).toEqual(
      take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [31] }, '2026-01-31'), 12),
    )
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [-1] }, '2028-01-31'), 2)).toEqual([
      '2028-01-31',
      '2028-02-29',
    ])
  })

  it('interval = 2：只落在奇数月，夹取照旧', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 2, byMonthDay: [31] }, '2026-01-31'), 4)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ])
  })

  it('无 byMonthDay：名义日取自 starts_on 的日', () => {
    expect(take(hitSequence({ freq: 'monthly', interval: 1 }, '2026-01-15'), 3)).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
    ])
  })

  it('相位原点取自 starts_on 的**月**，名义日取自 byMonthDay 的**日**', () => {
    // starts_on 的日（15）不在 byMonthDay 里，仍不影响命中日的名义日
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [1, 31] }, '2026-01-15'), 6)).toEqual([
      '2026-01-15', // 首轮恒为 starts_on
      '2026-01-31',
      '2026-02-01',
      '2026-02-28', // 名义日 31 → 夹到 28
      '2026-03-01',
      '2026-03-31',
    ])
  })

  it('until 与**落库日**比较（§4 规则 3 的反例）', () => {
    // 按规则日 2/31 > 2/28 会把 2 月那轮排除；按落库日 2/28 ≤ 2/28 则包含。两种口径结果相反
    expect(
      drain(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [31], until: '2026-02-28' }, '2026-01-31')),
    ).toEqual(['2026-01-31', '2026-02-28'])
  })

  it('被夹取的轮次**计入 count**（§4 规则 3）', () => {
    expect(
      drain(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [31], count: 3 }, '2026-01-31')),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })
})

describe('monthly · 多值碰撞：同一天只算一条轮次', () => {
  it('byMonthDay: [30,31] 遇 2 月：两个名义日夹到同一天 → **一条**（不是两条）', () => {
    // 依据：实例键 =（模板标识 + 原计划日期）（ADR-011 §4），同日必然同键，给两条会撞键。
    // 主控 2026-09-22 已确认此处置。
    expect(take(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [30, 31] }, '2026-01-30'), 9)).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-28', // 30 与 31 都夹到 28 → 去重成一条
      '2026-03-30',
      '2026-03-31',
      '2026-04-30', // 31 夹到 30 → 与名义日 30 撞车 → 一条
      '2026-05-30',
      '2026-05-31',
      '2026-06-30',
    ])
  })

  it('碰撞去重后仍受 count 约束：count 数的是**轮次数**而不是名义日数', () => {
    expect(
      drain(hitSequence({ freq: 'monthly', interval: 1, byMonthDay: [30, 31], count: 3 }, '2026-01-30')),
    ).toEqual(['2026-01-30', '2026-01-31', '2026-02-28'])
  })
})

describe('yearly · 闰年与 2 月 29 日的相位保持（§5「新文本」）', () => {
  it('starts_on = 2028-02-29：平年夹到 2/28，**2032 年 2 月 29 日必须回来**', () => {
    // 若拿上一轮的落库日当基数，2/29 会永久丢失（§5 点名的缺陷）
    expect(take(hitSequence({ freq: 'yearly', interval: 1 }, '2028-02-29'), 5)).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ])
  })

  it('starts_on = 2028-02-29 + interval = 4：每一跳都落在闰年，**从不夹取**', () => {
    expect(take(hitSequence({ freq: 'yearly', interval: 4 }, '2028-02-29'), 3)).toEqual([
      '2028-02-29',
      '2032-02-29',
      '2036-02-29',
    ])
  })

  it('starts_on = 2026-02-28（名义日就是 28）：2028 年给 2/28 而不是 2/29', () => {
    // 名义日取自 starts_on，不取「2 月最后一天」
    expect(take(hitSequence({ freq: 'yearly', interval: 1 }, '2026-02-28'), 3)).toEqual([
      '2026-02-28',
      '2027-02-28',
      '2028-02-28',
    ])
  })

  it('yearly + until：与落库日比较', () => {
    expect(drain(hitSequence({ freq: 'yearly', interval: 1, until: '2029-02-28' }, '2028-02-29'))).toEqual([
      '2028-02-29',
      '2029-02-28',
    ])
  })
})
