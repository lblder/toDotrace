/**
 * ADR-014 §后果「必须覆盖的测试矩阵」——**逐行**对应用例。
 *
 * 矩阵是最低要求，不是上限；本文件按矩阵的行序组织，每行一个 `describe`。
 * 额外的边界与实现细节在 `scan.test.ts` / `resolve.test.ts`。
 */
import { describe, expect, it } from 'vitest'

import { hitSequence, validateRule } from '@shared/recurrence'
// `firstHitAtOrAfter` 尚未从 `@shared/recurrence` 的 index 转出（它在 `./hits` 里），
// 故测试直接取那个文件——测试导入不受「运行时只许 @shared/time」的白名单约束（§8）。
import { firstHitAtOrAfter } from '@shared/recurrence/hits'
import { compareDayKey, diffDays, weekEnd, weekStart } from '@shared/time'

import { canSubmit, describeDay, describeWeek, parseQuickAdd, resolveQuickAdd } from './index'
import { resolveOn, parseOn, project, recurrenceOf, TODAY } from './testing'
import type { QuickAddToken } from './types'

/** 计划日 / 计划周 / 期限 三个锚点 + 标题的便捷读取 */
function fields(text: string, dayKey: string = TODAY, projects: readonly { id: string; name: string }[] = []) {
  const result = resolveOn(text, dayKey, projects)
  return {
    plannedDate: result.plannedDate,
    plannedWeek: result.plannedWeek,
    dueDate: result.dueDate,
    title: result.title,
    result,
  }
}

describe('整串引号（层①）', () => {
  it('`"明天 写报告"` → 无 token、title 逐字（`\\` 也不处理）', () => {
    const parse = parseOn('"明天 写报告"')
    expect(parse.quoted).toBe(true)
    expect(parse.tokens).toEqual([])
    expect(parse.escapeOffsets).toEqual([])
    const { result } = fields('"明天 写报告"')
    expect(result.title).toBe('明天 写报告')
    expect(result.plannedDate).toBeNull()
    expect(result.adopted).toEqual([])
    expect(result.released).toEqual([])
  })

  it('`"\\明天"` 引号内不处理转义，title = `\\明天`', () => {
    expect(fields('"\\明天"').result.title).toBe('\\明天')
    expect(fields('"\\明天"').result.plannedDate).toBeNull()
  })

  it('单侧引号不触发', () => {
    expect(parseOn('"明天').quoted).toBe(false)
    expect(parseOn('明天"').quoted).toBe(false)
  })

  it('`""` → title 为空串、canSubmit false', () => {
    const { result } = fields('""')
    expect(result.title).toBe('')
    expect(canSubmit(result)).toBe(false)
  })

  it('`"a" "b"` → 触发（已知副作用，固化它）', () => {
    const parse = parseOn('"a" "b"')
    expect(parse.quoted).toBe(true)
    expect(fields('"a" "b"').result.title).toBe('a" "b')
  })
})

describe('转义（层②）', () => {
  it('`\\明天 写报告` → 无 token、title = `明天 写报告`', () => {
    const parse = parseOn('\\明天 写报告')
    expect(parse.tokens).toEqual([])
    expect(parse.escapeOffsets).toEqual([0])
    expect(fields('\\明天 写报告').result.title).toBe('明天 写报告')
    expect(fields('\\明天 写报告').result.plannedDate).toBeNull()
  })

  it('`\\\\明天` → title = `\\明天`（第一个 `\\` 留字面，第二个命中转义）', () => {
    const parse = parseOn('\\\\明天')
    expect(parse.escapeOffsets).toEqual([1])
    expect(fields('\\\\明天').result.title).toBe('\\明天')
  })

  it('`C:\\path 写报告` → `\\` 原样保留（未命中任何规则）', () => {
    const parse = parseOn('C:\\path 写报告')
    expect(parse.tokens).toEqual([])
    expect(parse.escapeOffsets).toEqual([])
    expect(fields('C:\\path 写报告').result.title).toBe('C:\\path 写报告')
  })

  it('`\\周五 明天` → `周五` 字面、`明天` 识别', () => {
    const parse = parseOn('\\周五 明天')
    expect(parse.tokens).toHaveLength(1)
    expect(parse.tokens[0]?.text).toBe('明天')
    const { result } = fields('\\周五 明天')
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.title).toBe('周五')
  })
})

describe('最长匹配', () => {
  it('`大后天` → +3 天，且不留 `大` 残字', () => {
    expect(fields('大后天').plannedDate).toBe('2026-09-25')
    expect(fields('大后天').title).toBe('')
  })

  it('`后天` → +2 天', () => {
    expect(fields('后天').plannedDate).toBe('2026-09-24')
  })

  it('`下下周` → plannedWeek = 下下周周一；`下周` → plannedWeek = 下周一', () => {
    expect(fields('下下周').plannedWeek).toBe('2026-10-05')
    expect(fields('下下周').plannedDate).toBeNull()
    expect(fields('下周').plannedWeek).toBe('2026-09-28')
    expect(fields('下周').plannedDate).toBeNull()
  })

  it('`下周三` → plannedDate = 下周三（第 5 行先于第 6 行命中）', () => {
    expect(fields('下周三').plannedDate).toBe('2026-09-30')
    expect(fields('下周三').plannedWeek).toBeNull()
  })

  it('`每周三` → weekly + byDayOfWeek:[2]', () => {
    expect(recurrenceOf('每周三')?.rule).toEqual({ freq: 'weekly', interval: 1, byDayOfWeek: [2] })
  })

  it('`每月15号` → monthly + byMonthDay:[15]', () => {
    expect(recurrenceOf('每月15号')?.rule).toEqual({ freq: 'monthly', interval: 1, byMonthDay: [15] })
  })
})

describe('`周五` 规则（参数化：§4.1「下一个到来，含今天」）', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['2026-09-22', '2026-09-25'], // 周二 → 本周五
    ['2026-09-25', '2026-09-25'], // 周五 → **今天**
    ['2026-09-26', '2026-10-02'], // 周六 → 下周五（不是刚过去的昨天）
    ['2026-09-21', '2026-09-25'], // 周一 → 本周五
  ]
  for (const [today, expected] of cases) {
    it(`today=${today} → ${expected}`, () => {
      expect(fields('周五', today).plannedDate).toBe(expected)
    })
  }
})

describe('周前缀（§4.3）', () => {
  it('today=09-22：本周五/这周五=09-25、下周五=10-02、上周五=09-18、下下周五=10-09、上上周五=09-11', () => {
    expect(fields('本周五').plannedDate).toBe('2026-09-25')
    expect(fields('这周五').plannedDate).toBe('2026-09-25')
    expect(fields('下周五').plannedDate).toBe('2026-10-02')
    expect(fields('上周五').plannedDate).toBe('2026-09-18')
    expect(fields('下下周五').plannedDate).toBe('2026-10-09')
    expect(fields('上上周五').plannedDate).toBe('2026-09-11')
  })

  it('today=09-26（周六）：`本周五` = 09-25 —— 过去的日期照给，不纠正、不滚动', () => {
    expect(fields('本周五', '2026-09-26').plannedDate).toBe('2026-09-25')
  })

  it('`这周五` 整体收下，标题里不留孤立的 `这`', () => {
    expect(fields('这周五 开组会').title).toBe('开组会')
  })
})

describe('月日（八种写法同值）', () => {
  const writings = [
    '9月23日',
    '9月23号',
    '9/23',
    '9-23',
    '2026-09-23',
    '2026年9月23日',
    '2026年9月23号',
    '09月23日',
  ]
  for (const text of writings) {
    it(`\`${text}\` → 2026-09-23`, () => {
      expect(fields(text).plannedDate).toBe('2026-09-23')
      expect(fields(text).title).toBe('')
    })
  }

  it('`1月5日` → 2027-01-05（今年已过）；`12月25日` → 2026-12-25；`2月29日` → 2028-02-29', () => {
    expect(fields('1月5日').plannedDate).toBe('2027-01-05')
    expect(fields('12月25日').plannedDate).toBe('2026-12-25')
    expect(fields('2月29日').plannedDate).toBe('2028-02-29')
  })

  it('`9月23日` 在 `截止9月23日` 中识别（汉字标记自带边界）', () => {
    expect(fields('截止9月23日').plannedDate).toBe('2026-09-23')
    expect(fields('截止9月23日').title).toBe('截止')
  })

  it('裸 `3月` / `3月份` / `2026年9月` → 不识别、标题**逐字**不变', () => {
    for (const text of ['3月', '3月份', '2026年9月']) {
      const { plannedDate, plannedWeek, dueDate, title } = fields(text)
      expect(plannedDate).toBeNull()
      expect(plannedWeek).toBeNull()
      expect(dueDate).toBeNull()
      expect(title).toBe(text)
    }
  })
})

describe('不存在 / 非法的日期（**断言不夹取**）', () => {
  for (const text of ['2月30日', '4月31日', '13月5日', '0月5日', '2026-02-30']) {
    it(`\`${text}\` → 不识别、原文留标题、plannedDate === null`, () => {
      const { plannedDate, title } = fields(text)
      expect(plannedDate).toBeNull()
      expect(title).toBe(text)
    })
  }
})

describe('数字片段边界（§5.1）', () => {
  it('`实验9-23组` → 不识别（左右都不是空白），标题逐字不变', () => {
    const text = '实验9-23组 交材料'
    const { plannedDate, title } = fields(text)
    expect(plannedDate).toBeNull()
    expect(title).toBe(text)
  })

  it('`9-23组` → 不识别（右侧是汉字）', () => {
    expect(fields('9-23组').plannedDate).toBeNull()
    expect(fields('9-23组').title).toBe('9-23组')
  })

  it('`9-23 交材料` → 09-23', () => {
    expect(fields('9-23 交材料').plannedDate).toBe('2026-09-23')
    expect(fields('9-23 交材料').title).toBe('交材料')
  })

  it('`截止2026-09-23` → 识别（`ymd` 只要求非数字边界）', () => {
    expect(fields('截止2026-09-23').plannedDate).toBe('2026-09-23')
  })

  it('`12026-09-23` → 不识别（左边界是数字）', () => {
    expect(fields('12026-09-23').plannedDate).toBeNull()
  })
})

describe('前缀边界（§5.2）', () => {
  it('`C#语言`、`F#`、`user@example.com`、`a#b` → 无 project / tag token', () => {
    for (const text of ['C#语言', 'F#', 'user@example.com', 'a#b']) {
      const parse = parseOn(text, TODAY, [project('语言'), project('b')])
      expect(parse.tokens.filter((t) => t.kind === 'project' || t.kind === 'tag')).toEqual([])
    }
  })

  it('`明天#实验` → 识别（`#` 前是汉字，中文里这是自然写法）', () => {
    const result = resolveOn('明天#实验', TODAY, [project('实验', 'p1')])
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.projectId).toBe('p1')
    expect(result.title).toBe('')
  })
})

describe('优先级（§5.5）', () => {
  it('`!高`→high、`!中`→normal、`!低`→low、`！高`（全角）→high', () => {
    expect(resolveOn('!高 写报告').importance).toBe('high')
    expect(resolveOn('!中 写报告').importance).toBe('normal')
    expect(resolveOn('!低 写报告').importance).toBe('low')
    expect(resolveOn('！高 写报告').importance).toBe('high')
  })

  it('`!`、`!!`、`!!!`、`! 高`、`!高兴`、`!高写`、`别忘了!` → 全部不识别', () => {
    for (const text of ['!', '!!', '!!!', '! 高', '!高兴', '!高写', '别忘了!']) {
      const result = resolveOn(text)
      expect(result.importance).toBeNull()
      expect(result.title).toBe(text)
    }
  })

  it('`!高。` → 识别（标点是合法右边界）', () => {
    expect(resolveOn('!高。写报告').importance).toBe('high')
  })
})

describe('`!中` 与「没写」在载荷上不同', () => {
  it('`!中` → importance 显式是 `normal`；没写 → `null`（提交时**省略该字段**，默认值只有 ADR-017 §3 一处）', () => {
    expect(resolveOn('!中 写报告').importance).toBe('normal')
    expect(resolveOn('写报告').importance).toBeNull()
    // 载荷层「键不存在」的断言属 ADR-017 §3 的提交侧（本模块只交出 null，
    // 由它决定省略；本模块**不写第二个默认值**——见 §6 的说明）。
  })
})

describe('项目（§5.6）', () => {
  const projects = [project('实验', 'p-exp'), project('机器学习', 'p-ml')]

  it('名字精确匹配', () => {
    expect(resolveOn('#实验 写报告', TODAY, projects).projectId).toBe('p-exp')
    expect(resolveOn('#实验 写报告', TODAY, projects).title).toBe('写报告')
  })

  it('不存在 → 不识别、留标题、projectId === null', () => {
    const result = resolveOn('#新项目 写报告', TODAY, projects)
    expect(result.projectId).toBeNull()
    expect(result.title).toBe('#新项目 写报告')
  })

  it('`ctx.projects === []` → 全部不识别且**不抛错**', () => {
    const result = resolveOn('#实验 写报告', TODAY, [])
    expect(result.projectId).toBeNull()
    expect(result.title).toBe('#实验 写报告')
  })

  it('`#实验-1` → 名字含 `-`', () => {
    const result = resolveOn('#实验-1 写报告', TODAY, [project('实验-1', 'p-dash')])
    expect(result.projectId).toBe('p-dash')
  })

  it('`#实验 ` 后有空格 → 正常结束（名字不含空白）', () => {
    const result = resolveOn('#实验 写报告', TODAY, projects)
    expect(result.title).toBe('写报告')
  })

  it('`#` 后名字为空 → 不识别（`# 实验`）', () => {
    const parse = parseOn('# 实验', TODAY, projects)
    expect(parse.tokens).toEqual([])
  })
})

describe('项目同名（ADR-016 §6）', () => {
  it('两个同名「实验」→ 不识别、不抛错、原文留标题；删掉一个后**变为识别**（无缓存）', () => {
    const both = [project('实验', 'p1'), project('实验', 'p2')]
    const ambiguous = resolveOn('#实验 写报告', TODAY, both)
    expect(ambiguous.projectId).toBeNull()
    expect(ambiguous.title).toBe('#实验 写报告')

    const single = resolveOn('#实验 写报告', TODAY, [project('实验', 'p1')])
    expect(single.projectId).toBe('p1')
  })

  it('大小写不同的 `Bio` / `bio` 同时存在 → `#Bio` 仍识别（**不折叠大小写**）', () => {
    const projects = [project('Bio', 'p-big'), project('bio', 'p-small')]
    expect(resolveOn('#Bio 写报告', TODAY, projects).projectId).toBe('p-big')
    expect(resolveOn('#bio 写报告', TODAY, projects).projectId).toBe('p-small')
  })
})

describe('标签', () => {
  it('`@a @b` → [a, b]；`@a @a` → [a]（去重保序）', () => {
    expect(resolveOn('@a @b 写报告').tags).toEqual(['a', 'b'])
    expect(resolveOn('@a @a 写报告').tags).toEqual(['a'])
  })

  it('`@` 单独、`@ a` → 不识别', () => {
    expect(parseOn('@').tokens).toEqual([])
    expect(parseOn('@ a').tokens).toEqual([])
  })
})

describe('输入上限（ADR-017 §3）', () => {
  it('21 个 `@` 片段 → 第 21 个不识别（留标题）、前 20 个进 tags', () => {
    const names = Array.from({ length: 21 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`)
    const text = names.map((name) => `@${name}`).join(' ')
    const result = resolveOn(text)
    expect(result.tags).toHaveLength(20)
    expect(result.tags).not.toContain('t21')
    expect(result.title).toBe('@t21')
    expect(parseOn(text).tokens).toHaveLength(20)
  })

  it('名字 51 字符的 `@…` → 不识别', () => {
    const long = 'a'.repeat(51)
    const result = resolveOn(`@${long} 写报告`)
    expect(result.tags).toEqual([])
    expect(result.title).toBe(`@${long} 写报告`)
    // 50 字符仍识别（边界另一侧）
    const ok = 'b'.repeat(50)
    expect(resolveOn(`@${ok} 写报告`).tags).toEqual([ok])
  })

  it('标题 501 字符且无碎片 → canSubmit false、标题**不被截断**（逐字等于原文）', () => {
    const text = 'x'.repeat(501)
    const result = resolveOn(text)
    expect(canSubmit(result)).toBe(false)
    expect(result.title).toBe(text)
    expect(result.title).toHaveLength(501)
  })

  it('500 字符 → canSubmit true', () => {
    expect(canSubmit(resolveOn('y'.repeat(500)))).toBe(true)
  })
})

describe('花括号（§5.4）', () => {
  it('`{下周五}` → dueDate=10-02 且 plannedDate === null', () => {
    const { dueDate, plannedDate, title } = fields('{下周五}')
    expect(dueDate).toBe('2026-10-02')
    expect(plannedDate).toBeNull()
    expect(title).toBe('')
  })

  it('`{明天}` → 期限 = 明天（花括号内允许相对词）', () => {
    expect(fields('{明天}').dueDate).toBe('2026-09-23')
    expect(fields('{明天}').plannedDate).toBeNull()
  })

  it('`{9月23日}` 内的日期**不进** plannedDate', () => {
    expect(fields('{9月23日}').dueDate).toBe('2026-09-23')
    expect(fields('{9月23日}').plannedDate).toBeNull()
  })

  it('`{每周三}`、`{明天下午}`、`{`、`明天}` → 不识别、原样留标题', () => {
    for (const text of ['{每周三}', '{明天下午}', '{']) {
      const result = resolveOn(text)
      expect(result.dueDate).toBeNull()
      expect(result.title).toBe(text)
    }
    // `明天}`：矩阵把这一例也列进「不识别、原样留标题」，而 §5.4 的原文是
    // 「**`}` 单独出现** → 不识别」——`明天}` 里的 `}` 并非单独出现。任何让 `明天` 也不被识别的
    // 写法都要给 `}` 加一条正文级的特例，而那与 §2 的逐字符扫描、与「部分识别是正确的」
    // （`每天上午`）都冲突。故此处按 §2 的算法：`明天` 是正文里的一个日期碎片，`}` 留标题。
    // 这一处歧义已登记在实现报告里。
    const stray = resolveOn('明天}')
    expect(stray.dueDate).toBeNull()
    expect(stray.plannedDate).toBe('2026-09-23')
    expect(stray.title).toBe('}')
  })

  it('`{ 明天 }`、`{明天 }` → 不识别（片段内部不得有空白）', () => {
    expect(resolveOn('{ 明天 }').dueDate).toBeNull()
    expect(resolveOn('{明天 }').dueDate).toBeNull()
    expect(resolveOn('{明天 }').title).toBe('{明天 }')
  })

  it('`{` 未闭合（`{明天`）→ 整块不识别、原样留标题', () => {
    expect(resolveOn('{明天').title).toBe('{明天')
    expect(resolveOn('{明天').plannedDate).toBeNull()
    expect(resolveOn('{明天').dueDate).toBeNull()
  })
})

describe('重复 → 规则（§7）', () => {
  it('`每天` / `每日` → daily / 1', () => {
    expect(recurrenceOf('每天')?.rule).toEqual({ freq: 'daily', interval: 1 })
    expect(recurrenceOf('每日')?.rule).toEqual({ freq: 'daily', interval: 1 })
  })

  it('`每2天` → daily / 2', () => {
    expect(recurrenceOf('每2天')?.rule).toEqual({ freq: 'daily', interval: 2 })
  })

  it('`每2周` → weekly / 2（无 byDayOfWeek）', () => {
    expect(recurrenceOf('每2周')?.rule).toEqual({ freq: 'weekly', interval: 2 })
  })

  it('`每月` → monthly / 1；`每3个月` ≡ `每3月` → monthly / 3', () => {
    expect(recurrenceOf('每月')?.rule).toEqual({ freq: 'monthly', interval: 1 })
    expect(recurrenceOf('每3个月')?.rule).toEqual({ freq: 'monthly', interval: 3 })
    expect(recurrenceOf('每3月')?.rule).toEqual({ freq: 'monthly', interval: 3 })
  })

  it('`每月31号` → monthly + byMonthDay:[31]', () => {
    expect(recurrenceOf('每月31号')?.rule).toEqual({ freq: 'monthly', interval: 1, byMonthDay: [31] })
  })

  it('`每年3月5日` → yearly / 1，锚点月日**写进 startsOn**', () => {
    const spec = recurrenceOf('每年3月5日')
    expect(spec?.rule).toEqual({ freq: 'yearly', interval: 1 })
    expect(spec?.startsOn).toBe('2027-03-05')
  })

  it('`每周八` → `每周` + `八` 留标题（§5.5）', () => {
    expect(recurrenceOf('每周八 写报告')?.rule).toEqual({ freq: 'weekly', interval: 1 })
    expect(resolveOn('每周八 写报告').title).toBe('八 写报告')
  })

  it('`每月32号`、`每月0号`、`每年13月5日` → 不识别（不交必被 `validateRule` 拒绝的规则）', () => {
    for (const text of ['每月32号', '每月0号', '每年13月5日']) {
      const result = resolveOn(text)
      expect(result.recurrence).toBeNull()
      expect(result.title).toBe(text)
    }
  })
})

describe('数字片段的范围（`[N]天后`）', () => {
  it('`0天后`、`10000天后` → 不识别（留标题）', () => {
    expect(fields('0天后').plannedDate).toBeNull()
    expect(fields('0天后').title).toBe('0天后')
    expect(fields('10000天后').plannedDate).toBeNull()
    expect(fields('10000天后').title).toBe('10000天后')
  })

  it('`3650天后` → 识别', () => {
    expect(fields('3650天后').plannedDate).not.toBeNull()
  })

  it('`0003天后` ≡ `3天后`', () => {
    expect(fields('0003天后').plannedDate).toBe(fields('3天后').plannedDate)
    expect(fields('3天后').plannedDate).toBe('2026-09-25')
  })
})

describe('「装不下」类的不识别', () => {
  it('`每月第三个周五`、`每月第3个周五`、`每小时` → 不抛错，且交出的规则必过 `validateRule`', () => {
    for (const text of ['每月第三个周五', '每月第3个周五', '每小时']) {
      const result = resolveOn(text)
      // 不抛错已由「跑到了这里」证明；规则合法性逐条断言
      const spec = result.recurrence
      if (spec !== null) {
        expect(validateRule(spec.rule, spec.startsOn)).toEqual([])
      }
      // 这三条都**不得**产出「每月第 N 个周几」那种本词表装不下的形态
      expect(spec?.rule.byDayOfWeek).toBeUndefined()
    }
  })

  it('`每月最后一天` → 不得被当成月末（`byMonthDay: [-1]`），也不得同时收下 `每月31号` 的语义', () => {
    const last = resolveOn('每月最后一天').recurrence
    if (last !== null) {
      expect(last.rule.byMonthDay).toBeUndefined()
    }
    // `每月31号` 收的是 31（夹取由 ADR-011 §3 负责）；两者不会得到同一个规则
    expect(recurrenceOf('每月31号')?.rule.byMonthDay).toEqual([31])
  })
})

describe('「能表达但不收」类（断言没有任何部分匹配）', () => {
  it('`每个工作日`、`每个周末`、`下个工作日` → 不识别、整串留标题', () => {
    for (const text of ['每个工作日', '每个周末', '下个工作日']) {
      const parse = parseOn(text)
      expect(parse.tokens).toEqual([])
      const result = resolveOn(text)
      expect(result.title).toBe(text)
      expect(result.plannedDate).toBeNull()
      expect(result.plannedWeek).toBeNull()
      expect(result.recurrence).toBeNull()
    }
  })
})

describe('项目名的空白（§5.6）', () => {
  it('`#机器学习 课程 写作业` → `#` 的名字是 `机器学习`（不存在时整块不识别）', () => {
    const result = resolveOn('#机器学习 课程 写作业', TODAY, [])
    expect(result.projectId).toBeNull()
    expect(result.title).toBe('#机器学习 课程 写作业')
  })

  it('含空格的项目名无法用 `#` 输入：`#My\\ Project` 不产生 project token，`\\` 行为与层②一致', () => {
    const result = resolveOn('#My\\ Project 写作业', TODAY, [project('My Project', 'p-space')])
    expect(result.projectId).toBeNull()
    // `#My\` 被名字认领（未命中项目 → 不出 token），`\` 与后面的空格原样留下
    expect(result.title).toBe('#My\\ Project 写作业')
  })
})

describe('锚点一致性（§7 的两处算法不许漂移）', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['每天 写日记', '2026-09-22'],
    ['明天 每天 写日记', '2026-09-23'],
    ['明天 每周三 交周报', '2026-09-23'],
    ['明天 每周一 交周报', '2026-09-28'],
    ['下周一 每周三 开组会', '2026-09-30'],
  ]

  for (const [text, startsOn] of cases) {
    it(`\`${text}\` → startsOn=${startsOn}，且首轮即它`, () => {
      const spec = recurrenceOf(text)
      expect(spec).not.toBeNull()
      if (spec === null) return
      expect(spec.startsOn).toBe(startsOn)

      const sequence = hitSequence(spec.rule, spec.startsOn)
      const first = sequence.next()
      expect(first.done).toBe(false)
      expect(first.value).toBe(spec.startsOn)

      // `D₀` = 裸日期片段 ?? today
      const bare = /^(明天|下周一)/.exec(text)?.[0]
      const d0 = bare === '明天' ? '2026-09-23' : bare === '下周一' ? '2026-09-28' : TODAY
      expect(compareDayKey(spec.startsOn, d0)).toBeGreaterThanOrEqual(0)
      expect(firstHitAtOrAfter(spec.rule, spec.startsOn, d0)).toBe(spec.startsOn)
    })
  }

  it('`明天 每周三 开组会`（today=09-22）→ startsOn=**09-23**，不得是 09-22', () => {
    expect(recurrenceOf('明天 每周三 开组会')?.startsOn).toBe('2026-09-23')
  })
})

describe('重复任务三个日期锚点恒空（ADR-013 §3.1）', () => {
  const cases = [
    '每天 写日记',
    '明天 每天 写日记',
    '下周 每天 写日记',
    '每周三 交周报',
    '明天 每周一 交周报',
    '每天 写日记 {下周五}',
    '下周 每周三 开组会',
  ]

  for (const text of cases) {
    it(`\`${text}\` → plannedDate / plannedWeek / dueDate **全部为 null**`, () => {
      const result = resolveOn(text)
      expect(result.recurrence).not.toBeNull()
      expect(result.plannedDate).toBeNull()
      expect(result.plannedWeek).toBeNull()
      expect(result.dueDate).toBeNull()
    })
  }

  it('`每天 写日记 {下周五}` → `{下周五} ∈ released`、标题里逐字保留 `{下周五}`', () => {
    const result = resolveOn('每天 写日记 {下周五}')
    expect(result.dueDate).toBeNull()
    expect(result.released.some((token) => token.text === '{下周五}')).toBe(true)
    expect(result.title).toBe('写日记 {下周五}')
  })
})

describe('`下周` 是周级锚点，不是日级（§4.3 裁决的回归）', () => {
  it('`下周 写报告` → plannedWeek=09-28 且 plannedDate === null', () => {
    const { plannedWeek, plannedDate } = fields('下周 写报告')
    expect(plannedWeek).toBe('2026-09-28')
    expect(plannedDate).toBeNull()
  })

  it('`下周三 写报告` → plannedDate=09-30 且 plannedWeek === null', () => {
    const { plannedDate, plannedWeek } = fields('下周三 写报告')
    expect(plannedDate).toBe('2026-09-30')
    expect(plannedWeek).toBeNull()
  })

  it('二者**永不同时非空**（对一批混合输入逐条断言）', () => {
    const inputs = ['明天 写报告', '下周 写报告', '下周三 写报告', '下周 明天 写报告', '明天 下周 写报告']
    for (const text of inputs) {
      const result = resolveOn(text)
      expect(result.plannedDate !== null && result.plannedWeek !== null).toBe(false)
    }
  })
})

describe('周级锚点不误报逾期（§4.3 要防的那个症状）', () => {
  it('`下周 写报告`（09-28 那周）在 today = 09-29 时**不是逾期**（紧迫日折算成周日）', () => {
    const result = resolveOn('下周 写报告', '2026-09-22')
    expect(result.plannedWeek).toBe('2026-09-28')
    // ADR-015 §4：周锚点的紧迫日 = 该周周日。09-29（周二）时它仍是未来，故不逾期。
    const urgencyDay = weekEnd(result.plannedWeek as string)
    expect(urgencyDay).toBe('2026-10-04')
    expect(urgencyDay > '2026-09-29').toBe(true)
  })
})

describe('星期索引口径（ADR-011 §2：0 = 周一 … 6 = 周日）', () => {
  it('`diffDays(weekStart(dk), dk)` 给出 0/1/6（本模块 `weekdayIndex` 的那一行表达式）', () => {
    expect(diffDays(weekStart('2026-09-21'), '2026-09-21')).toBe(0)
    expect(diffDays(weekStart('2026-09-22'), '2026-09-22')).toBe(1)
    expect(diffDays(weekStart('2026-09-27'), '2026-09-27')).toBe(6)
  })

  it('`[D]` 全表：每周一…每周日 → byDayOfWeek 0…6', () => {
    const table: readonly (readonly [string, number])[] = [
      ['每周一', 0],
      ['每周二', 1],
      ['每周三', 2],
      ['每周四', 3],
      ['每周五', 4],
      ['每周六', 5],
      ['每周日', 6],
      ['每周天', 6],
    ]
    for (const [text, index] of table) {
      expect(recurrenceOf(text)?.rule.byDayOfWeek).toEqual([index])
    }
  })

  it('`周日` / `周天` 都解析为周日（today=09-22 → 09-27）', () => {
    expect(fields('周日').plannedDate).toBe('2026-09-27')
    expect(fields('周天').plannedDate).toBe('2026-09-27')
  })
})

describe('冲突（§4.4 采纳集模型的核心回归）', () => {
  it('`明天 周五 写报告` → 计划日=09-25、`明天 ∈ released`、title=`明天 写报告`', () => {
    const result = resolveOn('明天 周五 写报告')
    expect(result.plannedDate).toBe('2026-09-25')
    expect(result.title).toBe('明天 写报告')
    expect(result.released.map((t) => t.text)).toEqual(['明天'])
    expect(result.adopted.map((t) => t.text)).toEqual(['周五'])
  })

  it('再 `suppress(周五的 start)` → 计划日=09-23、`明天 ∈ adopted`（`明天` 自动重新生效）', () => {
    const parse = parseOn('明天 周五 写报告')
    const friday = parse.tokens.find((token) => token.text === '周五')
    expect(friday).toBeDefined()
    const result = resolveOn('明天 周五 写报告', TODAY, [], [friday?.start as number])
    expect(result.plannedDate).toBe('2026-09-23')
    expect(result.adopted.map((t) => t.text)).toEqual(['明天'])
    expect(result.released.map((t) => t.text)).toEqual(['周五'])
    // ⚠️ 矩阵这一行原文写的是 `title="写报告"`，**本实现给的是 `周五 写报告`**。
    // 证据在 §1 / §2 / §理由 三处（已登记在实现报告里，不在此默默偏离）：
    // - §1 `released` 的注释：「（冲突落选或**被 `×` 取消**）；**它们的原文仍在 `title` 里**」；
    // - §2 阶段 2 第 4 条：`title` 只删「**adopted** 的跨度」与转义反斜杠——被抑制者**不在**
    //   采纳集里，故它的跨度不该被删；
    // - §2 的「为什么取舍要用采纳集」：「取消 = 从采纳集里去掉一个 token 再重算，
    //   被取消的碎片**自动回到它原来的位置**」——只有「文本留在标题」时这句话才有意义
    //   （否则没有「位置」可谈，`×` 就是一次静默删字）；
    // - §理由 的外部对照：「层③『取消识别、**文本回到标题**』也有先例」。
    // 按 §2 的算法，被取消的 `周五` 留在标题里，用户手动删掉即可；`明天` 重新生效 ✓。
    expect(result.title).toBe('周五 写报告')
  })
})

describe('空与纯碎片', () => {
  const inputs = ['', '   ', '明天', '明天 ', '@科研', '""']
  for (const text of inputs) {
    it(`\`${JSON.stringify(text)}\` → title === ''、canSubmit === false、**不抛错**`, () => {
      const result = resolveOn(text)
      expect(result.title).toBe('')
      expect(canSubmit(result)).toBe(false)
    })
  }
})

describe('标题规范化（§5.3）', () => {
  it('`明天  写报告` → `写报告`；` 明天 写报告 ` → `写报告`；`明天 写  报告` → `写 报告`', () => {
    expect(resolveOn('明天  写报告').title).toBe('写报告')
    expect(resolveOn(' 明天 写报告 ').title).toBe('写报告')
    expect(resolveOn('明天 写  报告').title).toBe('写 报告')
  })
})

describe('位置区间（§6 的四条硬性约定之二、三）', () => {
  const inputs = [
    '明天 写报告 @科研 #实验 !高 9月23日 下周 {下周五} 每天',
    '🎉明天 写报告',
    '𠀋后天 写报告', // 罕见汉字（代理对）
  ]

  for (const text of inputs) {
    it(`\`${text}\`：每个 token 的 text 与 slice 逐字相符、升序、互不重叠`, () => {
      const parse = parseOn(text, TODAY, [project('实验', 'p1')])
      let cursor = -1
      for (const token of parse.tokens) {
        expect(token.text).toBe(parse.text.slice(token.start, token.end))
        expect(token.start).toBeGreaterThanOrEqual(cursor)
        cursor = token.end
      }
    })
  }

  it('emoji 之后的下标是 UTF-16 码元下标（与 slice 对齐，不是「字符数」）', () => {
    const parse = parseOn('🎉明天 写报告')
    const token = parse.tokens[0] as QuickAddToken
    expect(token.start).toBe(2)
    expect(token.end).toBe(4)
    expect(parse.text.slice(2, 4)).toBe('明天')
  })
})

describe('纯函数', () => {
  it('固定 `(text, ctx)` 两次调用深相等（含 tokens 的每个偏移）', () => {
    const ctx = { now: new Date('2026-09-22T12:00:00+08:00'), timeContext: { timeZone: 'Asia/Shanghai', dayStartHour: 4 }, projects: [project('实验', 'p1')] }
    const text = '明天 #实验 9月23日 @科研 每天 {下周五} !高'
    expect(parseQuickAdd(text, ctx)).toEqual(parseQuickAdd(text, ctx))
  })

  it('固定 `(parse, suppressed)` 两次调用深相等', () => {
    const parse = parseOn('明天 周五 写报告 #实验 @科研', TODAY, [project('实验', 'p1')])
    const friday = parse.tokens.find((token) => token.text === '周五')
    const suppressed = [friday?.start as number]
    expect(resolveQuickAdd(parse, suppressed)).toEqual(resolveQuickAdd(parse, suppressed))
  })
})

describe('预览呈现（§1 的两个呈现函数）', () => {
  it('`describeDay`：同年用短式、跨年用长式', () => {
    expect(describeDay('2026-09-23', TODAY)).toBe('9月23日')
    expect(describeDay('2027-01-05', TODAY)).toBe('2027年1月5日')
  })

  it('`describeWeek` 逐字转出 `@shared/time` 的 `formatWeek`（本模块**不自己实现一份**）', async () => {
    const time = (await import('@shared/time')) as { formatWeek?: (dk: string) => string }
    if (typeof time.formatWeek !== 'function') {
      // ⚠️ **依赖未到位，这条断言故意保持红**：ADR-009 §10 的 `formatWeek` 归另一个 agent
      // （ADR-014 §4.3 的裁决③把它列为阶段 4「必须补的活」），写这一版时它还没落地。
      // 保持红而不是 `skip`：缺口必须**可见**，而不是让「周级呈现」看起来已经具备。
      // 它落地的那一刻，本用例自动变绿——`describeWeek` 的实现体无需任何改动。
      expect.fail('`@shared/time` 尚未导出 ADR-009 §10 的 `formatWeek`：`describeWeek` 暂时不可用')
    }
    expect(describeWeek('2026-09-28')).toBe('9月28日那一周')
    // 同一周的七天取值全部相同（内部走 weekStart 规范化的回归，ADR-009 §10）
    for (const dk of ['2026-09-28', '2026-09-30', '2026-10-04']) {
      expect(describeWeek(dk)).toBe('9月28日那一周')
    }
  })
})
