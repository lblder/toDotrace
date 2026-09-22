/**
 * ADR-012 §6 · 打卡纯函数的测试矩阵。
 *
 * `dayKeys` 的契约是「该账号**有到达记录**的日子，已升序、已去重」（§6 / §3）。
 * 本文件的用例既覆盖**契约内**的口径，也覆盖**契约被违反时**（乱序、重复）的行为——
 * 后者不是「支持」，而是把「实现不依赖顺序」这件事写成可验证的事实。
 *
 * 其中 `currentStreak` 三种情形（今天已打卡 / 今天未打但昨天有 / 昨天也没有）
 * 是 §6 明确定义的口径，逐一有用例。
 */
import { describe, expect, it } from 'vitest'

import { addDays } from '@shared/time'
import type { DayKey } from '@shared/time'

import { countCheckins, currentStreak, isRestDay } from './index'

/** 构造测试输入。契约要求升序去重：契约内的用例按升序书写，越界用例显式违反 */
const keys = (...dayKeys: DayKey[]): DayKey[] => dayKeys

describe('currentStreak · 三种情形（ADR-012 §6）', () => {
  it('今天已打卡 → 从今天往回数连续有记录的天数', () => {
    expect(currentStreak(keys('2026-09-19', '2026-09-20', '2026-09-21'), '2026-09-21')).toBe(3)
  })

  it('今天未打卡 → 从昨天往回数（今天还没过完，不该算断）', () => {
    expect(currentStreak(keys('2026-09-19', '2026-09-20'), '2026-09-21')).toBe(2)
  })

  it('昨天也没有 → 0（前一天有记录也不算，因为昨天已经断了）', () => {
    expect(currentStreak(keys('2026-09-18', '2026-09-19'), '2026-09-21')).toBe(0)
  })
})

describe('currentStreak · 计数边界', () => {
  it('空集合 → 0', () => {
    expect(currentStreak([], '2026-09-21')).toBe(0)
  })

  it('只有今天 → 1', () => {
    expect(currentStreak(keys('2026-09-21'), '2026-09-21')).toBe(1)
  })

  it('只有昨天（今天未打）→ 1', () => {
    expect(currentStreak(keys('2026-09-20'), '2026-09-21')).toBe(1)
  })

  it('只有前天 → 0', () => {
    expect(currentStreak(keys('2026-09-19'), '2026-09-21')).toBe(0)
  })

  it('today 早于全部记录 → 0（未来记录不计入连续）', () => {
    expect(currentStreak(keys('2026-09-21', '2026-09-22'), '2026-09-01')).toBe(0)
  })

  it('记录全在未来 → 0', () => {
    expect(currentStreak(keys('2026-10-01', '2026-10-02'), '2026-09-21')).toBe(0)
  })

  it('中间断一天即截断', () => {
    const days = keys('2026-09-15', '2026-09-16', '2026-09-19', '2026-09-20', '2026-09-21')
    expect(currentStreak(days, '2026-09-21')).toBe(3) // 19/20/21
    expect(currentStreak(days, '2026-09-22')).toBe(3) // 今天未打，从昨天数
    expect(currentStreak(keys('2026-09-18', '2026-09-21'), '2026-09-21')).toBe(1)
  })

  it('跨月连续', () => {
    const days = keys('2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02')
    expect(currentStreak(days, '2026-09-02')).toBe(4)
    expect(currentStreak(days, '2026-09-03')).toBe(4)
  })

  it('跨年连续', () => {
    const days = keys('2025-12-30', '2025-12-31', '2026-01-01')
    expect(currentStreak(days, '2026-01-01')).toBe(3)
    expect(currentStreak(days, '2026-01-02')).toBe(3)
  })

  it('跨闰日连续（2028-02-29）', () => {
    const days = keys('2028-02-28', '2028-02-29', '2028-03-01')
    expect(currentStreak(days, '2028-03-01')).toBe(3)
  })

  it('长连续（400 天）', () => {
    const days: DayKey[] = []
    let cursor = '2026-01-01'
    let last = cursor
    for (let i = 0; i < 400; i += 1) {
      days.push(cursor)
      last = cursor
      cursor = addDays(cursor, 1)
    }
    expect(currentStreak(days, last)).toBe(400)
    expect(currentStreak(days, addDays(last, 1))).toBe(400) // 今天未打，从昨天数
    expect(currentStreak(days, addDays(last, 2))).toBe(0) // 昨天也没打
  })
})

describe('currentStreak · 契约被违反时的行为（不依赖顺序与去重）', () => {
  it('重复 dayKey → 一天算一天，不重复计数', () => {
    expect(currentStreak(keys('2026-09-21', '2026-09-21', '2026-09-20'), '2026-09-21')).toBe(2)
  })

  it('乱序输入仍得正确结果（实现不读顺序）', () => {
    expect(currentStreak(keys('2026-09-19', '2026-09-21', '2026-09-20'), '2026-09-21')).toBe(3)
  })

  it('数组里的非法值不参与命中，也不抛错（契约外，静默忽略）', () => {
    expect(currentStreak(keys('2026-09-21', 'garbage'), '2026-09-21')).toBe(1)
  })

  it('today 非法 → RangeError（标量参数一律把关）', () => {
    expect(() => currentStreak([], 'garbage')).toThrow(RangeError)
    expect(() => currentStreak([], '2026-02-30')).toThrow(RangeError)
    expect(() => currentStreak([], '2026-9-21')).toThrow(RangeError)
  })
})

describe('isRestDay · 无到达记录 = 休息日（ADR-002 §3 / 012 §5）', () => {
  const today = '2026-09-21'

  it('有记录 → 非休息日；无记录 → 休息日', () => {
    const days = keys('2026-09-20', '2026-09-21')
    expect(isRestDay(days, '2026-09-21', today)).toBe(false)
    expect(isRestDay(days, '2026-09-19', today)).toBe(true)
  })

  it('相邻日有记录不影响当日判定（「无行 ⇔ 无到达」）', () => {
    const days = keys('2026-09-20', '2026-09-22')
    expect(isRestDay(days, '2026-09-21', today)).toBe(true)
  })

  it('空集合 → 已经过的任何一天都是休息日', () => {
    expect(isRestDay([], '2026-09-21', today)).toBe(true)
    expect(isRestDay([], '2026-01-01', today)).toBe(true)
  })

  it('未来日期一律 false —— 不是「休息」，是尚未到达（ADR-012 §6）', () => {
    // §6：`false` 不是「那天将是工作日」的断言，而是「现在无法断言」。
    expect(isRestDay(keys('2026-09-21'), '2026-09-22', today)).toBe(false)
    expect(isRestDay([], '2026-09-22', today)).toBe(false) // 空集合也不例外
    expect(isRestDay([], '2026-09-30', today)).toBe(false) // 跨月未来
    expect(isRestDay([], '2027-01-01', today)).toBe(false) // 跨年未来
  })

  it('今天不是未来：今天无记录仍是休息日（01 FR1「今天偷偷懒」）', () => {
    expect(isRestDay([], today, today)).toBe(true)
    expect(isRestDay(keys('2026-09-20'), today, today)).toBe(true)
  })

  it('false 有二义：有记录 与 未来 都返回 false，三态由调用方自己比 today', () => {
    const days = keys('2026-09-19')
    // 同一个返回值、两种含义——这正是「要区分空白 / 未到 / 休息，由调用方比对 today」的理由
    expect(isRestDay(days, '2026-09-19', today)).toBe(false) // 有记录
    expect(isRestDay(days, '2026-09-25', today)).toBe(false) // 尚未到达
  })

  it('today 只影响「未来」判定，不改动过去的日子', () => {
    const days = keys('2026-09-19')
    const dk = '2026-09-20'
    expect(isRestDay(days, dk, '2026-09-21')).toBe(true) // dk 已过去 → 结构判定
    expect(isRestDay(days, dk, '2026-09-20')).toBe(true) // dk 是今天 → 结构判定
    expect(isRestDay(days, dk, '2026-09-19')).toBe(false) // dk 是未来 → 不判定
  })

  it('跨月跨年边界', () => {
    const days = keys('2025-12-31', '2026-01-01')
    expect(isRestDay(days, '2026-01-01', '2026-01-01')).toBe(false)
    expect(isRestDay(days, '2025-12-31', '2026-01-01')).toBe(false)
    expect(isRestDay(days, '2026-01-02', '2026-01-02')).toBe(true)
    expect(isRestDay(days, '2026-01-02', '2026-01-01')).toBe(false) // 未来
  })

  it('重复与乱序不影响判定', () => {
    expect(isRestDay(keys('2026-09-21', '2026-09-21'), '2026-09-21', today)).toBe(false)
    expect(isRestDay(keys('2026-09-22', '2026-09-21'), '2026-09-21', today)).toBe(false)
  })

  it('非法 dk / today → RangeError', () => {
    expect(() => isRestDay([], 'garbage', today)).toThrow(RangeError)
    expect(() => isRestDay([], '2026-02-30', today)).toThrow(RangeError)
    expect(() => isRestDay([], '2027-02-29', today)).toThrow(RangeError)
    expect(() => isRestDay([], today, 'garbage')).toThrow(RangeError)
    expect(() => isRestDay([], today, '2026-02-30')).toThrow(RangeError)
  })
})

describe('countCheckins · 闭区间 [from, to]', () => {
  it('区间内的记录数', () => {
    const days = keys('2026-09-19', '2026-09-20', '2026-09-21')
    expect(countCheckins(days, '2026-09-19', '2026-09-21')).toBe(3)
  })

  it('两端都是闭的', () => {
    const days = keys('2026-09-19', '2026-09-20', '2026-09-21')
    expect(countCheckins(days, '2026-09-20', '2026-09-21')).toBe(2)
    expect(countCheckins(days, '2026-09-19', '2026-09-20')).toBe(2)
  })

  it('单日区间 from === to', () => {
    const days = keys('2026-09-20', '2026-09-21')
    expect(countCheckins(days, '2026-09-21', '2026-09-21')).toBe(1)
    expect(countCheckins(days, '2026-09-19', '2026-09-19')).toBe(0)
  })

  it('范围外的记录不计入', () => {
    const days = keys('2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22')
    expect(countCheckins(days, '2026-09-19', '2026-09-21')).toBe(3)
  })

  it('空集合与无命中区间 → 0', () => {
    expect(countCheckins([], '2026-09-01', '2026-09-30')).toBe(0)
    expect(countCheckins(keys('2026-09-21'), '2026-08-01', '2026-08-31')).toBe(0)
  })

  it('from > to → RangeError（「静默 0」这条路径根本不存在）', () => {
    // ADR-012 §3 要求路由层返回 400；此处抛错使**路由层的 400 不再是这条不变式的唯一守卫**。
    // 若返回 0，路由一旦漏检，0 会冒充「那段时间没打卡」——正是 §3 点名要避免的。
    const days = keys('2026-09-21')
    expect(() => countCheckins(days, '2026-09-22', '2026-09-21')).toThrow(RangeError)
    expect(() => countCheckins(days, '2026-10-01', '2026-09-30')).toThrow(RangeError) // 跨月
    expect(() => countCheckins(days, '2027-01-01', '2026-12-31')).toThrow(RangeError) // 跨年
    expect(() => countCheckins([], '2026-09-22', '2026-09-21')).toThrow(RangeError) // 空集合也抛
    expect(countCheckins(days, '2026-09-21', '2026-09-21')).toBe(1) // from === to 合法
  })

  it('跨月与跨年区间', () => {
    const days = keys('2026-08-31', '2026-09-01', '2026-12-31', '2027-01-01')
    expect(countCheckins(days, '2026-08-01', '2026-09-30')).toBe(2)
    expect(countCheckins(days, '2026-12-01', '2027-01-31')).toBe(2)
    expect(countCheckins(days, '2026-01-01', '2026-12-31')).toBe(3)
  })

  it('整年区间可覆盖跨年数据', () => {
    const days = keys('2025-12-31', '2026-01-01', '2026-12-31', '2027-01-01')
    expect(countCheckins(days, '2026-01-01', '2026-12-31')).toBe(2)
  })

  it('重复 dayKey 只算一天（与另外两个函数口径一致）', () => {
    const days = keys('2026-09-21', '2026-09-21', '2026-09-20')
    expect(countCheckins(days, '2026-09-20', '2026-09-21')).toBe(2)
  })

  it('乱序输入结果不变', () => {
    const days = keys('2026-09-21', '2026-09-19', '2026-09-20')
    expect(countCheckins(days, '2026-09-19', '2026-09-21')).toBe(3)
  })

  it('非法 from / to → RangeError', () => {
    const days = keys('2026-09-21')
    expect(() => countCheckins(days, 'garbage', '2026-09-30')).toThrow(RangeError)
    expect(() => countCheckins(days, '2026-09-01', 'garbage')).toThrow(RangeError)
    expect(() => countCheckins(days, '2026-02-30', '2026-09-30')).toThrow(RangeError)
  })
})

describe('三个函数的口径互洽（同一份 dayKeys 契约）', () => {
  const today = '2026-09-21'

  it('单日计数与休息日判定互补（dk ≤ today 时）', () => {
    const days = keys('2026-09-19', '2026-09-21')
    for (const dk of ['2026-09-19', '2026-09-20', '2026-09-21']) {
      const count = countCheckins(days, dk, dk)
      expect(count).toBe(isRestDay(days, dk, today) ? 0 : 1)
    }
  })

  it('未来日上两者不再互补：count 为 0，isRestDay 也是 false（未到 ≠ 休息）', () => {
    // 未来日的「无记录」与「休息」在计数上同形（都是 0），而 isRestDay 的 false
    // 正是在说「这里断言不了」——要区分空白 / 未到 / 休息，调用方得自己比 today。
    const days = keys('2026-09-19', '2026-09-21')
    expect(countCheckins(days, '2026-09-22', '2026-09-22')).toBe(0)
    expect(isRestDay(days, '2026-09-22', today)).toBe(false)
  })

  it('连续为正 ⇒ 今天或昨天必有记录', () => {
    const days = keys('2026-09-19', '2026-09-20')
    expect(currentStreak(days, today)).toBeGreaterThan(0)
    expect(isRestDay(days, today, today) && isRestDay(days, addDays(today, -1), today)).toBe(false)
  })
})

describe('纯函数纪律', () => {
  it('固定入参反复调用结果恒等', () => {
    const days = Object.freeze(['2026-09-19', '2026-09-20', '2026-09-21']) as readonly DayKey[]
    expect(currentStreak(days, '2026-09-21')).toBe(3)
    for (let i = 0; i < 5; i += 1) {
      expect(currentStreak(days, '2026-09-21')).toBe(3)
      expect(isRestDay(days, '2026-09-21', '2026-09-21')).toBe(false)
      expect(countCheckins(days, '2026-09-19', '2026-09-21')).toBe(3)
    }
  })

  it('不修改传入的数组（冻结数组上不抛错）', () => {
    const days = Object.freeze(['2026-09-20', '2026-09-21']) as readonly DayKey[]
    const snapshot = [...days]
    currentStreak(days, '2026-09-21')
    isRestDay(days, '2026-09-20', '2026-09-21')
    countCheckins(days, '2026-09-01', '2026-09-30')
    expect([...days]).toEqual(snapshot)
  })

  it('不读时钟：今天之外没有任何隐含的「现在」', () => {
    // 同一份 dayKeys 在不同 today 下给出各自的答案，没有第三个输入
    const days = keys('2026-09-19', '2026-09-20')
    expect(currentStreak(days, '2026-09-20')).toBe(2)
    expect(currentStreak(days, '2026-09-21')).toBe(2)
    expect(currentStreak(days, '2026-09-22')).toBe(0)
  })
})
