/**
 * 阶段 2 的实现细节（ADR-014 §2 阶段 2 / §6 的落点表 / §7 的重复落点）——矩阵之外的边界。
 */
import { describe, expect, it } from 'vitest'

import { hitSequence } from '@shared/recurrence'
import { addDays, compareDayKey, diffDays, weekStart } from '@shared/time'

import { firstFallOnOrAfter } from './lexicon'
import { resolveQuickAdd } from './resolve'
import { parseOn, project, resolveOn, TODAY } from './testing'

describe('抑制集（层③）', () => {
  it('按 token 的 `start` 命中；**忽略不存在的偏移**、不抛错', () => {
    const result = resolveOn('明天 写报告', TODAY, [], [999, -1, 0])
    expect(result.plannedDate).toBeNull()
    // 被 `×` 取消的碎片**文本回到标题**（见 matrix.test.ts 里那段引证）
    expect(result.title).toBe('明天 写报告')
  })

  it('被 `×` 取消的碎片进 `released`（它的原文仍在标题里）', () => {
    const result = resolveOn('明天 写报告', TODAY, [], [0])
    expect(result.released.map((token) => token.text)).toEqual(['明天'])
    expect(result.adopted).toEqual([])
  })

  it('取消重复碎片后，三个日期锚点回到普通任务的口径', () => {
    const parse = parseOn('明天 每天 写日记')
    const recurrence = parse.tokens.find((token) => token.kind === 'recurrence')
    const result = resolveQuickAdd(parse, [recurrence?.start as number])
    expect(result.recurrence).toBeNull()
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.title).toBe('每天 写日记') // `每天` 回到标题，`明天` 被采纳故从标题移除
  })

  it('抑制集为空数组与省略参数等价', () => {
    const parse = parseOn('明天 周五 写报告')
    expect(resolveQuickAdd(parse)).toEqual(resolveQuickAdd(parse, []))
  })
})

describe('落点表（§6）：非重复任务', () => {
  it('`date` → plannedDate、`plannedWeek` → plannedWeek、`dueDate` → dueDate', () => {
    expect(resolveOn('明天').plannedDate).toBe('2026-09-23')
    expect(resolveOn('下周').plannedWeek).toBe('2026-09-28')
    expect(resolveOn('{明天}').dueDate).toBe('2026-09-23')
    expect(resolveOn('!高').importance).toBe('high')
    expect(resolveOn('@a').tags).toEqual(['a'])
    expect(resolveOn('#实验', TODAY, [project('实验', 'p1')]).projectId).toBe('p1')
    expect(resolveOn('每天').recurrence).not.toBeNull()
  })

  it('`#` / `@` 只是名字，不进标题之外的任何字段', () => {
    const result = resolveOn('#实验 @科研 写报告', TODAY, [project('实验', 'p1')])
    expect(result.title).toBe('写报告')
    expect(result.tags).toEqual(['科研'])
  })
})

describe('落点表（§6）：重复任务（ADR-013 §3.1 的第二列）', () => {
  it('`date` → `startsOn` 的相位输入（不是 plannedDate）', () => {
    const result = resolveOn('明天 每天 写日记')
    expect(result.plannedDate).toBeNull()
    expect(result.recurrence?.startsOn).toBe('2026-09-23')
    // `明天` 是**被采纳的**（它参与了 startsOn 的决定）
    expect(result.adopted.map((token) => token.text)).toContain('明天')
  })

  it('`plannedWeek` → released（重复任务的 plannedWeek 恒空）', () => {
    const result = resolveOn('下周 每天 写日记')
    expect(result.plannedWeek).toBeNull()
    expect(result.released.map((token) => token.text)).toEqual(['下周'])
    expect(result.title).toBe('下周 写日记')
  })

  it('`dueDate` → released（`{…}` 退回标题，原文逐字保留）', () => {
    const result = resolveOn('每天 写日记 {下周五}')
    expect(result.dueDate).toBeNull()
    expect(result.released.map((token) => token.text)).toEqual(['{下周五}'])
    expect(result.title).toBe('写日记 {下周五}')
  })

  it('`importance` / `tags` / `projectId` / `recurrence` 在重复任务上照旧落点', () => {
    const result = resolveOn('每天 !高 @科研 #实验 写日记', TODAY, [project('实验', 'p1')])
    expect(result.importance).toBe('high')
    expect(result.tags).toEqual(['科研'])
    expect(result.projectId).toBe('p1')
    expect(result.recurrence?.rule).toEqual({ freq: 'daily', interval: 1 })
    expect(result.title).toBe('写日记')
  })

  it('三个日期锚点恒空是对**每一条**含重复碎片的输入的守约（输出侧自守）', () => {
    const inputs = [
      '每天',
      '明天 每天 写日记',
      '下周三 每天 写日记',
      '下周 每天 写日记',
      '9月23日 每周三 写周报',
      '每天 {下周五}',
      '下周 {明天} 每天',
    ]
    for (const text of inputs) {
      const result = resolveOn(text)
      expect(result.recurrence).not.toBeNull()
      expect([result.plannedDate, result.plannedWeek, result.dueDate]).toEqual([null, null, null])
    }
  })
})

describe('同去向字段「后到者胜」（§4.4）', () => {
  it('两个日期碎片：后到者胜', () => {
    expect(resolveOn('明天 周五 写报告').plannedDate).toBe('2026-09-25')
    expect(resolveOn('周五 明天 写报告').plannedDate).toBe('2026-09-23')
  })

  it('`date` 与 `plannedWeek` 同组（ADR-013 §5 的 CHECK：二者永不同时非空）', () => {
    const week = resolveOn('明天 下周 写报告')
    expect(week.plannedDate).toBeNull()
    expect(week.plannedWeek).toBe('2026-09-28')

    const day = resolveOn('下周 明天 写报告')
    expect(day.plannedDate).toBe('2026-09-23')
    expect(day.plannedWeek).toBeNull()
  })

  it('两个期限：后到者胜；两个优先级：后到者胜；两个项目：后到者胜', () => {
    expect(resolveOn('{明天} {下周五}').dueDate).toBe('2026-10-02')
    expect(resolveOn('!高 !低').importance).toBe('low')
    const projects = [project('实验', 'p1'), project('课程', 'p2')]
    expect(resolveOn('#实验 #课程', TODAY, projects).projectId).toBe('p2')
  })

  it('两个重复碎片：后到者胜', () => {
    expect(resolveOn('每天 每周三').recurrence?.rule).toEqual({
      freq: 'weekly',
      interval: 1,
      byDayOfWeek: [2],
    })
  })

  it('落选者进 `released`，其原文留在标题里（不然 `×` 之后再也拿不回来）', () => {
    const result = resolveOn('明天 周五 写报告')
    expect(result.released.map((token) => token.text)).toEqual(['明天'])
    expect(result.title).toBe('明天 写报告')
  })

  it('标签不参与竞争（全部采纳、去重保序）', () => {
    const result = resolveOn('@a @b @a 写报告')
    expect(result.tags).toEqual(['a', 'b'])
    expect(result.adopted.filter((token) => token.kind === 'tag')).toHaveLength(3)
  })
})

describe('`adopted` / `released` 与标题的一致性', () => {
  it('`adopted` 升序、是 `tokens` 的子序列；`adopted ∪ released === tokens`', () => {
    const parse = parseOn('明天 周五 写报告 每天 {下周五} @a', TODAY, [])
    const result = resolveQuickAdd(parse, [])
    const adoptedStarts = result.adopted.map((token) => token.start)
    expect([...adoptedStarts].sort((a, b) => a - b)).toEqual(adoptedStarts)
    expect(result.adopted.length + result.released.length).toBe(parse.tokens.length)
  })

  it('标题保留 `released` 的原文、删掉 `adopted` 的跨度', () => {
    const result = resolveOn('#实验 明天 写报告', TODAY, [project('实验', 'p1')])
    expect(result.adopted.map((token) => token.text)).toEqual(['#实验', '明天'])
    expect(result.title).toBe('写报告')
  })
})

describe('重复碎片与 `D₀`（§7）', () => {
  it('`D₀` = 裸日期片段 ?? today：没有裸日期时首轮是今天', () => {
    expect(resolveOn('每天 写日记').recurrence?.startsOn).toBe(TODAY)
    expect(resolveOn('每周三 写周报').recurrence?.startsOn).toBe('2026-09-23')
  })

  it('周级锚点不参与 `D₀`（它已被退回标题）', () => {
    expect(resolveOn('下周 每天 写日记').recurrence?.startsOn).toBe(TODAY)
  })

  it('`每月31号` 的首轮按夹取后的日号算（ADR-011 §3），不是 D₀', () => {
    // today = 2026-09-22：9 月的 31 号在 09-22 之后，故首轮 = 2026-09-30（9 月只有 30 天）
    expect(resolveOn('每月31号').recurrence?.startsOn).toBe('2026-09-30')
  })

  it('`每2周` 的首轮就是 `D₀`（规则无 `byDayOfWeek`）', () => {
    expect(resolveOn('每2周').recurrence?.startsOn).toBe(TODAY)
  })

  it('`nextAnchorMode` 取默认②`catch_up`（FR2.5），解析器不产出锚点模式的选项', () => {
    expect(resolveOn('每天').recurrence?.nextAnchorMode).toBe('catch_up')
  })

  it('`每年3月5日`：锚点月日写进 `startsOn`，规则本身不含 `BY*`', () => {
    const spec = resolveOn('每年3月5日').recurrence
    expect(spec?.rule).toEqual({ freq: 'yearly', interval: 1 })
    expect(spec?.startsOn).toBe('2027-03-05')
  })

  it('`每2年3月5日`：间隔 2，`startsOn` 仍是首个该月日', () => {
    const spec = resolveOn('每2年3月5日').recurrence
    expect(spec?.rule).toEqual({ freq: 'yearly', interval: 2 })
    expect(spec?.startsOn).toBe('2027-03-05')
  })

  it('重复碎片 + 裸日期：`startsOn` 按真正的 `D₀` 重算（不是扫描阶段的初值）', () => {
    // 扫描阶段的初值以 today 为 D₀（09-23），采纳的裸日期把它改判到 09-28
    const result = resolveOn('下周一 每周三 开组会')
    expect(result.recurrence?.startsOn).toBe('2026-09-30')
    expect(result.title).toBe('开组会')
  })

  it('`每年3月5日` 与裸日期同现：锚点按 `D₀` 重算', () => {
    // 裸日期 2027-03-06（今年 3月6日 已过）→ 首个 ≥ 它的 3月5日 = 2028-03-05
    const result = resolveOn('3月6日 每年3月5日 写日记')
    expect(result.recurrence?.rule).toEqual({ freq: 'yearly', interval: 1 })
    expect(result.recurrence?.startsOn).toBe('2028-03-05')
  })
})

describe('重复任务上不存在「startsOn 与 plannedDate 分叉」', () => {
  it('`plannedDate` 恒空，日期只有 `startsOn` 一个出处（ADR-013 §3.1）', () => {
    const result = resolveOn('明天 每周五 交周报')
    expect(result.plannedDate).toBeNull()
    expect(result.recurrence?.startsOn).toBe('2026-09-25')
  })
})

describe('多碎片组合（七个字段同时被写的情形）', () => {
  it('全字段：`明天 #实验 @科研 !高 {下周五} 写报告`', () => {
    const result = resolveOn('明天 #实验 @科研 !高 {下周五} 写报告', TODAY, [project('实验', 'p1')])
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.plannedWeek).toBeNull()
    expect(result.dueDate).toBe('2026-10-02')
    expect(result.importance).toBe('high')
    expect(result.tags).toEqual(['科研'])
    expect(result.projectId).toBe('p1')
    expect(result.recurrence).toBeNull()
    expect(result.title).toBe('写报告')
  })

  it('`下周五 每天`：`D₀` 是那个裸日期（不是 today），三个日期锚点全空', () => {
    const result = resolveOn('下周五 每天 交周报')
    expect(result.recurrence?.startsOn).toBe('2026-10-02')
    expect([result.plannedDate, result.plannedWeek, result.dueDate]).toEqual([null, null, null])
  })

  it('`每月15号 明天`：`D₀` 取从 `明天` 起（含）的第一个 15 号', () => {
    expect(resolveOn('每月15号 明天 写报告').recurrence?.startsOn).toBe('2026-10-15')
  })

  it('`{明天} 每天`：期限退回标题，但**不**参与 `D₀`（只有 `kind: date` 参与）', () => {
    const result = resolveOn('{明天} 每天 写日记')
    expect(result.recurrence?.startsOn).toBe(TODAY)
    expect(result.title).toBe('{明天} 写日记')
  })

  it('碎片顺序不影响结论（除同字段冲突外）：`@a !高 #实验 明天`', () => {
    const result = resolveOn('@a !高 #实验 明天 写报告', TODAY, [project('实验', 'p1')])
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.importance).toBe('high')
    expect(result.tags).toEqual(['a'])
    expect(result.projectId).toBe('p1')
    expect(result.title).toBe('写报告')
  })
})

describe('锚点构造的一致性（§7：两处算法不许漂移）', () => {
  it('`firstFallOnOrAfter` 真的取到了「第一个」落库日（周族逐星期核对，today=09-22 周二）', () => {
    for (let target = 0; target < 7; target += 1) {
      const startsOn = firstFallOnOrAfter({ freq: 'weekly', interval: 1, byDayOfWeek: [target] }, TODAY)
      expect(compareDayKey(startsOn, TODAY)).toBeGreaterThanOrEqual(0)
      // [today, startsOn) 里没有任何一天是该星期几 —— 这才是「不存在更早的落库日」
      for (let offset = 0; offset < diffDays(TODAY, startsOn); offset += 1) {
        const day = addDays(TODAY, offset)
        expect(diffDays(weekStart(day), day)).not.toBe(target)
      }
      expect(diffDays(weekStart(startsOn), startsOn)).toBe(target)
    }
  })

  it('月族：`每月31号` 的首轮是夹取后的 31 号（09-30），且更早没有落库日', () => {
    const startsOn = firstFallOnOrAfter({ freq: 'monthly', interval: 1, byMonthDay: [31] }, TODAY)
    expect(startsOn).toBe('2026-09-30')
    expect(compareDayKey(startsOn, TODAY)).toBeGreaterThanOrEqual(0)
  })

  it('`hitSequence` 的首元素恒为 `startsOn`（ADR-011 §4 规则 2）——本模块的 `startsOn` 正是靠它定义', () => {
    for (const text of ['每天', '每周三', '每2周', '每月31号', '每年3月5日']) {
      const spec = resolveOn(text).recurrence
      expect(spec).not.toBeNull()
      if (spec === null) continue
      expect(hitSequence(spec.rule, spec.startsOn).next().value).toBe(spec.startsOn)
    }
  })
})

describe('解析器的失败模式只有「不识别」', () => {
  const inputs = [
    '实验9-23组 交材料',
    '2月30日',
    '下午三点开会',
    '上午 交报告',
    '9点 开会',
    '每两个小时',
    '三天后',
    'tomorrow 写报告',
    '週三 写报告',
    '９月２３日',
  ]

  for (const text of inputs) {
    it(`\`${text}\` → 不抛错、日期锚点全空、原文逐字留在标题`, () => {
      const result = resolveOn(text)
      expect(result.plannedDate).toBeNull()
      expect(result.plannedWeek).toBeNull()
      expect(result.dueDate).toBeNull()
      expect(result.title).toBe(text)
    })
  }

  it('时刻词是**部分识别**：`明天上午 交报告` → 识别 `明天`、`上午` 留标题', () => {
    const result = resolveOn('明天上午 交报告')
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.title).toBe('上午 交报告')
  })

  it('`每天上午` → 重复 = 每天，`上午` 留标题（部分识别是正确行为）', () => {
    const result = resolveOn('每天上午 吃药')
    expect(result.recurrence?.rule).toEqual({ freq: 'daily', interval: 1 })
    expect(result.title).toBe('上午 吃药')
  })
})
