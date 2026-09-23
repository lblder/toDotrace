/**
 * 项目区间运算的测试矩阵（ADR-016 §2 的算例 + §后果「必须覆盖的测试矩阵」的区间各行）。
 *
 * 第一条用例**逐字复现 ADR-016 §2 的算例**：项目 `2026-09-10 ~ 2026-09-25`
 * （9/10 是周四、9/25 是周五）→ `daysOfProject = 16`；跨 3 个自然周，
 * 落在区间内的天数依次为 **4 / 7 / 5**。那三个数字已在本文件外用日历独立核过，
 * 此处不再用 `diffDays` 反算（否则就是把实现抄一遍当断言）。
 *
 * 本文件只经 `@shared/time` 取日期原语；**不导入任何瞬间 API**——
 * ADR-016 §8 的 `dayEndInstant` 陷阱用「DayKey 坐标上的行为」钉住（见下）。
 */
import { describe, expect, it } from 'vitest'

import { addDays, weekStart } from '@shared/time'
import {
  covers,
  daysOfProject,
  daysOfWeekInProject,
  projectState,
  projectsOfDay,
  weeksOfProject,
} from './index'
import type { ProjectInterval, ProjectWithId } from './index'

/** ADR-016 §2 的算例区间。9/10 周四、9/25 周五 —— 由下一组用例另行钉住 */
const SEPT: ProjectInterval = { startsOn: '2026-09-10', endsOn: '2026-09-25' }

describe('ADR-016 §2 的算例：2026-09-10 ~ 2026-09-25', () => {
  it('先钉住日历本身：9/10 是周四、9/25 是周五（9/7 那一周的周一是 9/7）', () => {
    expect(weekStart('2026-09-10')).toBe('2026-09-07') // 周四 → 本周一
    expect(weekStart('2026-09-25')).toBe('2026-09-21') // 周五 → 本周一
    expect(addDays('2026-09-10', -3)).toBe('2026-09-07')
    expect(addDays('2026-09-25', -4)).toBe('2026-09-21')
  })

  it('daysOfProject = 16（**漏 `+1` 的回归**：闭区间含两端）', () => {
    expect(daysOfProject(SEPT)).toBe(16)
  })

  it('weeksOfProject = 3 个周一，升序，首尾都是不完整的周', () => {
    expect(weeksOfProject(SEPT)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21'])
  })

  it('daysOfWeekInProject 依次 4 / 7 / 5（首周 4 天、整周 7 天、末周 5 天）', () => {
    expect(daysOfWeekInProject(SEPT, '2026-09-07')).toBe(4) // 9/10（周四）~ 9/13（周日）
    expect(daysOfWeekInProject(SEPT, '2026-09-14')).toBe(7) // 完整的一周
    expect(daysOfWeekInProject(SEPT, '2026-09-21')).toBe(5) // 9/21（周一）~ 9/25（周五）
  })

  it('三个周的天数之和 = daysOfProject（跨周不重不漏）', () => {
    const sum = weeksOfProject(SEPT)
      .map((w) => daysOfWeekInProject(SEPT, w))
      .reduce((a, b) => a + b, 0)
    expect(sum).toBe(daysOfProject(SEPT))
  })
})

describe('区间算术：闭区间、含两端、跨年、闰日', () => {
  it('起止同日 = 1 天项目（FR2.8「长短完全自定义」，合法）', () => {
    expect(daysOfProject({ startsOn: '2026-09-10', endsOn: '2026-09-10' })).toBe(1)
  })

  it('跨年：2026-12-28 ~ 2027-01-05 = 9 天', () => {
    expect(daysOfProject({ startsOn: '2026-12-28', endsOn: '2027-01-05' })).toBe(9)
  })

  it('闰日：2028-02-28 ~ 2028-02-29 = 2 天（2028 是闰年）', () => {
    expect(daysOfProject({ startsOn: '2028-02-28', endsOn: '2028-02-29' })).toBe(2)
  })

  it('整月 30 天 / 整年 365 天（2026 不是闰年）', () => {
    expect(daysOfProject({ startsOn: '2026-09-01', endsOn: '2026-09-30' })).toBe(30)
    expect(daysOfProject({ startsOn: '2026-01-01', endsOn: '2026-12-31' })).toBe(365)
  })

  it('跨年的项目：weeksOfProject 跨过 12 月，仍是连续升序的周一', () => {
    const p: ProjectInterval = { startsOn: '2026-12-28', endsOn: '2027-01-05' }
    expect(weeksOfProject(p)).toEqual(['2026-12-28', '2027-01-04'])
    expect(daysOfWeekInProject(p, '2026-12-28')).toBe(7)
    expect(daysOfWeekInProject(p, '2027-01-04')).toBe(2)
  })
})

describe('端点：闭区间（含两端），差一天就是这里错的', () => {
  it('covers 含两端：startsOn 与 endsOn 均为真', () => {
    expect(covers(SEPT, '2026-09-10')).toBe(true)
    expect(covers(SEPT, '2026-09-25')).toBe(true)
  })

  it('covers 排除两端之外各一天', () => {
    expect(covers(SEPT, '2026-09-09')).toBe(false)
    expect(covers(SEPT, '2026-09-26')).toBe(false)
  })

  it('covers 在两端之内侧为真（不是只有端点特殊）', () => {
    expect(covers(SEPT, '2026-09-11')).toBe(true)
    expect(covers(SEPT, '2026-09-24')).toBe(true)
  })

  it('dayEndInstant 陷阱（负向）：上界是 endsOn 本身，不是「次日起始」', () => {
    // ADR-009 §7 已定 dayEndInstant(dk) 是**排他上界**，返回的是**次日** dayStartHour:00；
    // 把上界瞬间反解回 DayKey 会得到 addDays(endsOn, 1)（ADR-016 §8 实测其实现为
    // dayStartInstant(addDays(dk, 1))）。本模块**不导入它**，此处只把后果钉死：
    expect(covers(SEPT, addDays(SEPT.endsOn, 1))).toBe(false) // 那个「多出来的一天」不在区间内
    expect(daysOfProject(SEPT)).toBe(16) // 不是 17（把上界当成次日起始，多算一天）
    // 也不是 15（把闭区间误当半开的 [startsOn, endsOn) 去数）
  })

  it('covers 与 daysOfProject 互证：逐日枚举出的天数与 daysOfProject 相等', () => {
    let count = 0
    for (let d = SEPT.startsOn; covers(SEPT, d); d = addDays(d, 1)) count += 1
    expect(count).toBe(daysOfProject(SEPT))
    // 枚举确实走到了 endsOn 为止（不是提前一位停下）
    expect(count).toBe(16)
  })
})

describe('不完整的周', () => {
  it('完整的一周返回 7；完全不相干的周返回 0', () => {
    expect(daysOfWeekInProject(SEPT, '2026-09-14')).toBe(7)
    expect(daysOfWeekInProject(SEPT, '2026-08-31')).toBe(0)
    expect(daysOfWeekInProject(SEPT, '2026-10-05')).toBe(0)
  })

  it('恰好是整周的项目：weeksOfProject 只有 1 个，且该周为 7', () => {
    const p: ProjectInterval = { startsOn: '2026-09-14', endsOn: '2026-09-20' }
    expect(weeksOfProject(p)).toEqual(['2026-09-14'])
    expect(daysOfWeekInProject(p, '2026-09-14')).toBe(7)
    expect(daysOfProject(p)).toBe(7)
  })

  it('只落在周内的部分天：区间 9/10~9/11 落在 9/7 那一周 = 2 天', () => {
    const p: ProjectInterval = { startsOn: '2026-09-10', endsOn: '2026-09-11' }
    expect(weeksOfProject(p)).toEqual(['2026-09-07'])
    expect(daysOfWeekInProject(p, '2026-09-07')).toBe(2)
  })
})

describe('projectsOfDay：重叠项目返回数组，按 (startsOn, id) 稳定排序', () => {
  const A: ProjectWithId = { id: 'p-a', startsOn: '2026-09-01', endsOn: '2026-09-30' }
  const B: ProjectWithId = { id: 'p-b', startsOn: '2026-09-10', endsOn: '2026-09-25' }
  const C: ProjectWithId = { id: 'p-c', startsOn: '2026-09-10', endsOn: '2026-09-20' }
  const D: ProjectWithId = { id: 'p-d', startsOn: '2026-09-10', endsOn: '2026-09-30' }
  const Z: ProjectWithId = { id: 'p-z', startsOn: '2026-12-01', endsOn: '2026-12-02' }
  const all: ProjectWithId[] = [B, C, Z, A, D] // 刻意不按顺序

  const idsOf = (dk: string): string[] => projectsOfDay(all, dk).map((p) => p.id)

  it('四个项目重叠的一天全部返回（重叠是允许的，不做冲突消解，也不静默丢掉任何一个）', () => {
    expect(idsOf('2026-09-15')).toEqual(['p-a', 'p-b', 'p-c', 'p-d'])
    expect(projectsOfDay(all, '2026-09-15')).toHaveLength(4)
  })

  it('排序键是 (startsOn, id)：先按起始日，同起始日再按 id 升序', () => {
    // 9/1 的 A 在最前；9/10 起的三个按 id：p-b < p-c < p-d
    expect(idsOf('2026-09-15')).toEqual(['p-a', 'p-b', 'p-c', 'p-d'])
    // p-c 在 9/20 结束：9/22 只剩 A、B、D
    expect(idsOf('2026-09-22')).toEqual(['p-a', 'p-b', 'p-d'])
  })

  it('id 用字符串序比较（不是 localeCompare）：UUIDv7 的字典序即生成序', () => {
    const early: ProjectWithId = {
      id: '01a0c70d-7b55-7001-9751-0d4f8c5e4e24',
      startsOn: '2026-09-10',
      endsOn: '2026-09-30',
    }
    const late: ProjectWithId = {
      id: '01a0c70d-7b55-7002-bcdc-7c8ef14943ff',
      startsOn: '2026-09-10',
      endsOn: '2026-09-30',
    }
    // 起始日相同 ⇒ 先建的（id 小的）在前，与「id 序 === 时间序」一致
    expect(projectsOfDay([late, early], '2026-09-15').map((p) => p.id)).toEqual([
      early.id,
      late.id,
    ])
  })

  it('没有项目覆盖该日 ⇒ 空数组（正常状态，不是异常）', () => {
    expect(projectsOfDay(all, '2026-10-01')).toEqual([])
    expect(projectsOfDay([], '2026-09-15')).toEqual([])
  })

  it('边界含两端：项目的首日与末日都在，前后各一天都不在', () => {
    expect(idsOf('2026-09-10')).toContain('p-b')
    expect(idsOf('2026-09-25')).toContain('p-b')
    expect(idsOf('2026-09-09')).not.toContain('p-b')
    expect(idsOf('2026-09-26')).not.toContain('p-b')
  })

  it('结果与输入顺序无关（「增量 == 全量重建」可逐字段断言的那一半）', () => {
    const permutations = [
      [A, B, C, D, Z],
      [Z, D, C, B, A],
      [C, A, D, Z, B],
      [...all].reverse(),
    ]
    for (let offset = 0; offset < 31; offset += 1) {
      const dk = addDays('2026-09-01', offset)
      const full = projectsOfDay(all, dk)
      for (const ps of permutations) {
        const other = projectsOfDay(ps, dk)
        expect(other).toEqual(full) // 逐字段相等（含 id / startsOn / endsOn）
        expect(other.map((p) => `${p.id}|${p.startsOn}|${p.endsOn}`)).toEqual(
          full.map((p) => `${p.id}|${p.startsOn}|${p.endsOn}`),
        )
      }
    }
  })

  it('纯函数：不修改传入的数组（冻结的输入也能算）', () => {
    const frozen = Object.freeze([B, C, A]) as readonly ProjectWithId[]
    expect(projectsOfDay(frozen, '2026-09-15').map((p) => p.id)).toEqual(['p-a', 'p-b', 'p-c'])
    expect(frozen.map((p) => p.id)).toEqual(['p-b', 'p-c', 'p-a']) // 原数组顺序未变
  })
})

describe('projectState：三态派生，不落库（ADR-016 §4）', () => {
  it('区间前 = upcoming、区间内 = active、区间后 = ended', () => {
    expect(projectState(SEPT, '2026-09-09')).toBe('upcoming')
    expect(projectState(SEPT, '2026-09-15')).toBe('active')
    expect(projectState(SEPT, '2026-09-26')).toBe('ended')
  })

  it('边界：首日与末日都算 active（闭区间）；ended ⇔ today > endsOn', () => {
    expect(projectState(SEPT, '2026-09-10')).toBe('active')
    expect(projectState(SEPT, '2026-09-25')).toBe('active')
    expect(projectState(SEPT, '2026-09-26')).toBe('ended')
    expect(projectState(SEPT, '2026-09-09')).toBe('upcoming')
  })

  it('一天的项目的三态：当天 active，前后各一天为 upcoming / ended', () => {
    const oneDay: ProjectInterval = { startsOn: '2026-09-10', endsOn: '2026-09-10' }
    expect(projectState(oneDay, '2026-09-09')).toBe('upcoming')
    expect(projectState(oneDay, '2026-09-10')).toBe('active')
    expect(projectState(oneDay, '2026-09-11')).toBe('ended')
  })
})

describe('非法输入：抛错而不是静默算出无意义的结果', () => {
  const reversed: ProjectInterval = { startsOn: '2026-09-25', endsOn: '2026-09-10' }

  it('反向区间（起晚于止）逐个函数抛 RangeError', () => {
    expect(() => daysOfProject(reversed)).toThrow(RangeError)
    expect(() => covers(reversed, '2026-09-20')).toThrow(RangeError)
    expect(() => weeksOfProject(reversed)).toThrow(RangeError)
    expect(() => daysOfWeekInProject(reversed, '2026-09-14')).toThrow(RangeError)
    expect(() => projectState(reversed, '2026-09-20')).toThrow(RangeError)
    expect(() => projectsOfDay([{ ...reversed, id: 'p-reversed' }], '2026-09-20')).toThrow(RangeError)
  })

  it('daysOfWeekInProject 的 weekStart 必须是周一：给周中的日子抛 RangeError', () => {
    // 2026-09-10 是周四。静默按「它所在的那一周」折算会让「本周」的含义
    // 取决于调用方是否记得先折周一——本模块选择抛错（口径由调用方显式定）。
    expect(() => daysOfWeekInProject(SEPT, '2026-09-10')).toThrow(RangeError)
    expect(() => daysOfWeekInProject(SEPT, '2026-09-07')).not.toThrow()
  })

  it('非法 DayKey 由 @shared/time 把关（本模块不自写日期校验）', () => {
    expect(() => daysOfProject({ startsOn: '2026-13-45', endsOn: '2026-09-30' })).toThrow(RangeError)
    expect(() => covers(SEPT, 'garbage')).toThrow(RangeError)
  })
})
