/**
 * 快速录入的词表与**有序规则表** —— ADR-014 §3。
 *
 * 本文件是 §3 那张表的**字面数据**：`RULES` 的数组序 === 表的「序」列。
 * §2 的决胜层（跨度相同时取序数小者）直接依赖这个顺序，故**不得重排**
 * （表中现存规则逐族核对后不存在同长冲突，故决胜层是防御性的——
 * 它保证将来有人加进会冲突的规则时，行为仍是确定的、可测的）。
 *
 * 三条纪律（§8，逐条可被 `discipline.test.ts` 扫描）：
 *
 * - 一切日期折算经 `@shared/time`：本文件**不自写闰年公式**、不碰 `Date` 的
 *   `getUTCDay` / `toISOString`。合法性判定一律走 `makeDayKey` / `daysInMonthOf`；
 * - 星期索引唯一口径 **0 = 周一 … 6 = 周日**（ADR-011 §2），由
 *   `diffDays(weekStart(dk), dk)` 得到（与 `shared/recurrence/hits.ts` 的 `weekdayOffset`
 *   同一表达式）。JS 的 `getUTCDay()`（0 = 周日）**不得进入本模块的任何值**；
 * - **词表里不许有落点不存在的碎片**（§3 末段）：识别了却无处安放 = 静默数据丢失，
 *   而 FR2.3 明令「无法解析的文本一律留在标题」。故 `上午` / `9点` 一类的时刻词
 *   根本不在这张表里。
 *
 * ## 本文件里两处** ADR 未逐字规定**的实现决定（已在实现报告里登记，不藏在这里）
 *
 * 1. **「占位但不出 token」**（`{ end, token: null }`）。有些形态在**字形上**确实是一段
 *    碎片，但其**值**落不了地：`2月30日`（日期不存在）、`每月32号`（`byMonthDay` 装不下）、
 *    `#不存在的项目`（ADR-016 §6 名字匹配不唯一或不存在）、第 21 个 `@` 标签。
 *    这些位置**认领跨度但产出 `null`**，于是①它们的原文一个字都不动地留在标题里
 *    （FR2.3），②扫描不会滑进它们内部去匹配出别的碎片。第二条是必须的：
 *    `每年13月5日` 若整块放弃认领，`3月5日` 会在下标 3 上被 `md-cn` 收成一个
 *    **日期**碎片，用户会看到「计划日 2027年3月5日 + 标题里剩下『每年1』」——
 *    比「整串留在标题」糟得多。这解释了为什么「不识别」在本模块里**不是**「返回 null」。
 * 2. **数字域失败不回退到更短的形态**。`每月32号` 里 `每月[N]号` 字形成立而 `32` 越界，
 *    此时**不**退回到 `每月`（那会把用户写下的日锚点悄悄换成「按 D₀ 的日号」）。
 *    与之相对，**字形**失败要回退：`每周八` 的最长匹配是 `每周`，`八` 留在标题
 *    （§5.5 明写这是正确行为）。两者的分界是「用户写的东西越界了」vs「用户后面还写了别的」。
 */
import {
  addDays,
  addMonths,
  compareDayKey,
  daysInMonthOf,
  diffDays,
  makeDayKey,
  parseDayKey,
  weekStart,
} from '@shared/time'
import type { DayKey } from '@shared/time'
import type { RecurrenceRule } from '@shared/recurrence'
// 默认锚点模式的**唯一**声明在 `shared/recurrence/types.ts`（ADR-014 §7：
// 「`DEFAULT_NEXT_ANCHOR_MODE` 必须只有一处声明」，「快速录入**不新增第二处默认值**」）。
// ⚠️ 这是本模块**唯一**一条 `@shared/time` 之外的**运行时**导入——§8 的白名单在字面上与
// §7 的这条要求冲突（要满足 §7 就得运行时导入一个值），已在 `discipline.test.ts` 里
// 登记为**具名且限定到文件**的例外，并在实现报告里报给主控收口。
import { DEFAULT_NEXT_ANCHOR_MODE } from '@shared/recurrence/types'
import type { RecurrenceSpec } from '@shared/tasks/types'

import { MAX_TAG_NAME_LENGTH } from './types'
import type { PatternId, ProjectRef, QuickAddToken } from './types'

/** §4.2：裸月日的搜索上界。「世纪年不闰」造成的最大闰年间隔是 8 年（2096 → 2104） */
const MONTH_DAY_WINDOW_YEARS = 8

// ────────────────────────── 扫描环境与匹配结果 ──────────────────────────

export interface ScanEnv {
  /** 本次解析的「今天」（由 `today(timeContext, now)` 派生，随 `QuickAddParse` 固化） */
  readonly today: DayKey
  /** 只含**未删除**的项目（ADR-016 §6）；空数组 ⇒ `#` 片段一律不识别 */
  readonly projects: readonly ProjectRef[]
}

/**
 * 一次匹配的结果。
 *
 * `token === null` = **认领了 `[start, end)` 这段文本，但产出不了 token**
 * （见文件头的实现决定 1）。扫描据此跳过该跨度，于是其原文完整地留在标题里。
 */
export interface Candidate {
  readonly end: number
  readonly token: QuickAddToken | null
}

export type Matcher = (text: string, start: number, env: ScanEnv) => Candidate | null

export interface Rule {
  readonly id: PatternId
  readonly match: Matcher
}

// ────────────────────────── 字符与数字读取 ──────────────────────────

const ASCII_DIGIT = /^[0-9]$/
const ASCII_ALNUM = /^[0-9A-Za-z]$/
const HAN = /\p{Script=Han}/u
const WHITESPACE = /\s/

function charAt(text: string, index: number): string | null {
  if (index < 0 || index >= text.length) return null
  return text[index] ?? null
}

function isAsciiDigitAt(text: string, index: number): boolean {
  const ch = charAt(text, index)
  return ch !== null && ASCII_DIGIT.test(ch)
}

/** §5.1 的左边界：串首，或前一字符不是 ASCII 数字（`12026-09-23` 靠它不识别） */
function leftNonDigit(text: string, start: number): boolean {
  return !isAsciiDigitAt(text, start - 1)
}

/** §5.1 的右边界：串尾，或后一字符不是 ASCII 数字 */
function rightNonDigit(text: string, end: number): boolean {
  return !isAsciiDigitAt(text, end)
}

/** §5.1：`md-slash` / `md-dash` 是**整 token**——串首或空白（两侧同款判据） */
function atTokenEdge(text: string, index: number): boolean {
  const ch = charAt(text, index)
  return ch === null || WHITESPACE.test(ch)
}

/** §5.2：`#` / `@` / `!` 的左边界 = 串首，或前一字符不是 ASCII 字母数字 */
function leftSymbolBoundary(text: string, start: number): boolean {
  const ch = charAt(text, start - 1)
  return ch === null || !ASCII_ALNUM.test(ch)
}

interface DigitRun {
  readonly value: number
  readonly digits: string
  readonly end: number
}

/**
 * 读一串**最长**的阿拉伯数字。`max` 是该字段允许的位数——
 * 超过即不成立（`[M]` 最多 2 位，故 `123月4日` 里的 `123` 不认，
 * 而左边界会再挡掉从 `23月4日` 起匹配的那次）。
 */
function readDigits(text: string, from: number, max: number): DigitRun | null {
  let i = from
  while (isAsciiDigitAt(text, i)) i += 1
  const digits = text.slice(from, i)
  if (digits.length === 0 || digits.length > max) return null
  return { value: Number(digits), digits, end: i }
}

// ────────────────────────── 日期的唯一折算处 ──────────────────────────

/** 星期索引：0 = 周一 … 6 = 周日（ADR-011 §2 的唯一口径） */
function weekdayIndex(dk: DayKey): number {
  // diffDays(a, b) 返回 b - a（ADR-009 §7 定了方向）
  return diffDays(weekStart(dk), dk)
}

/** 该 dayKey 所在月的 1 号（月算术的安全落点：1 号在任何月份都存在） */
function firstDayOfMonth(dk: DayKey): DayKey {
  const { year, month } = parseDayKey(dk)
  return makeDayKey(year, month, 1)
}

/** 具体某年某月某日；**不存在即 `null`**（绝不夹取，§4.2 与 ADR-009 §7 同源） */
function exactDate(year: number, month: number, day: number): DayKey | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return null
  const first = makeDayKey(year, month, 1)
  if (daysInMonthOf(first) < day) return null
  return makeDayKey(year, month, day)
}

/**
 * §4.2 的「下一个该月日」：今年起 8 年内的第一个「存在的、不早于 `from` 的」该月日。
 *
 * `from` 在本模块有两个来源：解析时是 `today`（裸 `[M]月[D]日`），
 * 重复规则上是 `D₀`（§7 的 `每年[N]月[N]日`）。**同一个函数，不写第二份**。
 */
function nextMonthDay(month: number, day: number, from: DayKey): DayKey | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const startYear = parseDayKey(from).year
  for (let k = 0; k < MONTH_DAY_WINDOW_YEARS; k += 1) {
    const year = startYear + k
    if (year > 9999) return null
    const first = makeDayKey(year, month, 1)
    if (daysInMonthOf(first) < day) continue
    const candidate = makeDayKey(year, month, day)
    if (compareDayKey(candidate, from) >= 0) return candidate
  }
  return null
}

/**
 * 重复任务的**首轮落库日** = 不早于 `d0` 的第一个落库日（§7）。
 *
 * 为什么不能直接拿 `d0` 当 `startsOn`：`hitSequence` 有一条已被测试锁定的行为——
 * **首轮恒为 `starts_on`**（ADR-011 §4 规则 2），即使它不满足 `byDayOfWeek`。
 * 于是「周一创建一条每周五的任务」第一轮会显示成**今天**，而用户明明写的是周五。
 * 本模块显式取「首个落库日」把它消掉。
 *
 * 相位原点未定（它正是这里要算的东西），故**不能反过来调 `hitSequence`**——
 * 这里用 `@shared/time` 的原语直接算。ADR-014 §7 已把这处「算法级重复实现」
 * 登记为主动登记项，测试用 `firstHitAtOrAfter(rule, startsOn, d0) === startsOn`
 * 把两处钉在一起。
 *
 * `yearly` 的**带锚点月日**形态不在这里：那时月日只写在 `startsOn` 里（§7 的表），
 * 由 `recur-yearly` 的匹配器用它自己解析出的 (月, 日) 直接算，无需第二阶段反推。
 */
export function firstFallOnOrAfter(rule: RecurrenceRule, d0: DayKey): DayKey {
  switch (rule.freq) {
    case 'daily':
      return d0

    case 'weekly': {
      const targets = rule.byDayOfWeek
      if (targets === undefined || targets.length === 0) return d0
      const here = weekdayIndex(d0)
      let best = 7
      for (const target of targets) {
        const offset = (((target - here) % 7) + 7) % 7
        if (offset < best) best = offset
      }
      return addDays(d0, best)
    }

    case 'monthly': {
      const nominal = rule.byMonthDay?.[0]
      if (nominal === undefined) return d0
      // 从 d0 所在月起逐月看「按 ADR-011 §3 夹取后的 N 号」，取第一个 ≥ d0 的。
      // 夹取的是**规则的名义日**（ADR-011 §3 的用户裁决），不夹取的是用户手写的具体日期
      // （`2月30日` 不是日期，不替它编一个）——两者不可混同，§7 的注已说明。
      let cursor = firstDayOfMonth(d0)
      for (let k = 0; k < 24; k += 1) {
        const { year, month } = parseDayKey(cursor)
        const day = Math.min(nominal, daysInMonthOf(cursor))
        const candidate = makeDayKey(year, month, day)
        if (compareDayKey(candidate, d0) >= 0) return candidate
        cursor = addMonths(cursor, 1)
      }
      return d0 // 不可达：夹取后的日号最迟下一个月就 ≥ d0（`cursor` 是 1 号，不会抛错）
    }

    case 'yearly':
      // `每年` / `每[N]年`：命中日 = `startsOn` 的月日（ADR-011 §2），故首轮就是 D₀。
      // 带锚点月日的形态（`每年3月5日`）由 `matchRecurYearly` 自己算，见上面的注。
      return d0
  }
}

// ────────────────────────── token 构造 ──────────────────────────

function tokenBase(
  pattern: PatternId,
  text: string,
  start: number,
  end: number,
): { pattern: PatternId; start: number; end: number; text: string } {
  return { pattern, start, end, text: text.slice(start, end) }
}

function dateToken(pattern: PatternId, text: string, start: number, end: number, date: DayKey): QuickAddToken {
  return { ...tokenBase(pattern, text, start, end), kind: 'date', date }
}

function commit(asDate: DayKey | null, build: (date: DayKey) => QuickAddToken, end: number): Candidate {
  // 认领跨度但不出 token：见文件头的实现决定 1
  if (asDate === null) return { end, token: null }
  return { end, token: build(asDate) }
}

// ────────────────────────── 片段 #1–#4、#9、#10：具体某一天 ──────────────────────────

/** #1 `[YYYY]年[M]月[D]日` / `[YYYY]年[M]月[D]号`（该日必须真实存在） */
const matchYmdCn: Matcher = (text, start, env) => {
  const year = readDigits(text, start, 4)
  if (year === null || year.digits.length !== 4) return null
  if (charAt(text, year.end) !== '年') return null
  const month = readDigits(text, year.end + 1, 2)
  if (month === null || charAt(text, month.end) !== '月') return null
  const day = readDigits(text, month.end + 1, 2)
  if (day === null) return null
  const tail = charAt(text, day.end)
  if (tail !== '日' && tail !== '号') return null
  const end = day.end + 1
  if (!leftNonDigit(text, start) || !rightNonDigit(text, end)) return null
  return commit(exactDate(year.value, month.value, day.value), (date) => dateToken('ymd-cn', text, start, end, date), end)
}

/** #2 `[M]月[D]日` / `[M]月[D]号`（§4.2 的「下一个该月日」） */
const matchMdCn: Matcher = (text, start, env) => {
  const month = readDigits(text, start, 2)
  if (month === null || charAt(text, month.end) !== '月') return null
  const day = readDigits(text, month.end + 1, 2)
  if (day === null) return null
  const tail = charAt(text, day.end)
  if (tail !== '日' && tail !== '号') return null
  const end = day.end + 1
  if (!leftNonDigit(text, start) || !rightNonDigit(text, end)) return null
  return commit(nextMonthDay(month.value, day.value, env.today), (date) => dateToken('md-cn', text, start, end, date), end)
}

/** #3 `[YYYY]-[M]-[D]`（该日必须真实存在） */
const matchYmd: Matcher = (text, start, env) => {
  const year = readDigits(text, start, 4)
  if (year === null || year.digits.length !== 4 || charAt(text, year.end) !== '-') return null
  const month = readDigits(text, year.end + 1, 2)
  if (month === null || charAt(text, month.end) !== '-') return null
  const day = readDigits(text, month.end + 1, 2)
  if (day === null) return null
  const end = day.end
  if (!leftNonDigit(text, start) || !rightNonDigit(text, end)) return null
  return commit(exactDate(year.value, month.value, day.value), (date) => dateToken('ymd', text, start, end, date), end)
}

/** #4 `[N]天后`，N ∈ 1…3650（≤10 年；上界是「计划的时间尺度」） */
const matchDaysAfter: Matcher = (text, start, env) => {
  const run = readDigits(text, start, 12)
  if (run === null) return null
  if (!text.startsWith('天后', run.end)) return null
  const end = run.end + 2
  // 下界取 1 而不是 0：`0天后` 与 `今天` 是同一个日子的两种写法，收它只会多一条等价规则；
  // 上界取 3650：超出这个范围的 `N天后` 更可能是编号或误输入，不识别比落一个十年后的日期安全。
  if (run.value < 1 || run.value > 3650) return { end, token: null }
  return { end, token: dateToken('days-after', text, start, end, addDays(env.today, run.value)) }
}

/** #9 `[M]/[D]`（同 `md-cn`；整 token，两侧须为串首/串尾/空白） */
const matchMdSlash: Matcher = (text, start, env) => {
  const month = readDigits(text, start, 2)
  if (month === null || charAt(text, month.end) !== '/') return null
  const day = readDigits(text, month.end + 1, 2)
  if (day === null) return null
  const end = day.end
  if (!atTokenEdge(text, start - 1) || !atTokenEdge(text, end)) return null
  return commit(nextMonthDay(month.value, day.value, env.today), (date) => dateToken('md-slash', text, start, end, date), end)
}

/** #10 `[M]-[D]`（同 `md-cn`；整 token，两侧须为串首/串尾/空白） */
const matchMdDash: Matcher = (text, start, env) => {
  const month = readDigits(text, start, 2)
  if (month === null || charAt(text, month.end) !== '-') return null
  const day = readDigits(text, month.end + 1, 2)
  if (day === null) return null
  const end = day.end
  if (!atTokenEdge(text, start - 1) || !atTokenEdge(text, end)) return null
  return commit(nextMonthDay(month.value, day.value, env.today), (date) => dateToken('md-dash', text, start, end, date), end)
}

// ────────────────────────── 周族：片段 #5–#7 ──────────────────────────

/**
 * `[P]` 的候选**按长度降序**（§3 的强调）：`下下 | 上上 | 本 | 这 | 下 | 上`。
 *
 * §2 的最长优先是**跨规则**的；在一个规则**内部**若把它写成选择分支，
 * 能否取到最长的那个前缀就取决于匹配器是否回溯。写死顺序之后，
 * 换一个不回溯的匹配器也仍然得到同一答案——**让「结果确定」不依赖实现细节**。
 */
const WEEK_PREFIXES: readonly (readonly [string, number])[] = [
  ['下下', 2],
  ['上上', -2],
  ['本', 0],
  ['这', 0],
  ['下', 1],
  ['上', -1],
]

function readWeekPrefix(text: string, from: number): { weeks: number; end: number } | null {
  for (const [word, weeks] of WEEK_PREFIXES) {
    if (text.startsWith(word, from)) return { weeks, end: from + word.length }
  }
  return null
}

/** `[D]` = 一二三四五六日天；0 = 周一 … 6 = 周日 */
const WEEKDAY_CHARS: Readonly<Record<string, number>> = {
  一: 0,
  二: 1,
  三: 2,
  四: 3,
  五: 4,
  六: 5,
  日: 6,
  天: 6,
}

function readWeekdayChar(text: string, index: number): number | null {
  const ch = charAt(text, index)
  if (ch === null) return null
  const target = WEEKDAY_CHARS[ch]
  return target === undefined ? null : target
}

/** 读 `周` / `星期`，返回其后的下标 */
function readWeekUnit(text: string, from: number): number | null {
  if (text.startsWith('星期', from)) return from + 2
  if (charAt(text, from) === '周') return from + 1
  return null
}

/** #5 `[P]周[D]` / `[P]星期[D]` —— 第 P 周的星期 D（§4.3） */
const matchWeekPrefixed: Matcher = (text, start, env) => {
  const prefix = readWeekPrefix(text, start)
  if (prefix === null) return null
  const unitEnd = readWeekUnit(text, prefix.end)
  if (unitEnd === null) return null
  const target = readWeekdayChar(text, unitEnd)
  if (target === null) return null
  const end = unitEnd + 1
  // 周的边界 = weekStart / weekEnd（ADR-009 §5，周一至周日，全系统唯一口径）
  const date = addDays(weekStart(env.today), prefix.weeks * 7 + target)
  return { end, token: dateToken('week-prefixed', text, start, end, date) }
}

/** #6 `[P]周` / `[P]星期` —— 第 P 周，**规范化存该周周一**，落 `plannedWeek`（§4.3 的粒度判据） */
const matchWeekPrefix: Matcher = (text, start, env) => {
  const prefix = readWeekPrefix(text, start)
  if (prefix === null) return null
  const unitEnd = readWeekUnit(text, prefix.end)
  if (unitEnd === null) return null
  const weekStartDate = addDays(weekStart(env.today), prefix.weeks * 7)
  return {
    end: unitEnd,
    token: {
      ...tokenBase('week-prefix', text, start, unitEnd),
      kind: 'plannedWeek',
      weekStart: weekStartDate,
    },
  }
}

/** #7 `周[D]` / `星期[D]` —— 下一个星期 D，**含今天**（§4.1） */
const matchWeekday: Matcher = (text, start, env) => {
  const unitEnd = readWeekUnit(text, start)
  if (unitEnd === null) return null
  const target = readWeekdayChar(text, unitEnd)
  if (target === null) return null
  const end = unitEnd + 1
  // §4.1：offset = (D - weekdayIndex(today) + 7) % 7。今天是周五时 `周五` = 今天
  // （两种读法里唯一不把任务凭空推到七天后的一种）；今天已过周五则指即将到来的那个。
  const date = addDays(env.today, (target - weekdayIndex(env.today) + 7) % 7)
  return { end, token: dateToken('weekday', text, start, end, date) }
}

// ────────────────────────── #8 相对日 ──────────────────────────

/** 按长度降序（`大后天` 先于 `后天`；同长互斥） */
const DAY_WORDS: readonly (readonly [string, number])[] = [
  ['大后天', 3],
  ['大前天', -3],
  ['今天', 0],
  ['明天', 1],
  ['后天', 2],
  ['昨天', -1],
  ['前天', -2],
]

const matchDayWord: Matcher = (text, start, env) => {
  for (const [word, offset] of DAY_WORDS) {
    if (text.startsWith(word, start)) {
      const end = start + word.length
      return { end, token: dateToken('day-word', text, start, end, addDays(env.today, offset)) }
    }
  }
  return null
}

// ────────────────────────── #11–#14 重复族 ──────────────────────────

/** `每` + `[N]` + `单位`：读间隔与下标。`digits` 的上界 4 位避免把长数字串当间隔 */
function readInterval(
  text: string,
  start: number,
  unit: string,
): { interval: number; end: number } | null {
  const run = readDigits(text, start + 1, 4)
  if (run === null) return null
  if (!text.startsWith(unit, run.end)) return null
  return { interval: run.value, end: run.end + unit.length }
}

function recurrenceCandidate(
  pattern: PatternId,
  text: string,
  start: number,
  end: number,
  rule: RecurrenceRule,
  env: ScanEnv,
  startsOnOverride?: DayKey,
): Candidate {
  // `interval` 的合法域是 ≥ 1（ADR-011 §2）：`每0天` 若被收下，交出的规则会被
  // `validateRule` 拒绝。与其交一个必被拒绝的规则，不如不识别（§5.5 的同一纪律）。
  if (rule.interval < 1) return { end, token: null }
  const spec: RecurrenceSpec = {
    rule,
    nextAnchorMode: DEFAULT_NEXT_ANCHOR_MODE,
    startsOn: startsOnOverride ?? firstFallOnOrAfter(rule, env.today),
  }
  return {
    end,
    token: { ...tokenBase(pattern, text, start, end), kind: 'recurrence', recurrence: spec },
  }
}

/**
 * #11 `每[N]年[N]月[N]日` / `每年[N]月[N]日` / `每[N]年` / `每年`
 *
 * 带锚点月日的形态把 (月, 日) **写进 `startsOn`**（§7 的表），规则本身只有
 * `{freq:'yearly', interval:N}`——ADR-011 §2：`yearly` 无 `BY*` 时命中日 = `startsOn` 的月日。
 */
const matchRecurYearly: Matcher = (text, start, env) => {
  if (charAt(text, start) !== '每') return null

  // ① 每[N]年[N]月[N]日
  const withInterval = readInterval(text, start, '年')
  if (withInterval !== null) {
    const anchored = readYearlyAnchor(text, withInterval.end)
    if (anchored.kind === 'out-of-range') return { end: anchored.end, token: null }
    if (anchored.kind === 'ok') {
      const startsOn = nextMonthDay(anchored.month, anchored.day, env.today)
      if (startsOn === null) return { end: anchored.end, token: null }
      return recurrenceCandidate('recur-yearly', text, start, anchored.end, { freq: 'yearly', interval: withInterval.interval }, env, startsOn)
    }
    return recurrenceCandidate('recur-yearly', text, start, withInterval.end, { freq: 'yearly', interval: withInterval.interval }, env)
  }

  // ② 每年[N]月[N]日（间隔 1）
  if (text.startsWith('每年', start)) {
    const anchored = readYearlyAnchor(text, start + 2)
    if (anchored.kind === 'out-of-range') return { end: anchored.end, token: null }
    if (anchored.kind === 'ok') {
      const startsOn = nextMonthDay(anchored.month, anchored.day, env.today)
      if (startsOn === null) return { end: anchored.end, token: null }
      return recurrenceCandidate('recur-yearly', text, start, anchored.end, { freq: 'yearly', interval: 1 }, env, startsOn)
    }
    // ③ 每年（间隔 1）
    return recurrenceCandidate('recur-yearly', text, start, start + 2, { freq: 'yearly', interval: 1 }, env)
  }

  return null
}

/**
 * `[N]月[N]日` 锚点的读取结果。**「没有锚点形状」与「有形状但值越界」必须分开**：
 *
 * - `none`：`每年3月`（锚点形状不完整）→ 退回 `每年`（部分识别，`3月` 留在标题）；
 * - `out-of-range`：`每年13月5日` → **整块认领、不出 token**，
 *   原文原样留在标题（§5.5 的「不识别」）。若此时退回 `每年`，
 *   用户会得到「重复 = 每年（从今天起）+ 标题里剩下 `13月5日`」，
 *   而 `13月5日` 还会被 `md-cn` 在同一趟扫描里认领——那既不是「不识别」也不是「部分识别」。
 */
type YearlyAnchor =
  | { readonly kind: 'none' }
  | { readonly kind: 'out-of-range'; readonly end: number }
  | { readonly kind: 'ok'; readonly month: number; readonly day: number; readonly end: number }

function readYearlyAnchor(text: string, from: number): YearlyAnchor {
  const month = readDigits(text, from, 2)
  if (month === null || charAt(text, month.end) !== '月') return { kind: 'none' }
  const day = readDigits(text, month.end + 1, 2)
  if (day === null || charAt(text, day.end) !== '日') return { kind: 'none' }
  const end = day.end + 1
  if (month.value < 1 || month.value > 12 || day.value < 1 || day.value > 31) {
    return { kind: 'out-of-range', end }
  }
  return { kind: 'ok', month: month.value, day: day.value, end }
}

/**
 * #12 `每[N]个月[N]号` / `每[N]月[N]号` / `每月[N]号` / `每[N]个月` / `每[N]月` / `每月`
 *
 * ⚠️ 表里只收 `号`，**不收 `每月[N]日`**（§3 的表逐字如此）：
 * `每月5日` 的最长匹配是 `每月`，`5日` 留在标题。这不是漏看，
 * 而是「未列出的写法一律不识别」的直接后果；已登记在实现报告里。
 */
const matchRecurMonthly: Matcher = (text, start, env) => {
  if (charAt(text, start) !== '每') return null

  // ① 每[N]个月[N]号 / ② 每[N]个月
  const withGe = readInterval(text, start, '个月')
  if (withGe !== null) {
    const day = readDigits(text, withGe.end, 2)
    if (day !== null && charAt(text, day.end) === '号') {
      return monthlyCandidate(text, start, day.end + 1, withGe.interval, day.value, env)
    }
    return monthlyCandidate(text, start, withGe.end, withGe.interval, null, env)
  }

  // ③ 每[N]月[N]号 / ⑤ 每[N]月
  const withMonth = readInterval(text, start, '月')
  if (withMonth !== null) {
    const day = readDigits(text, withMonth.end, 2)
    if (day !== null && charAt(text, day.end) === '号') {
      return monthlyCandidate(text, start, day.end + 1, withMonth.interval, day.value, env)
    }
    return monthlyCandidate(text, start, withMonth.end, withMonth.interval, null, env)
  }

  // ④ 每月[N]号 / ⑥ 每月
  if (text.startsWith('每月', start)) {
    const day = readDigits(text, start + 2, 2)
    if (day !== null && charAt(text, day.end) === '号') {
      return monthlyCandidate(text, start, day.end + 1, 1, day.value, env)
    }
    return monthlyCandidate(text, start, start + 2, 1, null, env)
  }

  return null
}

function monthlyCandidate(
  text: string,
  start: number,
  end: number,
  interval: number,
  monthDay: number | null,
  env: ScanEnv,
): Candidate {
  // `byMonthDay` 的合法域是 1…31（ADR-011 §2）：`每月32号` / `每月0号` 装不下。
  // 这里**不回退**到 `每月`——那等于把用户写下的日锚点悄悄换成「按 D₀ 的日号」。
  if (monthDay !== null && (monthDay < 1 || monthDay > 31)) return { end, token: null }
  const rule: RecurrenceRule =
    monthDay === null
      ? { freq: 'monthly', interval }
      : { freq: 'monthly', interval, byMonthDay: [monthDay] }
  return recurrenceCandidate('recur-monthly', text, start, end, rule, env)
}

/** #13 `每[N]周[D]` / `每周[D]` / `每[N]周` / `每周` */
const matchRecurWeekly: Matcher = (text, start, env) => {
  if (charAt(text, start) !== '每') return null

  // ① 每[N]周[D] / ③ 每[N]周
  const withInterval = readInterval(text, start, '周')
  if (withInterval !== null) {
    const target = readWeekdayChar(text, withInterval.end)
    if (target !== null) {
      const end = withInterval.end + 1
      return recurrenceCandidate('recur-weekly', text, start, end, { freq: 'weekly', interval: withInterval.interval, byDayOfWeek: [target] }, env)
    }
    return recurrenceCandidate('recur-weekly', text, start, withInterval.end, { freq: 'weekly', interval: withInterval.interval }, env)
  }

  // ② 每周[D] / ④ 每周
  if (text.startsWith('每周', start)) {
    const target = readWeekdayChar(text, start + 2)
    if (target !== null) {
      const end = start + 3
      return recurrenceCandidate('recur-weekly', text, start, end, { freq: 'weekly', interval: 1, byDayOfWeek: [target] }, env)
    }
    // §5.5：`每周八` → 起点 0 的最长匹配是 `每周`（`周` 后不是 `[D]`），`八` 留在标题。
    // **不把「每周」后的未知字当错误**：无法区分「每周八」是笔误还是「每周 八点开会」，
    // 而后者是**正确**的解析。
    return recurrenceCandidate('recur-weekly', text, start, start + 2, { freq: 'weekly', interval: 1 }, env)
  }

  return null
}

/** #14 `每[N]天` / `每[N]日` / `每天` / `每日` */
const matchRecurDaily: Matcher = (text, start, env) => {
  if (charAt(text, start) !== '每') return null

  for (const unit of ['天', '日']) {
    const withInterval = readInterval(text, start, unit)
    if (withInterval !== null) {
      return recurrenceCandidate('recur-daily', text, start, withInterval.end, { freq: 'daily', interval: withInterval.interval }, env)
    }
  }
  if (text.startsWith('每天', start)) {
    return recurrenceCandidate('recur-daily', text, start, start + 2, { freq: 'daily', interval: 1 }, env)
  }
  if (text.startsWith('每日', start)) {
    return recurrenceCandidate('recur-daily', text, start, start + 2, { freq: 'daily', interval: 1 }, env)
  }
  return null
}

// ────────────────────────── #15 期限：花括号 ──────────────────────────

/**
 * 花括号内允许的日期片段（§3 的 `due-brace` 行，**逐字**）：
 * `ymd-cn` / `md-cn` / `ymd` / `md-slash` / `md-dash` / `days-after` /
 * `week-prefixed` / `weekday` / `day-word`。
 *
 * **不含** `recur-*`、三个符号片段，也**不含** `week-prefix`（裸 `[P]周`）——
 * 后者是周级锚点，而 `dueDate` 是**单日**（§4.3 的粒度判据：系统没有「月」锚点，
 * 也没有「期限周」这一层）。故 `{每周三}`、`{下周}` 都整块不识别。
 * 顺序 = §3 的表序，故取「第一个恰好铺满花括号内部的片段」不依赖匹配顺序以外的性质。
 */
const BRACE_INNER_RULES: readonly Matcher[] = [
  matchYmdCn,
  matchMdCn,
  matchYmd,
  matchDaysAfter,
  matchWeekPrefixed,
  matchWeekday,
  matchDayWord,
  matchMdSlash,
  matchMdDash,
]

/**
 * #15 `{` + 日期片段 + `}` → **期限**（花括号是写期限的**唯一**途径，用户裁决 1）
 *
 * 三种结局，逐条对应 §5.4：
 * - 内部**恰好一个**日期片段且铺满 → `dueDate`，跨度**包含花括号本身**
 *   （故 `{` `}` 不残留在标题里）；
 * - 内部是别的东西（`{每周三}`、`{明天下午}`、`{ 明天 }`）→ **整块认领、不出 token**：
 *   「整块不识别、原样留标题」要求内层**不得**被独立解析，否则 `{明天下午}` 会变成
 *   「计划日 + `{下午}`」，那不是「原样」；
 * - `{` 未闭合 → 认领到串尾（同上，§5.4 的「全部不识别、原样留标题」）。
 */
const matchDueBrace: Matcher = (text, start, env) => {
  if (charAt(text, start) !== '{') return null
  const close = text.indexOf('}', start + 1)
  if (close === -1) return { end: text.length, token: null }

  for (const inner of BRACE_INNER_RULES) {
    const hit = inner(text, start + 1, env)
    if (hit === null || hit.end !== close) continue
    if (hit.token === null) return { end: close + 1, token: null }
    if (hit.token.kind !== 'date') continue
    const end = close + 1
    return {
      end,
      token: { ...tokenBase('due-brace', text, start, end), kind: 'dueDate', date: hit.token.date },
    }
  }
  return { end: close + 1, token: null }
}

// ────────────────────────── #16 优先级 ──────────────────────────

const IMPORTANCE_WORDS: Readonly<Record<string, 'low' | 'normal' | 'high'>> = {
  高: 'high',
  中: 'normal',
  低: 'low',
}

/**
 * #16 `!高` / `!中` / `!低`（`!` 亦可写作 `！`）
 *
 * **右边界**（空白 / 串尾 / 标点，不得是汉字或 ASCII 字母数字）是这条规则的全部误伤面控制：
 * `!高兴`（`高` 后接 `兴`）不识别、`!高写` 不识别；要误报必须写成 `……！高` 紧接空白/标点/串尾。
 * 全角 `！` 必须收：中文输入法下 `!` 常被自动转成全角，只认半角会让这个碎片**打不出来**。
 * 而 `!` / `!!` / `!!!`（以及全角）**一律不识别**——那是被否掉的计数式方案，
 * 把否掉的方案写成用例，以免下一个人「顺手支持一下 `!!`」。
 */
const matchPriority: Matcher = (text, start) => {
  const symbol = charAt(text, start)
  if (symbol !== '!' && symbol !== '！') return null
  if (!leftSymbolBoundary(text, start)) return null
  const word = charAt(text, start + 1)
  if (word === null) return null
  const importance = IMPORTANCE_WORDS[word]
  if (importance === undefined) return null
  const end = start + 2
  const next = charAt(text, end)
  if (next !== null && (HAN.test(next) || ASCII_ALNUM.test(next))) return null
  return { end, token: { ...tokenBase('priority', text, start, end), kind: 'importance', importance } }
}

// ────────────────────────── #17 / #18 符号 + 名字 ──────────────────────────

/** 「名字」的终止符（§3 的「名字」定义）：空白或下一个片段起始符 */
const NAME_TERMINATORS: readonly string[] = ['#', '＃', '@', '＠', '!', '！', '{']

/** 从符号之后取名字：到第一个空白或下一个片段起始符为止的**非空**连续文本 */
function readName(text: string, from: number): { name: string; end: number } {
  let i = from
  while (i < text.length) {
    const ch = charAt(text, i)
    if (ch === null || WHITESPACE.test(ch) || NAME_TERMINATORS.includes(ch)) break
    i += 1
  }
  return { name: text.slice(from, i), end: i }
}

/**
 * #17 `#` / `＃` + 名字 → 项目（按名字**精确匹配** `ctx.projects`）
 *
 * 「恰好一个」才算识别（§5.6）：0 个 → 不识别；**2 个及以上 → 也不识别**。
 * 这一条直接来自 ADR-016 §6 的裁决——**同名项目合法**，于是 `#实验` 在两个同名项目下
 * **真的没有唯一答案**，而本模块在歧义上只有一条纪律：**不猜**。
 * 不自动创建项目：`#新项目` 在项目不存在时不识别、留在标题（FR2.8 的项目必须有起止日期）。
 */
const matchProject: Matcher = (text, start, env) => {
  const symbol = charAt(text, start)
  if (symbol !== '#' && symbol !== '＃') return null
  if (!leftSymbolBoundary(text, start)) return null
  const { name, end } = readName(text, start + 1)
  // `# 实验` = 名字为空 → 不识别（这条 `#` 是普通字符，扫描前进一个字）
  if (name.length === 0) return null
  const hits = env.projects.filter((project) => project.name === name)
  if (hits.length !== 1) return { end, token: null }
  const project = hits[0]
  if (project === undefined) return { end, token: null }
  return {
    end,
    token: {
      ...tokenBase('project', text, start, end),
      kind: 'project',
      projectId: project.id,
      projectName: project.name,
    },
  }
}

/**
 * #18 `@` / `＠` + 名字 → 标签（**无实体，就是字符串**）
 *
 * 名字长于 50 字符**不识别**（ADR-017 §3 的上限；第 21 个及以后的计数在扫描层，
 * 见 `scan.ts`）。两条都以「不识别」而非「报错」处置：与其交一个**必被服务端拒绝**
 * 的载荷，不如让碎片留在标题里——失败模式可见、无副作用。
 */
const matchTag: Matcher = (text, start) => {
  const symbol = charAt(text, start)
  if (symbol !== '@' && symbol !== '＠') return null
  if (!leftSymbolBoundary(text, start)) return null
  const { name, end } = readName(text, start + 1)
  if (name.length === 0) return null
  if (name.length > MAX_TAG_NAME_LENGTH) return { end, token: null }
  return { end, token: { ...tokenBase('tag', text, start, end), kind: 'tag', tag: name } }
}

// ────────────────────────── 规则表（**表序 = §3 的序**） ──────────────────────────

export const RULES: readonly Rule[] = [
  { id: 'ymd-cn', match: matchYmdCn },
  { id: 'md-cn', match: matchMdCn },
  { id: 'ymd', match: matchYmd },
  { id: 'days-after', match: matchDaysAfter },
  { id: 'week-prefixed', match: matchWeekPrefixed },
  { id: 'week-prefix', match: matchWeekPrefix },
  { id: 'weekday', match: matchWeekday },
  { id: 'day-word', match: matchDayWord },
  { id: 'md-slash', match: matchMdSlash },
  { id: 'md-dash', match: matchMdDash },
  { id: 'recur-yearly', match: matchRecurYearly },
  { id: 'recur-monthly', match: matchRecurMonthly },
  { id: 'recur-weekly', match: matchRecurWeekly },
  { id: 'recur-daily', match: matchRecurDaily },
  { id: 'due-brace', match: matchDueBrace },
  { id: 'priority', match: matchPriority },
  { id: 'project', match: matchProject },
  { id: 'tag', match: matchTag },
]

/** 四族重复规则（§7 的 `recurrence` 落点）。**重新取用时走同一批匹配器，不写第二份** */
const RECURRENCE_RULES: readonly Rule[] = RULES.filter((rule) => rule.id.startsWith('recur-'))

/**
 * 在 `start` 处取**最长**匹配；跨度相同时取**表序小**者（§2 的决胜层）。
 *
 * 第二条是防御性的：逐族核对后本表现状不存在会撞出同长匹配的两条规则，
 * 但把「将来有人加进会冲突的规则时行为仍是确定的」写成规格而不是留给实现者，
 * 正是 §2 把它写进规格的理由。实现上 `>` 与 `>=` 之别就是这条规格。
 */
export function longestMatchAt(text: string, start: number, env: ScanEnv): Candidate | null {
  let best: Candidate | null = null
  for (const rule of RULES) {
    const hit = rule.match(text, start, env)
    if (hit === null) continue
    if (best === null || hit.end > best.end) best = hit
  }
  return best
}

/**
 * 只在重复族里取最长匹配——`resolveQuickAdd` 用它把 `startsOn` 按真正的 `D₀` 重算。
 *
 * 为什么可以重匹配：重匹配的是 `token.text`（一段**不可变的原文快照**），
 * 而不是「用户正在编辑的文本」——后者才是本模块禁止重匹配的理由
 * （文本一变坐标即失效，见 §2 与「为什么位置区间是必须的」）。
 * 且它走的是**同一张规则表的同一批匹配器**，不引入第二套匹配逻辑：
 * 相位原点（`startsOn`）依赖 `D₀`，而 `D₀` 只有采纳集定了才知道，
 * 故初值（以 `today` 为 `D₀`）必须在这里按 §7 重算一次。
 */
export function matchRecurrenceFragment(text: string, start: number, env: ScanEnv): Candidate | null {
  let best: Candidate | null = null
  for (const rule of RECURRENCE_RULES) {
    const hit = rule.match(text, start, env)
    if (hit === null) continue
    if (best === null || hit.end > best.end) best = hit
  }
  return best
}
