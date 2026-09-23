/**
 * 任务界面里**纯函数那一层**的单测。
 *
 * 跑法：`npx vitest run src`（组件测试需要 DOM，本项目没装 jsdom，故这里只测纯函数）。
 *
 * 测的为什么是这三样：它们是「ADR 的措辞与落点」在 `src/` 里唯一有实现的地方，
 * 而其中两处一旦写错**症状都很隐蔽**——
 * 粒度写错会让预览用错的粒度回答用户（ADR-014 §4.3 说那比不显示更糟），
 * `importance` 兜底成 `'normal'` 会造出第二个默认值（ADR-014 §6 明令禁止）。
 */
import { describe, expect, it } from 'vitest'
import { parseQuickAdd, resolveQuickAdd, type QuickAddContext } from '@shared/quickadd'
import type { DayKey, TimeContext } from '@shared/time'
import { describeDate, describePlannedWeek, relativeHint } from './day-text'
import { describeRule } from './rule-text'
import { quickAddToCreateInput } from './payload'

const CTX: TimeContext = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }
const TODAY: DayKey = '2026-09-23' // 周三
const NOON = new Date('2026-09-23T12:00:00+08:00')

function resolve(text: string, now: Date = NOON) {
  const ctx: QuickAddContext = { now, timeContext: CTX, projects: [] }
  return resolveQuickAdd(parseQuickAdd(text, ctx))
}

describe('日期呈现（ADR-009 §6 / ADR-014 §4.3）', () => {
  it('相对词与绝对日期各司其职：绝对日期走 formatDayKey，相对词是调用方的措辞', () => {
    expect(relativeHint('2026-09-23', TODAY)).toBe('今天')
    expect(relativeHint('2026-09-24', TODAY)).toBe('明天')
    expect(relativeHint('2026-09-22', TODAY)).toBe('昨天')
    expect(relativeHint('2026-09-26', TODAY), '大后天是词表里的词，不走「N 天后」').toBe('大后天')
    expect(relativeHint('2026-09-27', TODAY)).toBe('4 天后')
    expect(describeDate('2026-09-24', TODAY)).toBe('9月24日(明天)')
  })

  it('跨年的绝对日期自动换成长式（年份不同才带年）', () => {
    // 同一年用短式；不同年用长式——判据在 `describeDay` 里，这里钉住它的可见结果
    expect(describeDate('2026-12-31', TODAY)).toBe('12月31日(99 天后)')
    expect(describeDate('2027-01-05', TODAY)).toContain('2027年1月5日')
  })

  it('周级锚点的粒度是**周**，绝不折算成周一那一天', () => {
    expect(describePlannedWeek('2026-09-28')).toBe('9月28日那一周')
    // 入参是「该周内任意一天」：`formatWeek` 内部折周一，故周三进、周一那一周出
    expect(describePlannedWeek('2026-09-30')).toBe('9月28日那一周')
  })
})

describe('重复规则的可读文案', () => {
  it('间隔为 1 时不写数字', () => {
    expect(describeRule({ freq: 'daily', interval: 1 })).toBe('每天')
    expect(describeRule({ freq: 'daily', interval: 2 })).toBe('每 2 天')
  })

  it('周族的星期索引是 0 = 周一（ADR-011 的唯一口径）', () => {
    expect(describeRule({ freq: 'weekly', interval: 1, byDayOfWeek: [2] })).toBe('每周三')
    expect(describeRule({ freq: 'weekly', interval: 1, byDayOfWeek: [6] })).toBe('每周日')
  })

  it('月族的 `-1` 是月末', () => {
    expect(describeRule({ freq: 'monthly', interval: 1, byMonthDay: [31] })).toBe('每月31 号')
    expect(describeRule({ freq: 'monthly', interval: 1 })).toBe('每月')
    expect(describeRule({ freq: 'monthly', interval: 3, byMonthDay: [-1] })).toBe('每 3 个月月末')
  })
})

describe('快速录入 → 新建载荷（ADR-014 §6 / ADR-017 §3）', () => {
  it('**没写优先级时整条 `importance` 键都不出现**（默认值只有服务端一处）', () => {
    const input = quickAddToCreateInput(resolve('明天 写报告'), 'fixed-id')
    expect(Object.hasOwn(input, 'importance'), '没写 `!高/!中/!低` 就不该有 importance 键').toBe(
      false,
    )
    expect(input.taskId).toBe('fixed-id')
    expect(input.title).toBe('写报告')
    expect(input.plannedDate).toBe('2026-09-24')
  })

  it('写了 `!中` 时 `importance` **显式存在**（与「没写」可区分）', () => {
    const input = quickAddToCreateInput(resolve('明天 写报告 !中'), 'fixed-id')
    expect(input.importance).toBe('normal')
  })

  it('`下周` 落 `plannedWeek`，`plannedDate` 恒为空——粒度就是用户选的层级', () => {
    const input = quickAddToCreateInput(resolve('下周 交周报'), 'fixed-id')
    expect(input.plannedWeek).toBe('2026-09-28')
    expect(input.plannedDate).toBeNull()
  })

  it('`{…}` 落期限，且它不污染计划日', () => {
    const input = quickAddToCreateInput(resolve('写周报 {下周五}'), 'fixed-id')
    expect(input.dueDate).toBe('2026-10-02')
    expect(input.plannedDate).toBeNull()
  })

  it('重复任务的三个日期锚点恒空（ADR-013 §3.1），起算日进 `startsOn`', () => {
    const input = quickAddToCreateInput(resolve('明天 每天 写日记'), 'fixed-id')
    expect(input.recurrence).not.toBeNull()
    expect(input.recurrence?.startsOn).toBe('2026-09-24')
    expect(input.plannedDate).toBeNull()
    expect(input.plannedWeek).toBeNull()
    expect(input.dueDate).toBeNull()
  })

  it('碎片被 `×` 取消之后，提交载荷里就没有那一个字段（取消是真的取消了）', () => {
    const ctx: QuickAddContext = { now: NOON, timeContext: CTX, projects: [] }
    const parse = parseQuickAdd('明天 写报告', ctx)
    const result = resolveQuickAdd(parse, [0]) // 抑制偏移 0 = `明天`
    const input = quickAddToCreateInput(result, 'fixed-id')
    expect(input.plannedDate).toBeNull()
    expect(input.title, '被取消的碎片原文回到标题').toBe('明天 写报告')
  })

  it('每次调用给出不同的 taskId（UUIDv7，ADR-017 §5）', () => {
    const a = quickAddToCreateInput(resolve('甲'), undefined)
    const b = quickAddToCreateInput(resolve('甲'), undefined)
    expect(a.taskId).not.toBe(b.taskId)
    expect(a.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
