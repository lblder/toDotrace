/**
 * 阶段 0 / 阶段 1 的实现细节（ADR-014 §2）——矩阵之外的边界。
 */
import { describe, expect, it } from 'vitest'

import { RULES, longestMatchAt } from './lexicon'
import { parseQuickAdd } from './scan'
import { MAX_TAGS } from './types'
import type { PatternId, QuickAddToken } from './types'
import { ctxOn, parseOn, project, resolveOn, TODAY } from './testing'

function tokenTexts(text: string, projects: readonly { id: string; name: string }[] = []): string[] {
  return parseOn(text, TODAY, projects).tokens.map((token) => token.text)
}

function tokenPatterns(text: string): PatternId[] {
  return parseOn(text).tokens.map((token) => token.pattern)
}

describe('规则表是 §3 的有序规格', () => {
  it('表序 === §3 的「序」列（§2 的决胜层依赖它，不得重排）', () => {
    expect(RULES.map((rule) => rule.id)).toEqual([
      'ymd-cn',
      'md-cn',
      'ymd',
      'days-after',
      'week-prefixed',
      'week-prefix',
      'weekday',
      'day-word',
      'md-slash',
      'md-dash',
      'recur-yearly',
      'recur-monthly',
      'recur-weekly',
      'recur-daily',
      'due-brace',
      'priority',
      'project',
      'tag',
    ])
  })
})

describe('最长匹配与不回溯', () => {
  it('起点 0 消费掉 `大后天` 后**不会**滑到起点 1 去匹配 `后天`', () => {
    const parse = parseOn('大后天')
    expect(parse.tokens).toHaveLength(1)
    expect(parse.tokens[0]?.pattern).toBe('day-word')
    expect(parse.tokens[0]?.start).toBe(0)
  })

  it('`下周三` 被片段 #5 收下（而非 #6 + `三`）', () => {
    expect(tokenPatterns('下周三')).toEqual(['week-prefixed'])
    expect(tokenPatterns('下周')).toEqual(['week-prefix'])
    expect(tokenPatterns('周三')).toEqual(['weekday'])
  })

  it('`每周三` 被重复族收下（而非 `weekday` + 一个孤立的 `每`）', () => {
    expect(tokenPatterns('每周三')).toEqual(['recur-weekly'])
  })

  it('跨度相同时取表序小者：`longestMatchAt` 用严格大于比较来保证这一条', () => {
    const first = longestMatchAt('明天', 0, { today: TODAY, projects: [] })
    expect(first?.end).toBe(2)
    const next = longestMatchAt('天', 0, { today: TODAY, projects: [] })
    expect(next).toBeNull()
  })
})

describe('整串引号只认半角 `"`', () => {
  it('全角 `“…”` 不是逃生舱（它在中文正文里是真引号）', () => {
    const parse = parseOn('“明天 写报告”')
    expect(parse.quoted).toBe(false)
    expect(parse.tokens.map((token) => token.text)).toEqual(['明天'])
  })

  it('`"` 在串中间时不触发', () => {
    expect(parseOn('写"报告"').quoted).toBe(false)
  })
})

describe('转义层的细节', () => {
  it('转义只保护它命中的那一个片段（`\\明天开会` 只保护 `明天`）', () => {
    const parse = parseOn('\\明天开会')
    expect(parse.tokens).toEqual([])
    expect(parse.escapeOffsets).toEqual([0])
  })

  it('被转义的 `\\` 下标升序记录，且只有它自己被移除', () => {
    const parse = parseOn('\\明天 \\周五 \\9月23日')
    expect(parse.escapeOffsets).toEqual([0, 4, 8])
    expect(parse.tokens).toEqual([])
  })

  it('转义的重复碎片不占标签额度、也不进 tokens', () => {
    const parse = parseOn('\\每天 写日记')
    expect(parse.tokens).toEqual([])
    expect(parse.escapeOffsets).toEqual([0])
  })

  it('未命中任何规则的 `\\` 是普通字符（不进 escapeOffsets）', () => {
    expect(parseOn('a\\b').escapeOffsets).toEqual([])
    expect(parseOn('C:\\Users\\me 写报告').escapeOffsets).toEqual([])
  })
})

describe('认领但不出 token（文件头的实现决定 1）', () => {
  it('不存在的项目：整段被认领，内部的日期词**不会**被二次匹配', () => {
    const parse = parseOn('#明天 写报告', TODAY, [])
    expect(parse.tokens).toEqual([])
  })

  it('不存在的项目：名字里含日期词同样不被二次匹配', () => {
    expect(parseOn('#下周三开会', TODAY, [])).toMatchObject({ tokens: [] })
  })

  it('非法的日期片段：`2026-02-30` 整段认领，`02-30` 不会被 `md-dash` 再匹配一次', () => {
    const parse = parseOn('2026-02-30')
    expect(parse.tokens).toEqual([])
  })

  it('`每年13月5日` 整段认领：不会剩下一个 `3月5日` 的日期碎片', () => {
    const parse = parseOn('每年13月5日')
    expect(parse.tokens).toEqual([])
  })

  it('第 21 个标签被认领但不产出 token', () => {
    const names = Array.from({ length: 21 }, (_, i) => `n${i}`)
    const parse = parseOn(names.map((name) => `@${name}`).join(' '))
    expect(parse.tokens).toHaveLength(MAX_TAGS)
  })
})

describe('花括号的整块语义', () => {
  it('`{每周三}` 整块认领：内部的重复碎片不会被单独识别', () => {
    expect(parseOn('{每周三}').tokens).toEqual([])
  })

  it('`{明天下午}` 整块认领：`明天` 不会被单独识别（否则标题会剩下 `{下午}`）', () => {
    expect(parseOn('{明天下午}').tokens).toEqual([])
  })

  it('`{9-23}`：花括号内不放松「整 token」边界，故整块不识别（§5.1 的字面读法）', () => {
    // ADR §5.1 把 `md-dash` 的左右边界定为「串首或空白」；花括号内左侧是 `{`，不满足。
    // §5.4 只举例了 `{下周五}` / `{明天}` / `{9月23日}` 一类（自带边界或汉字标记的写法），
    // 未对 `{9-23}` 表态——此处按 §5.1 的字面读法实现，已在实现报告里登记。
    expect(parseOn('{9-23}').tokens).toEqual([])
    expect(tokenTexts('{9-23} 交材料')).toEqual([])
  })

  it('`{下周}` / `{每月5号}`：花括号内**不收**周级锚点与重复碎片（§3 的 due-brace 行逐字）', () => {
    // `due-brace` 的内部只有九个日期片段；`week-prefix`（裸 `[P]周`）不在其中——
    // `dueDate` 是**单日**，周粒度的锚点在它这一列无处安放（§4.3 的粒度判据）。
    expect(parseOn('{下周}').tokens).toEqual([])
    expect(parseOn('{每月5号}').tokens).toEqual([])
    expect(resolveOn('{下周}').title).toBe('{下周}')
  })

  it('`{` 之后的第一个 `}` 就是块尾（`{a}b}` 只认领到第一个 `}`）', () => {
    const parse = parseOn('{a}b} 明天')
    expect(parse.tokens.map((token) => token.text)).toEqual(['明天'])
  })
})

describe('名字的定义（§3）', () => {
  it('名字内部允许标点（`#实验-1`）', () => {
    const parse = parseOn('#实验-1 写报告', TODAY, [project('实验-1', 'p1')])
    expect(parse.tokens[0]?.text).toBe('#实验-1')
  })

  it('名字到「下一个片段起始符」为止（`#实验@科研`）', () => {
    const parse = parseOn('#实验@科研 写报告', TODAY, [project('实验', 'p1')])
    expect(parse.tokens.map((token) => token.text)).toEqual(['#实验', '@科研'])
  })

  it('`}` 不是名字的终止符，`{` 是', () => {
    const parse = parseOn('#实验} 写报告', TODAY, [project('实验}', 'p1')])
    expect(parse.tokens[0]?.text).toBe('#实验}')
    expect(parseOn('#实验{明天}', TODAY, [project('实验', 'p1')]).tokens.map((t) => t.text)).toEqual([
      '#实验',
      '{明天}',
    ])
  })

  it('`#` / `＃` 与 `@` / `＠` 的全角形态等价（输入法的常态产物）', () => {
    const full = parseOn('＃实验 ＠科研', TODAY, [project('实验', 'p1')])
    expect(full.tokens.map((token) => token.text)).toEqual(['＃实验', '＠科研'])
  })
})

describe('token 的形状（§6 的四条硬性约定）', () => {
  it('每个 token 都带 pattern / start / end / text，且 kind 与 pattern 对应', () => {
    const parse = parseOn('明天 9月23日 下周 {下周五} !高 #实验 @科研 每天', TODAY, [project('实验', 'p1')])
    const kinds = parse.tokens.map((token) => token.kind)
    expect(kinds).toEqual(['date', 'date', 'plannedWeek', 'dueDate', 'importance', 'project', 'tag', 'recurrence'])
    for (const token of parse.tokens) {
      expect(typeof token.pattern).toBe('string')
      expect(token.end).toBeGreaterThan(token.start)
      expect(token.text).toBe(parse.text.slice(token.start, token.end))
    }
  })

  it('`importance` token 携带三档值（不是 `importance: null` 那种含糊形态）', () => {
    const token = parseOn('!低').tokens[0] as QuickAddToken
    expect(token.kind).toBe('importance')
    if (token.kind === 'importance') expect(token.importance).toBe('low')
  })

  it('`project` token 同时带 id 与 name（预览要显示名字，提交要 id）', () => {
    const token = parseOn('#实验', TODAY, [project('实验', 'p1')]).tokens[0] as QuickAddToken
    expect(token).toMatchObject({ kind: 'project', projectId: 'p1', projectName: '实验' })
  })
})

describe('几处 ADR 未逐字规定、由实现作出并在此固化的判断', () => {
  it('`每周五` 是 weekly + [4]（不是 `每` + `周五`）', () => {
    expect(tokenPatterns('每周五')).toEqual(['recur-weekly'])
  })

  it('`每年3月`：本实现给 `每年`（间隔 1），`3月` 留标题', () => {
    // §5.5 末段写「『每年三月』写作 `每年3月`（`recur-yearly`，间隔 1，锚点月 = 3）」，
    // 而 §3 的规则表里 `recur-yearly` 只有 `每[N]年[N]月[N]日` / `每年[N]月[N]日` /
    // `每[N]年` / `每年` **四种形态，没有 `每年[N]月`**。两处冲突，此处按表实现
    // （§3 开头：表「每一行都是规格；未列出的写法一律不识别」），已在实现报告里登记。
    expect(tokenPatterns('每年3月')).toEqual(['recur-yearly'])
    expect(parseOn('每年3月 做实验').tokens.map((token) => token.text)).toEqual(['每年'])
  })

  it('转义花括号：`\\{明天}` → 整块成为字面文本', () => {
    const parse = parseOn('\\{明天} 交报告')
    expect(parse.tokens).toEqual([])
    expect(parse.escapeOffsets).toEqual([0])
  })

  it('`2月29日` 在 8 年窗口内命中闰年（§4.2 的上界取 8 年的理由）', () => {
    // 2096 是闰年、2100 不是（世纪年不闰）→ 最大间隔 8 年
    const result = resolveOn('2月29日', '2097-03-01')
    expect(result.plannedDate).toBe('2104-02-29')
  })
})

describe('today 由 now 与 timeContext 派生（§1）', () => {
  it('凌晨 4 点前算前一天（dayStartHour 默认 4）', () => {
    const before = parseQuickAdd('明天', ctxOn('2026-09-23', { hour: 3 }))
    expect(before.today).toBe('2026-09-22')
    const after = parseQuickAdd('明天', ctxOn('2026-09-23', { hour: 4 }))
    expect(after.today).toBe('2026-09-23')
  })

  it('同一个 `now` 下，调用方无从把「今天」算错：两次解析的 today 相同', () => {
    const ctx = ctxOn('2026-12-31', { hour: 23 })
    expect(parseQuickAdd('明天', ctx).today).toBe('2026-12-31')
    expect(parseQuickAdd('明年见', ctx).today).toBe('2026-12-31')
  })
})
