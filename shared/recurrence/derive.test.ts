/**
 * `deriveRounds` 的测试矩阵（ADR-011 §4）。
 *
 * 三条规则各有断言：
 * 1. 已完成轮次**原样返回、永不重算**（连「不在当前命中集合里」的也照返）；
 * 2. **至多一个**待完成轮次，取 `[起点, today]` 内最后一个命中日；
 * 3. `count` / `until` 约束，基准是**落库日**。
 *
 * 下半段（monthly / yearly）依赖 ADR-009 §8 的月 / 年算术（已落地）。
 */
import { describe, expect, it } from 'vitest'

import {
  AnchorInvariantError,
  ProgressionLimitError,
  RecurrenceRuleError,
  deriveRounds,
} from './index'
import type { DayKey, RecurrenceRule, RecurrenceTemplate, RoundCompletion } from './index'

const TEMPLATE_ID = 'tpl-drink'
const ACCOUNT_ID = 'acc-1'

function template(
  rule: RecurrenceRule,
  startsOn: DayKey = '2026-01-05',
  title = '喝水',
  accountId: string = ACCOUNT_ID,
): RecurrenceTemplate {
  return {
    id: TEMPLATE_ID,
    accountId,
    title,
    rule,
    nextAnchorMode: 'catch_up',
    startsOn,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * `eventId` 是 ADR-001 §2 的排序键，「最近一次完成」按它判定（§4）。
 *
 * ⚠️ 判定用**字符串比较**，故依赖 ADR-001「约束」节的性质：标识形态可直接排序
 * （规范 UUIDv7、小写、**定长 36**）⇒ 字典序 === 时间序。生成器侧的测试固化归
 * `server/lib/uuid.ts` 的归属者；本用例组最后一条钉的是**消费侧**（本模块）这一半。
 */
function completion(
  originalPlannedDate: DayKey,
  nextAnchorDate: DayKey | null,
  eventId: string,
  completedDayKey: DayKey = originalPlannedDate,
  templateId: string = TEMPLATE_ID,
  accountId: string = ACCOUNT_ID,
): RoundCompletion {
  return {
    accountId,
    templateId,
    originalPlannedDate,
    completedDayKey,
    nextAnchorDate,
    nextAnchorMode: 'catch_up',
    eventId,
  }
}

const daily: RecurrenceRule = { freq: 'daily', interval: 1 }

describe('deriveRounds · 无完成记录时', () => {
  it('待完成轮次 = 最后一个 ≤ today 的命中日', () => {
    expect(deriveRounds(template(daily), [], '2026-01-08')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-08', title: '喝水' },
    ])
  })

  it('today == starts_on：首轮就是待完成轮次', () => {
    expect(deriveRounds(template(daily), [], '2026-01-05')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-05', title: '喝水' },
    ])
  })

  it('起点就在今天之后：没有待完成轮次（§4 规则 2）', () => {
    expect(deriveRounds(template(daily, '2026-02-01'), [], '2026-01-08')).toEqual([])
  })

  it('至多一个待完成轮次：落后 30 天也只有 1 条（不是 30 条逾期）', () => {
    const rounds = deriveRounds(template(daily), [], '2026-02-04')
    expect(rounds).toHaveLength(1)
    expect(rounds[0]?.originalPlannedDate).toBe('2026-02-04')
  })

  it('weekly：待完成轮次落在命中日上，不落在任意一天', () => {
    const weekly: RecurrenceRule = { freq: 'weekly', interval: 1, byDayOfWeek: [0] }
    // starts_on = 01-05（周一），today = 01-21（周三）→ 最后一个 ≤ today 的周一 = 01-19
    expect(deriveRounds(template(weekly), [], '2026-01-21')[0]?.originalPlannedDate).toBe('2026-01-19')
  })
})

describe('deriveRounds · 已完成轮次原样返回、永不重算（§4 规则 1 / ADR-007 §4）', () => {
  it('完成记录照原样返回，并接上一条待完成轮次', () => {
    const rounds = deriveRounds(template(daily), [completion('2026-01-05', '2026-01-06', '0002')], '2026-01-08')
    expect(rounds).toEqual([
      {
        status: 'completed',
        templateId: TEMPLATE_ID,
        originalPlannedDate: '2026-01-05',
        completedDayKey: '2026-01-05',
        title: '喝水',
      },
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-08', title: '喝水' },
    ])
  })

  it('原计划日期**不在当前命中集合里**也照样返回（规则被改过，历史不得重算，§7）', () => {
    // 该轮的原计划日期早于 starts_on，今天的规则永远推不出它——但它已发生
    const rounds = deriveRounds(template(daily), [completion('2026-01-03', '2026-01-04', '0002')], '2026-01-08')
    expect(rounds[0]).toMatchObject({ status: 'completed', originalPlannedDate: '2026-01-03' })
    expect(rounds[1]).toMatchObject({ status: 'pending', originalPlannedDate: '2026-01-08' })
  })

  it('「原样返回」含**顺序**：已完成轮次按传入顺序出现，不被就地重排', () => {
    const rounds = deriveRounds(
      template(daily),
      [completion('2026-01-06', '2026-01-07', '0003'), completion('2026-01-05', '2026-01-06', '0002')],
      '2026-01-08',
    )
    expect(rounds.map((round) => round.originalPlannedDate)).toEqual(['2026-01-06', '2026-01-05', '2026-01-08'])
  })

  it('标题取自模板**当前值**，非快照（§4 / §7：改标题对待完成轮次生效）', () => {
    const rounds = deriveRounds(template(daily, '2026-01-05', '喝水（改名后）'), [], '2026-01-08')
    expect(rounds[0]?.title).toBe('喝水（改名后）')
  })

  it('别的模板的完成记录被过滤掉（§6 把 templateId 放进载荷就是为了这个）', () => {
    const rounds = deriveRounds(template(daily), [completion('2026-01-05', '2026-01-06', '0002', '2026-01-05', 'tpl-other')], '2026-01-08')
    expect(rounds).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-08', title: '喝水' },
    ])
  })
})

describe('deriveRounds · 账号隔离：同 id 的跨账号模板副本互不可见（§1 的 (account_id, id)）', () => {
  it('另一账号持同 id 模板副本时，它的完成记录既不入轮次、也不当链头', () => {
    // ADR-005 明确允许「B 导入 A 导出的同一份文件」→ 两个账号各持一份**同 id** 的模板副本。
    // §1 的主键是 (account_id, id)，即 id 只在账号内唯一，故过滤必须同时比 templateId 与 accountId。
    const rounds = deriveRounds(
      template(daily),
      [
        completion('2026-01-05', '2026-01-06', '0002'),
        // acc-2 的完成记录：templateId 与本模板**相同**，eventId 更大（最后写入）
        completion('2026-01-03', '2026-02-01', '0009', '2026-01-03', TEMPLATE_ID, 'acc-2'),
      ],
      '2026-01-08',
    )
    // 漏掉 accountId 过滤的实现会把 acc-2 那条当成链头（eventId 0009 最大）→ 锚点 02-01
    // 在未来 → 下面这条待完成轮次会消失，本用例因此判得死。
    expect(rounds).toEqual([
      {
        status: 'completed',
        templateId: TEMPLATE_ID,
        originalPlannedDate: '2026-01-05',
        completedDayKey: '2026-01-05',
        title: '喝水',
      },
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-08', title: '喝水' },
    ])
    expect(rounds.some((round) => round.originalPlannedDate === '2026-01-03')).toBe(false)
  })

  it('加载方漏填 accountId → TypeError，而不是静默把历史轮次全丢掉', () => {
    // 漏填的失败模式是**静默**的：过滤会把每条记录都判成「别人的」，界面只剩今天一条
    // 待办、历史全消失，且不报错。故这里响一声（§4 规则 4 / §4.1 的「抛错而非静默」）。
    const broken = { ...completion('2026-01-05', '2026-01-06', '0002'), accountId: undefined } as never
    expect(() => deriveRounds(template(daily), [broken], '2026-01-08')).toThrow(TypeError)
    expect(() => deriveRounds(template(daily), [broken], '2026-01-08')).toThrow(/accountId/)
  })

  it('同一模板 id、同一账号的记录照常参与（过滤不是把 templateId 判废）', () => {
    const rounds = deriveRounds(template(daily), [completion('2026-01-05', '2026-01-06', '0002')], '2026-01-08')
    expect(rounds.map((round) => round.status)).toEqual(['completed', 'pending'])
  })
})

describe('deriveRounds · 「最近一次完成」按事件 id 判定（§4，ADR-001 §2 的排序键）', () => {
  it('链头是**事件 id 最大**的那条，即使它的轮次很旧（跨设备合并 / 补记历史）', () => {
    const rounds = deriveRounds(
      template(daily),
      [
        completion('2026-01-05', '2026-01-06', '0002'),
        // 补记一条旧轮次：事件 id 最大（最后写入），但轮次很旧、锚点却在很远的未来
        completion('2026-01-03', '2026-02-01', '0009'),
      ],
      '2026-01-20',
    )
    // 若按「原计划日期最大」挑链头，会得到锚点 01-06 → 推出一条 01-20 的待完成轮次。
    // 按事件 id 挑则链头是补记那条，锚点 02-01 在未来 → 没有待完成轮次。
    expect(rounds.map((round) => round.status)).toEqual(['completed', 'completed'])
  })

  it('调用方传反了顺序也不影响链头（内部再取一次最大值以防误用，§4 明文要求）', () => {
    const inOrder = deriveRounds(
      template(daily),
      [completion('2026-01-05', '2026-01-06', '0002'), completion('2026-01-07', '2026-01-08', '0003')],
      '2026-01-10',
    )
    const reversed = deriveRounds(
      template(daily),
      [completion('2026-01-07', '2026-01-08', '0003'), completion('2026-01-05', '2026-01-06', '0002')],
      '2026-01-10',
    )
    expect(inOrder.at(-1)?.originalPlannedDate).toBe('2026-01-10')
    expect(reversed.at(-1)?.originalPlannedDate).toBe('2026-01-10')
  })

  it('用**真实形态的 UUIDv7** id 也取最后生成的那条（跨模块隐式依赖的消费侧固化）', () => {
    // 三个 id 是 uuidv7() 的实测输出（主控 2026-09-22 跑 server/lib/uuid.ts 得到），
    // 按生成序排列：定长 36、全小写 → 字典序 === 时间序。
    const [first, second, third] = [
      '01a0c70d-7b55-7000-a2b8-73a5ee47b8d7',
      '01a0c70d-7b55-7001-9751-0d4f8c5e4e24',
      '01a0c70d-7b55-7002-bcdc-7c8ef14943ff',
    ] as const
    // 这一行钉的正是本模块所依赖的性质。若 id 形态变成变长 / 带前缀 / 大写，它先红，
    // 而不是等 deriveRounds 静默取到「最早一次完成」。
    expect([third, first, second].sort()).toEqual([first, second, third])

    const rounds = deriveRounds(
      template(daily),
      [
        completion('2026-01-05', '2026-01-06', first),
        // 补记一条旧轮次，但它是**最后写入**的（生成序最大）→ 它就是链头
        completion('2026-01-03', '2026-02-01', third),
        completion('2026-01-07', '2026-01-08', second),
      ],
      '2026-01-20',
    )
    // 链头 = third（锚点 02-01 在未来）→ 无待完成轮次。
    // 若比较静默反向（取 second / first），会推出一条 01-20 的待完成轮次。
    expect(rounds.filter((round) => round.status === 'pending')).toEqual([])
  })

  it('补记历史时**不会**把已完成的那一轮又列成待办（实例键不得重复，§4）', () => {
    const rounds = deriveRounds(
      template(daily),
      [
        completion('2026-01-05', '2026-01-06', '0002'),
        completion('2026-01-07', '2026-01-08', '0003'),
        // 补记 01-03 那轮：事件 id 最大 → 成为链头，锚点是 01-04
        completion('2026-01-03', '2026-01-04', '0009'),
      ],
      '2026-01-07',
    )
    const pending = rounds.filter((round) => round.status === 'pending')
    const completedDates = rounds.filter((round) => round.status === 'completed').map((r) => r.originalPlannedDate)
    // 锚点 01-04 会把 01-05 / 01-06 / 01-07 都算进候选，但它们都已完成 → 一条都不该出现
    expect(pending).toEqual([])
    expect(completedDates).toHaveLength(3)
  })
})

describe('deriveRounds · 起点来自最近一次完成固化的 nextAnchorDate（§4 规则 2）', () => {
  it('锚点晚于 today 时没有待完成轮次', () => {
    const rounds = deriveRounds(template(daily), [completion('2026-01-05', '2026-02-01', '0002')], '2026-01-08')
    expect(rounds).toHaveLength(1)
    expect(rounds[0]?.status).toBe('completed')
  })

  it('锚点 == today 时待完成轮次就是它', () => {
    const rounds = deriveRounds(template(daily), [completion('2026-01-05', '2026-01-08', '0002')], '2026-01-08')
    expect(rounds.at(-1)).toMatchObject({ status: 'pending', originalPlannedDate: '2026-01-08' })
  })

  it('锚点为 null（规则已终止）时没有待完成轮次，已完成轮次照常返回', () => {
    expect(deriveRounds(template(daily), [completion('2026-01-05', null, '0002')], '2026-01-08')).toEqual([
      {
        status: 'completed',
        templateId: TEMPLATE_ID,
        originalPlannedDate: '2026-01-05',
        completedDayKey: '2026-01-05',
        title: '喝水',
      },
    ])
  })
})

describe('deriveRounds · count / until 约束（§4 规则 3）', () => {
  it('count = 3：待完成轮次停在最后一轮，而不是 today', () => {
    expect(deriveRounds(template({ freq: 'daily', interval: 1, count: 3 }), [], '2026-01-20')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-07', title: '喝水' },
    ])
  })

  it('count = 1：只剩首轮', () => {
    expect(deriveRounds(template({ freq: 'daily', interval: 1, count: 1 }), [], '2026-01-20')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-05', title: '喝水' },
    ])
  })

  it('until = 2026-01-07：待完成轮次停在截止日（含当日）', () => {
    expect(deriveRounds(template({ freq: 'daily', interval: 1, until: '2026-01-07' }), [], '2026-01-20')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-01-07', title: '喝水' },
    ])
  })
})

describe('deriveRounds · 纯函数（ADR-007 §3 / ADR-010 §4）', () => {
  it('同输入两次调用结果恒等（重放安全）', () => {
    const completions = [completion('2026-01-05', '2026-01-06', '0002')]
    expect(deriveRounds(template(daily), completions, '2026-01-08')).toEqual(
      deriveRounds(template(daily), completions, '2026-01-08'),
    )
  })

  it('不改动入参（completions 数组不被就地排序）', () => {
    const completions = [completion('2026-01-07', '2026-01-08', '0003'), completion('2026-01-05', '2026-01-06', '0002')]
    const snapshot = completions.map((item) => item.originalPlannedDate)
    deriveRounds(template(daily), completions, '2026-01-10')
    expect(completions.map((item) => item.originalPlannedDate)).toEqual(snapshot)
  })
})

describe('deriveRounds · 非法输入抛错而非静默（§4 规则 4 的精神）', () => {
  it('today 不是合法日历日 → RangeError', () => {
    expect(() => deriveRounds(template(daily), [], '2026-02-30')).toThrow(RangeError)
    expect(() => deriveRounds(template(daily), [], '2026-1-5')).toThrow(RangeError)
  })

  it('规则不合法 → RecurrenceRuleError', () => {
    expect(() => deriveRounds(template({ freq: 'daily', interval: 0 }), [], '2026-01-08')).toThrow(RecurrenceRuleError)
  })

  it('模板的锚点模式不合法 → RecurrenceRuleError', () => {
    const broken = { ...template(daily), nextAnchorMode: 'skip' as never }
    expect(() => deriveRounds(broken, [], '2026-01-08')).toThrow(RecurrenceRuleError)
  })

  it('固化锚点不晚于本轮计划日 → AnchorInvariantError（§5 点名的那类标量加减缺陷）', () => {
    expect(() => deriveRounds(template(daily), [completion('2026-01-05', '2026-01-05', '0002')], '2026-01-08')).toThrow(
      AnchorInvariantError,
    )
    expect(() => deriveRounds(template(daily), [completion('2026-01-05', '2026-01-04', '0002')], '2026-01-08')).toThrow(
      AnchorInvariantError,
    )
  })

  it('锚点不变式抛出的错里带着两个日期，便于定位', () => {
    try {
      deriveRounds(template(daily), [completion('2026-01-05', '2025-12-31', '0002')], '2026-01-08')
      throw new Error('本应抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(AnchorInvariantError)
      expect((error as AnchorInvariantError).originalPlannedDate).toBe('2026-01-05')
      expect((error as AnchorInvariantError).nextAnchorDate).toBe('2025-12-31')
    }
  })

  it('迭代超过上限 → ProgressionLimitError（起点设得过早，§4 规则 4）', () => {
    expect(() => deriveRounds(template(daily, '1000-01-01'), [], '2026-09-21')).toThrow(ProgressionLimitError)
  })
})

describe('deriveRounds · monthly / yearly（夹取与闰年）', () => {
  it('monthly + byMonthDay:[31]：待完成轮次是**夹取后的落库日**', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31] }
    const rounds = deriveRounds(template(rule, '2026-01-31'), [], '2026-03-05')
    expect(rounds).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-02-28', title: '喝水' },
    ])
  })

  it('monthly：until 与落库日比较（§4 规则 3 的反例）', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31], until: '2026-02-28' }
    expect(deriveRounds(template(rule, '2026-01-31'), [], '2026-12-31')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-02-28', title: '喝水' },
    ])
  })

  it('monthly + count：被夹取的轮次计入 count', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [31], count: 2 }
    expect(deriveRounds(template(rule, '2026-01-31'), [], '2026-12-31')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-02-28', title: '喝水' },
    ])
  })

  it('yearly + starts_on = 2028-02-29：待完成轮次是 2029-02-28（夹取）', () => {
    const rounds = deriveRounds(template({ freq: 'yearly', interval: 1 }, '2028-02-29'), [], '2029-06-01')
    expect(rounds).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2029-02-28', title: '喝水' },
    ])
  })

  it('monthly 多值碰撞：同一落库日只出一条待完成轮次（同日同键）', () => {
    const rule: RecurrenceRule = { freq: 'monthly', interval: 1, byMonthDay: [30, 31] }
    expect(deriveRounds(template(rule, '2026-01-30'), [], '2026-02-28')).toEqual([
      { status: 'pending', templateId: TEMPLATE_ID, originalPlannedDate: '2026-02-28', title: '喝水' },
    ])
  })
})
