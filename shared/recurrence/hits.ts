/**
 * 命中集合的生成（ADR-011 §3 / §4 / §5）。
 *
 * **命中集合** = 规则展开出的、升序排列的「落库日」序列。它有两个来源，缺一不可：
 *
 * 1. **相位原点 = `starts_on`**（§3 / §5「新文本」）。名义日自始至终取自
 *    `byMonthDay` / `starts_on`，**不取自上一轮的落库日**——这一条是硬要求：
 *    若拿上一轮的落库日当基数，`byMonthDay:[31]` 会在 2 月夹取成 28 之后**永久漂到 28 号**
 *    （`yearly` 更严重：2 月 29 日再也回不来）。逐步推进一律以 `starts_on` 为原点重算相位，
 *    因此 `[31]` 的落库日序列是 `31/28(29)/31/30/…` 而不是 `31/28/28/28/…`。
 *
 * 2. **落库日 = min(规则日, 该月天数)**（§3 的夹取策略）。夹取的**策略**在本模块，
 *    月 / 年**算术**经 `./calendar` 落到 `shared/time`（ADR-009 §8）——本模块不自写折算。
 *
 * 序列的两条界（§2 的语法约束决定了二者互斥）：
 * - `until`：与**落库日**比较（§4 规则 3——`until=2026-02-28` + `byMonthDay:[31]` 时
 *   2 月那一轮按落库日 `2/28 ≤ 2/28` **计入**，这正是「基准一律用落库日」的判定用例）；
 * - `count`：被夹取的轮次**计入**（同上）；多值碰撞去重后只计一条。
 */
import { addDays, compareDayKey, diffDays, makeDayKey, parseDayKey, weekStart } from '@shared/time'
import type { DayKey } from '@shared/time'

import { addMonthsClamped, addYearsClamped, daysInMonthOf } from './calendar'
import { normalizeRule } from './rule'
import { ProgressionLimitError } from './types'
import type { RecurrenceRule } from './types'

/**
 * 单次推导的迭代上限（ADR-011 §4 规则 4）。
 * 超过即抛 `ProgressionLimitError`，**不静默截断**。
 */
export const MAX_PROGRESSION_ITERATIONS = 10_000

/** 相位原点到本周周一的偏移：0 = 周一 … 6 = 周日。周口径来自 `weekStart`（ADR-009 §5） */
function weekdayOffset(dk: DayKey): number {
  // diffDays(a, b) 返回 b - a（ADR-009 §7 定了方向，参数序不直观）
  return diffDays(weekStart(dk), dk)
}

/** 去重 + 升序：同一期内多个名义日夹到同一天时（`[30,31]` 遇 2 月）只留一条 */
function uniqueSorted(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b)
}

/**
 * 规则展开的**原始**命中日：升序、无限，k = 0 即 `starts_on`。
 *
 * 不含 `count` / `until` 约束——那两条由 `hitSequence` 统一施加，
 * 免得每个 `freq` 分支各写一遍（写两遍就会有一遍写错）。
 */
function* rawHits(rule: RecurrenceRule, startsOn: DayKey): Generator<DayKey> {
  switch (rule.freq) {
    case 'daily': {
      for (let k = 0; ; k += 1) yield addDays(startsOn, k * rule.interval)
      return
    }

    case 'weekly': {
      // 无 byDayOfWeek 时相位就是 starts_on 自己的星期几；有则按列表展开
      const offsets = rule.byDayOfWeek ?? [weekdayOffset(startsOn)]
      const weekOrigin = weekStart(startsOn)
      for (let k = 0; ; k += 1) {
        const weekAnchor = addDays(weekOrigin, 7 * rule.interval * k)
        for (const offset of offsets) yield addDays(weekAnchor, offset)
      }
      return
    }

    case 'monthly': {
      // 相位原点：命中「月」= starts_on 所在月 + k * interval 个月（夹取不改变月份，故安全）
      const { day: startsDay } = parseDayKey(startsOn)
      for (let k = 0; ; k += 1) {
        const anchor = addMonthsClamped(startsOn, k * rule.interval)
        const { year, month } = parseDayKey(anchor)
        const length = daysInMonthOf(anchor)
        // 名义日取自 byMonthDay；未给则取 starts_on 的日（§5 三步式：归属月 → 名义日 → 落库日）
        const nominal = rule.byMonthDay ?? [startsDay]
        for (const value of uniqueSorted(nominal.map((day) => clampToMonth(day, length)))) {
          yield makeDayKey(year, month, value)
        }
      }
      return
    }

    case 'yearly': {
      // yearly 无 BY*，名义月日 = starts_on 的月日（ADR-011 §2）。
      // 以 starts_on 为基数加 N 年，夹取由 addYearsClamped 完成——
      // 关键是基数恒为 starts_on，故 2028-02-29 + 4 年仍是 2/29（不会被 2029 的夹取结果带偏）。
      for (let k = 0; ; k += 1) yield addYearsClamped(startsOn, k * rule.interval)
      return
    }
  }
}

/**
 * 夹取（ADR-011 §3）：**落库日 = min(规则日, 该月天数)**。
 * `-1` = 月末，**永不夹取**（月末总是存在）；其余值取 min。
 */
function clampToMonth(nominalDay: number, monthLength: number): number {
  return nominalDay === -1 ? monthLength : Math.min(nominalDay, monthLength)
}

/**
 * 命中序列：升序的**落库日**，已计入 `count` / `until`。
 *
 * 首轮**恒为 `starts_on`**（ADR-011 §4 规则 2，已登记）——即使 `starts_on` 本身不满足
 * `byDayOfWeek` / `byMonthDay`，它仍是第 1 轮，后续轮次是规则展开中**严格晚于**它的那些
 * 日子。依据是 §1 把 `starts_on` 定义为「首轮的原计划日期」起点（同 RRULE 的 `DTSTART`；
 * RFC 5545 对这种不同步的组合说 recurrence set `undefined`，故由 ADR 定义，不从 RFC 推定）。
 * 用户可见后果：周一创建一条「每周五」的重复任务，第一轮显示为**今天**。
 *
 * 迭代计数从**相位原点**起算（含被跳过的前缀），因为跳过的前缀也是真实工作量：
 * 这样上限保护才真的能挡住「`starts_on` 设得过早」的路径（§4 规则 4 的立法理由）。
 */
export function* hitSequence(
  rule: RecurrenceRule,
  startsOn: DayKey,
  options: { maxIterations?: number } = {},
): Generator<DayKey> {
  const normalized = normalizeRule(rule)
  const limit = options.maxIterations ?? MAX_PROGRESSION_ITERATIONS

  if (normalized.until !== undefined && compareDayKey(startsOn, normalized.until) > 0) return
  if (normalized.count !== undefined && normalized.count < 1) return

  let emitted = 1
  yield startsOn

  let iterations = 0
  for (const hit of rawHits(normalized, startsOn)) {
    iterations += 1
    if (iterations > limit) throw new ProgressionLimitError(startsOn, limit)
    if (compareDayKey(hit, startsOn) <= 0) continue // 相位原点及其之前：首轮已产出，余者不产生轮次
    if (normalized.until !== undefined && compareDayKey(hit, normalized.until) > 0) return
    if (normalized.count !== undefined && emitted >= normalized.count) return
    emitted += 1
    yield hit
  }
}

/**
 * `[from, to]` 区间内的落库日（闭区间，两端都是**落库日**口径）。
 *
 * 存在的理由不只是测试：ADR-011 §8 要求导出时对每一个**被夹取过的日期**追加 `RDATE`
 * 条目，而 `RDATE` 只能在导出范围内枚举（§8「边界」）——那个枚举就是本函数。
 */
export function hitsBetween(
  rule: RecurrenceRule,
  startsOn: DayKey,
  from: DayKey,
  to: DayKey,
  options: { maxIterations?: number } = {},
): DayKey[] {
  const collected: DayKey[] = []
  if (compareDayKey(from, to) > 0) return collected
  for (const hit of hitSequence(rule, startsOn, options)) {
    if (compareDayKey(hit, from) < 0) continue
    if (compareDayKey(hit, to) > 0) return collected
    collected.push(hit)
  }
  return collected
}

/** 严格晚于 `from` 的第一个命中日；序列已终止（`count` / `until`）时 `null` */
export function firstHitAfter(rule: RecurrenceRule, startsOn: DayKey, from: DayKey): DayKey | null {
  for (const hit of hitSequence(rule, startsOn)) {
    if (compareDayKey(hit, from) > 0) return hit
  }
  return null
}

/** 不早于 `from` 的第一个命中日；序列已终止时 `null` */
export function firstHitAtOrAfter(rule: RecurrenceRule, startsOn: DayKey, from: DayKey): DayKey | null {
  for (const hit of hitSequence(rule, startsOn)) {
    if (compareDayKey(hit, from) >= 0) return hit
  }
  return null
}

/** 严格晚于 `from` 的命中日序列（惰性，供锚点②逐步推进用，避免 O(n²) 重走） */
export function* hitsStrictlyAfter(
  rule: RecurrenceRule,
  startsOn: DayKey,
  from: DayKey,
): Generator<DayKey> {
  for (const hit of hitSequence(rule, startsOn)) {
    if (compareDayKey(hit, from) > 0) yield hit
  }
}
