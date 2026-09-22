/**
 * 三锚点（ADR-011 §5）—— 在**完成时刻**计算并固化，不需要任何定时器（ADR-007 §5）。
 *
 * 设 `P` = 本轮的原计划日期，`I` = 规则间隔，`T` = 完成日的 dayKey：
 *
 * | 模式 | `nextAnchorDate` |
 * |---|---|
 * | `extend` ①按原期限顺延 | 从 `P` **推进一次** |
 * | `catch_up` ②追赶到今天之后（默认） | 从 `P` 起逐步推进，直到 `> T` |
 * | `recompute` ③按完成日重算 | 候选 = 从 `T` **加一个间隔**，再向上对齐到第一个命中日 |
 *
 * **锚点一律是「按规则推进到的下一个合法命中日」，不是标量加减的结果**（§5 开头）。
 * 写成 `P + I` 会算出 `2026-02-31` 这类不存在的日历日，而 `makeDayKey` 对它抛
 * `RangeError`——结果是「按期完成一个每月 31 号的轮次会抛错，完成事件根本写不进去」。
 * 这正是阶段 2 复核发现的原缺陷。
 *
 * ③ 的**候选**用标量加间隔，与上面这条不冲突（主控 2026-09-22 明确）：
 * 被禁止的是「把标量加减的**结果**落定成锚点」，不是禁止使用标量加减。
 * 候选只用来对齐，它**不进入命中序列、不作为下一轮的基数**，因此不会重新引入
 * 「夹取日成为基数 → 名义日永久漂移」的缺陷（§5「新文本」）。
 */
import { addDays, compareDayKey } from '@shared/time'
import type { DayKey } from '@shared/time'

import { addMonthsClamped, addYearsClamped } from './calendar'
import { firstHitAfter, firstHitAtOrAfter, hitsStrictlyAfter } from './hits'
import { assertValidRule, validateAnchorMode } from './rule'
import { RecurrenceRuleError } from './types'
import type { NextAnchorMode, RecurrenceRule } from './types'

export interface AnchorInput {
  rule: RecurrenceRule
  /** 命中集合的相位原点（ADR-011 §1 / §3） */
  startsOn: DayKey
  /** `P`：本轮的原计划日期 */
  plannedDate: DayKey
  /** `T`：完成日的 dayKey */
  completedDayKey: DayKey
}

/**
 * 从 `from` **加一个间隔**：`daily` / `weekly` 加天，`monthly` / `yearly` 加月 / 年。
 *
 * 这是「一个间隔」的字面量，且月 / 年算术经 `shared/time`（ADR-009 §8），
 * 本模块不自写。**③ 专用**：它只产生候选，锚点必须再对齐到命中日。
 */
export function addOneInterval(rule: RecurrenceRule, from: DayKey): DayKey {
  switch (rule.freq) {
    case 'daily':
      return addDays(from, rule.interval)
    case 'weekly':
      return addDays(from, 7 * rule.interval)
    case 'monthly':
      return addMonthsClamped(from, rule.interval)
    case 'yearly':
      return addYearsClamped(from, rule.interval)
  }
}

/**
 * 完成时刻算出的下一轮锚点；`null` = **规则已终止**（达到 `count` 或越过 `until`），
 * 不存在下一轮（ADR-011 §4；主控 2026-09-22 裁决确认）。
 *
 * 此时 FR2.5 的「下一轮 X 日」提示不出现——**不得填一个越界日期充数**。
 */
export function nextAnchorDate(mode: NextAnchorMode, input: AnchorInput): DayKey | null {
  // 运行时也要挡未知模式：TS 的联合类型挡不住 JS 调用方与 `as never` 的探针，
  // 而 `switch` 缺省落到函数末尾会**静默返回 `undefined`**（见 rule.ts 的同名判定）
  const modeViolations = validateAnchorMode(mode)
  if (modeViolations.length > 0) throw new RecurrenceRuleError(modeViolations)

  assertValidRule(input.rule, input.startsOn)
  const { rule, startsOn, plannedDate, completedDayKey } = input

  switch (mode) {
    // ①按原期限顺延：从 P 推进一次。连续晚做会持续逾期（故它会、且只有它会触发逾期提示）
    case 'extend':
      return firstHitAfter(rule, startsOn, plannedDate)

    // ②追赶到今天之后：从 P 起逐步推进，直到 > T。每一「步」都过 §3 的夹取（因为步 = 命中日）
    case 'catch_up': {
      for (const hit of hitsStrictlyAfter(rule, startsOn, plannedDate)) {
        if (compareDayKey(hit, completedDayKey) > 0) return hit
      }
      return null
    }

    // ③按完成日重算：候选 = T 加一个间隔，再向上对齐到第一个命中日
    case 'recompute': {
      const candidate = addOneInterval(rule, completedDayKey)
      const aligned = firstHitAtOrAfter(rule, startsOn, candidate)
      if (aligned === null) return null // 候选之后已无命中日（count / until 终止）
      if (compareDayKey(aligned, plannedDate) > 0) return aligned
      // **§5 的锚点不变式**：「`nextAnchorDate` 恒为一个『尚不存在』的轮次，即严格晚于
      // 本轮的原计划日期 `P`」。上面三行默认了 T ≥ P（按时或迟做），而提前完成完全正常
      // （计划周一做、周日就做了）。此时候选 T + I 可能落到 ≤ P：
      //   P = 01-05、T = 01-04、daily → 候选 = 01-05 = P：锚点与**刚完成那一轮**同实例键，
      //     下次 deriveRounds 撞键抛 AnchorInvariantError，该模板的待办列表整体失效；
      //   P = 01-10、T = 01-08、daily → 候选 = 01-09 < P：锚点倒着指回刚完成的轮次之前，
      //     FR2.5 的「下一轮 X 日」比刚完成的轮次还早，且与 §4 实际推的待完成轮次不是同一天。
      // 故此处取 P 之后的第一个命中日（在该支上退化为 ①）。
      // **不变式优先于模式差异**——撞键或倒指的锚点不是「另一种合理排期」，而是会破坏
      // 待办列表、并会被阶段 3 固化进事件、在阶段 4 显示给用户（§5「锚点的不变式」）。
      // 正常情形（T ≥ P）下 candidate = T + I > P，本分支不被触发，行为与 §5 文本逐字一致。
      return firstHitAfter(rule, startsOn, plannedDate)
    }
  }
}

/**
 * ADR-011 §5 的逾期提示触发条件：**在且仅在 `nextAnchorDate ≤ 今天` 时出现**。
 *
 * §5 的表已推出它**只可能在模式①下发生**——②③ 恒 `> T`（= 完成日 = 今天），
 * 故本函数对它们恒为 `false`。写成独立函数是为了让阶段 4 有可判定的断言，
 * 而不是去测一个永不发生的分支。
 */
export function shouldPromptOverdue(nextAnchor: DayKey | null, today: DayKey): boolean {
  if (nextAnchor === null) return false
  return compareDayKey(nextAnchor, today) <= 0
}
