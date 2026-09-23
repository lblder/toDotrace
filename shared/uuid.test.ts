/**
 * UUIDv7 生成器的性质固化（ADR-017 §5.1 ③）。
 *
 * 搬迁前**没有独立的 uuid 测试**——它只被 `server/tests/events-append.test.ts` 与
 * `server/tests/credentials.test.ts` 间接覆盖（后者有一条形态 + 单调性断言）。
 * 本文件把现有实现已经隐含保证、且**下游真的在依赖**的性质逐条钉死，
 * 免得搬一次家就把它们搬丢：
 *
 * 1. 形态：版本位 `7`、variant 位 `10`、定长 36、全小写
 *    （`shared/recurrence/types.ts`：字典序 === 时间序，依赖的正是这三样）；
 * 2. **同一毫秒内连续生成的 id 严格递增**——这是这套 id 能当排序键的**全部依据**；
 * 3. **时钟回拨时不产生逆序 id**（沿用上一次的时间戳并继续递增计数器）。
 *
 * 时钟用 `vi.spyOn(Date, 'now')` 冻结 / 回拨。冻结而非快进，是为了让
 * 「同一毫秒」在测试里**真的**是同一毫秒，而不是「跑得够快的话大概是」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isUuidV7, uuidv7 } from './uuid'

const UUID_V7_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * 前 12 位十六进制 = 48 位毫秒时间戳。
 * ⚠️ 不能图省事写 `id.slice(0, 12)`：那会连第 9 位的 `-` 一起截进来、
 * 又把时间戳**最后一个半字节**丢掉，于是「相差 1 毫秒」看起来完全一样。
 */
function stampOf(id: string): string {
  return id.slice(0, 8) + id.slice(9, 13)
}

/** id 的 12 位计数器值：byte6 的低 4 位（第 15 个字符）+ byte7（第 16–17 个字符） */
function seqOf(id: string): number {
  return Number.parseInt(id.slice(15, 16) + id.slice(16, 18), 16)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('形态：版本位 7 / variant 位 10 / 定长 36 小写', () => {
  it('连续生成的 id 全部符合 UUIDv7 规格，且 isUuidV7 认它', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7()
      expect(id).toMatch(UUID_V7_SHAPE)
      expect(id).toHaveLength(36)
      expect(id).toBe(id.toLowerCase())
      expect(id.charAt(14)).toBe('7') // 版本位
      expect('89ab').toContain(id.charAt(19)) // variant 位 10
      expect(isUuidV7(id)).toBe(true)
    }
  })

  it('isUuidV7 拒绝：v4、大写、定长不符、非十六进制、空串', () => {
    const valid = uuidv7()
    expect(isUuidV7(valid)).toBe(true)
    // 版本位不是 7（v4 的形态）：只动第 15 个字符（版本半字节），别处一字不改
    expect(isUuidV7(`${valid.slice(0, 14)}4${valid.slice(15)}`)).toBe(false)
    // variant 位不是 10（把第 20 个字符换成 0）
    expect(isUuidV7(`${valid.slice(0, 19)}0${valid.slice(20)}`)).toBe(false)
    // 大写：ADR-001 的排序性质依赖小写，故大写必须被拒（不是「宽容接受」）
    expect(isUuidV7(valid.toUpperCase())).toBe(false)
    // 长度不符
    expect(isUuidV7(valid.slice(0, 35))).toBe(false)
    expect(isUuidV7(`${valid}0`)).toBe(false)
    // 非十六进制 / 空串
    expect(isUuidV7(valid.replace(valid.charAt(0), 'z'))).toBe(false)
    expect(isUuidV7('')).toBe(false)
  })
})

describe('单调性：同一毫秒内严格递增（id 能当排序键的全部依据）', () => {
  it('冻结在同一毫秒里的 1000 个 id：严格递增、互不相同、计数器逐次 +1', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const ids = Array.from({ length: 1000 }, () => uuidv7())

    expect(new Set(ids).size).toBe(1000) // 互不相同
    for (let i = 1; i < ids.length; i += 1) {
      // 相邻两个都必须严格递增（不是「大概率递增」）
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
    // 排序即生成序：以 id 为排序键 = 以生成顺序为序（ADR-001 §1）
    expect([...ids].sort()).toEqual(ids)
    // 1000 个都落在同一毫秒 ⇒ 时间戳前缀逐字相同，递增只能来自 12 位计数器。
    // 这一条同时说明：**不要**指望靠时间戳区分同一毫秒内的 id。
    expect(new Set(ids.map(stampOf)).size).toBe(1)
    // 计数器是「每生成一个 +1」，而不是随机数或别的什么
    for (let i = 1; i < ids.length; i += 1) {
      expect(seqOf(ids[i]!) - seqOf(ids[i - 1]!)).toBe(1)
    }
  })

  it('跨毫秒：时间戳推进时同样严格递增', () => {
    let now = Date.now() + 500_000 // 给足余量，保证第一次调用真的走「时间戳推进」分支
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const first = uuidv7()
    now += 1
    const second = uuidv7()
    now += 1
    const third = uuidv7()

    expect([third, first, second].sort()).toEqual([first, second, third])
    expect(stampOf(third)).not.toBe(stampOf(first))
  })

  it('时钟回拨：不产生逆序 id（沿用上一次的时间戳并继续递增计数器）', () => {
    const base = Date.now() + 1_000_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(base)

    const before = uuidv7()
    spy.mockReturnValue(base - 5_000) // 时钟回拨 5 秒
    const afterFirst = uuidv7()
    const afterSecond = uuidv7()

    // 宁可让 id 的时间戳略微超前，也不产生逆序 id
    expect(afterFirst > before).toBe(true)
    expect(afterSecond > afterFirst).toBe(true)
    // 「略超前」的具体做法：沿用回拨前那个更高的时间戳
    expect(stampOf(afterFirst)).toBe(stampOf(before))
  })

  it('计数器溢出（4096/ms）时自旋等到下一毫秒，仍是严格递增', () => {
    const frozen = Date.now() + 2_000_000
    let calls = 0
    // 前 4100 次读时钟返回同一个毫秒（够生成 4096 个 id 把计数器撑满），
    // 之后返回下一毫秒——否则溢出分支的自旋会**永远**转下去。
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1
      return calls <= 4100 ? frozen : frozen + 1
    })

    const ids = Array.from({ length: 4100 }, () => uuidv7())

    expect(new Set(ids).size).toBe(4100)
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
    // 溢出确实发生过：生成过程中时间戳从 frozen 跳到了 frozen + 1
    expect(stampOf(ids.at(-1)!)).not.toBe(stampOf(ids[0]!))
  })
})
