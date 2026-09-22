/**
 * 重复规则校验（ADR-011 §2「既然声称与 RRULE 直译，就必须遵守 RRULE 的语法约束」）。
 *
 * 本模块零依赖（03 §2），因此校验结果是**违规列表**而非 zod schema：
 * 服务端路由层把它映射成 ADR-008 的 `validation/invalid-input`。
 * 这样「规则合法性」只有一份定义，前端表单与后端路由都取用它。
 */
import { compareDayKey, isDayKey } from '@shared/time'

import { RecurrenceRuleError } from './types'
import type {
  NextAnchorMode,
  RecurrenceRule,
  RecurrenceTemplate,
  RuleViolation,
  RuleViolationCode,
} from './types'

const FREQS: readonly string[] = ['daily', 'weekly', 'monthly', 'yearly']
const ANCHOR_MODES: readonly string[] = ['extend', 'catch_up', 'recompute']

/** 命中日的名义日取值：1…31，或 -1（月末，永不夹取） */
const MONTH_DAY_MIN = 1
const MONTH_DAY_MAX = 31
const MONTH_DAY_LAST = -1

function violation(path: string, code: RuleViolationCode, message: string): RuleViolation {
  return { path, code, message }
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 校验规则本体。`startsOn` 参与两条判定（`until ≥ startsOn`、相位原点合法性），
 * 因此必须一并传入——ADR-011 §4 的推导以它为前提。
 *
 * 返回**全部**违规（不是首条）：一次把问题说完，前端表单一次标全字段。
 */
export function validateRule(rule: unknown, startsOn: unknown): RuleViolation[] {
  const violations: RuleViolation[] = []

  if (!isDayKey(startsOn as string)) {
    violations.push(
      violation('startsOn', 'invalid-starts-on', `必须是 'YYYY-MM-DD' 且真实存在的日历日，实得 '${String(startsOn)}'`),
    )
  }

  if (!isPlainObjectLike(rule)) {
    violations.push(violation('rule', 'not-an-object', '规则必须是对象'))
    return violations
  }

  const candidate = rule as Partial<RecurrenceRule>

  // —— freq
  if (typeof candidate.freq !== 'string' || !FREQS.includes(candidate.freq)) {
    violations.push(
      violation('rule.freq', 'invalid-freq', `只能是 ${FREQS.join(' / ')}，实得 '${String(candidate.freq)}'`),
    )
  }

  // —— interval ≥ 1
  if (!Number.isSafeInteger(candidate.interval) || (candidate.interval as number) < 1) {
    violations.push(
      violation('rule.interval', 'invalid-interval', `必须是 ≥ 1 的整数，实得 ${String(candidate.interval)}`),
    )
  }

  // —— count 与 until 互斥（RFC 5545：二者 MUST NOT 同时出现）
  const hasCount = candidate.count !== undefined
  const hasUntil = candidate.until !== undefined
  if (hasCount && hasUntil) {
    violations.push(
      violation(
        'rule.count',
        'count-until-exclusive',
        'RRULE 规定 COUNT 与 UNTIL 不得并存（ADR-011 §2）；二者只能给一个',
      ),
    )
  }

  if (hasCount && (!Number.isSafeInteger(candidate.count) || (candidate.count as number) < 1)) {
    violations.push(
      violation('rule.count', 'invalid-count', `必须是 ≥ 1 的整数，实得 ${String(candidate.count)}`),
    )
  }

  if (hasUntil) {
    if (!isDayKey(candidate.until as string)) {
      violations.push(
        violation('rule.until', 'invalid-until', `必须是 'YYYY-MM-DD' 且真实存在的日历日，实得 '${String(candidate.until)}'`),
      )
    } else if (isDayKey(startsOn as string) && compareDayKey(candidate.until as string, startsOn as string) < 0) {
      violations.push(
        violation('rule.until', 'until-before-starts-on', `不得早于 starts_on（'${String(startsOn)}'），实得 '${String(candidate.until)}'`),
      )
    }
  }

  // —— byDayOfWeek：0=周一 … 6=周日，仅 weekly 使用
  if (candidate.byDayOfWeek !== undefined) {
    if (!Array.isArray(candidate.byDayOfWeek) || candidate.byDayOfWeek.length === 0) {
      violations.push(
        violation('rule.byDayOfWeek', 'invalid-by-day-of-week', '必须是非空数组（0=周一 … 6=周日）'),
      )
    } else {
      candidate.byDayOfWeek.forEach((value, index) => {
        if (!Number.isInteger(value) || value < 0 || value > 6) {
          violations.push(
            violation('rule.byDayOfWeek[' + index + ']', 'invalid-by-day-of-week', `必须是 0…6 的整数，实得 ${String(value)}`),
          )
        }
      })
    }
    if (candidate.freq !== 'weekly') {
      violations.push(
        violation('rule.byDayOfWeek', 'by-part-not-allowed-for-freq', '仅 weekly 使用（ADR-011 §2）；静默忽略会导出成错误的 RRULE'),
      )
    }
  }

  // —— byMonthDay：1…31 或 -1，仅 monthly 使用
  if (candidate.byMonthDay !== undefined) {
    if (!Array.isArray(candidate.byMonthDay) || candidate.byMonthDay.length === 0) {
      violations.push(
        violation('rule.byMonthDay', 'invalid-by-month-day', '必须是非空数组（1…31，或 -1 表示月末）'),
      )
    } else {
      candidate.byMonthDay.forEach((value, index) => {
        const ok =
          Number.isInteger(value) && (value === MONTH_DAY_LAST || (value >= MONTH_DAY_MIN && value <= MONTH_DAY_MAX))
        if (!ok) {
          violations.push(
            violation(
              'rule.byMonthDay[' + index + ']',
              'invalid-by-month-day',
              `必须是 1…31 或 -1（月末），实得 ${String(value)}`,
            ),
          )
        }
      })
    }
    if (candidate.freq !== 'monthly') {
      violations.push(
        violation('rule.byMonthDay', 'by-part-not-allowed-for-freq', '仅 monthly 使用（ADR-011 §2）'),
      )
    }
  }

  return violations
}

/**
 * 校验锚点模式（ADR-011 §1 / §5）。
 *
 * 由 `validateTemplate` 与 `nextAnchorDate` **共用一份判定**：后者在运行时也要挡——
 * 它的 `mode` 参数是 `NextAnchorMode`，但 JS 调用方（或 `as never` 的探针）能传进任意值，
 * 那样 `switch` 会**静默落到函数末尾返回 `undefined`**，与「抛错而非静默」（§4 规则 4、
 * §4.1）的纪律相反。§4.1 把它归入「用户输入错误」→ 400。
 */
export function validateAnchorMode(mode: unknown): RuleViolation[] {
  if (typeof mode !== 'string' || !ANCHOR_MODES.includes(mode)) {
    return [
      violation(
        'template.nextAnchorMode',
        'invalid-anchor-mode',
        `只能是 ${ANCHOR_MODES.join(' / ')}，实得 '${String(mode)}'`,
      ),
    ]
  }
  return []
}

/**
 * 校验模板（含 `startsOn`、`nextAnchorMode`）。
 *
 * `accountId` / `createdAt` / `updatedAt`（ADR-011 §4）**有意不校验**：它们不是客户端
 * 输入，而是服务端从会话与时钟填的列，把它们混进「用户填错了」的违规列表只会误导前端。
 */
export function validateTemplate(template: unknown): RuleViolation[] {
  if (!isPlainObjectLike(template)) {
    return [violation('template', 'not-an-object', '模板必须是对象')]
  }
  const candidate = template as Partial<RecurrenceTemplate>
  const violations: RuleViolation[] = []

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    violations.push(violation('template.id', 'invalid-template-id', '必须是非空字符串（UUIDv7）'))
  }

  violations.push(...validateAnchorMode(candidate.nextAnchorMode))

  return [...violations, ...validateRule(candidate.rule, candidate.startsOn)]
}

/** 校验规则，不合法即抛 `RecurrenceRuleError`（载荷带全部违规）。 */
export function assertValidRule(rule: unknown, startsOn: unknown): asserts rule is RecurrenceRule {
  const violations = validateRule(rule, startsOn)
  if (violations.length > 0) throw new RecurrenceRuleError(violations)
}

/** 校验模板，不合法即抛 `RecurrenceRuleError`。 */
export function assertValidTemplate(template: unknown): asserts template is RecurrenceTemplate {
  const violations = validateTemplate(template)
  if (violations.length > 0) throw new RecurrenceRuleError(violations)
}

/**
 * 归一化规则：`byDayOfWeek` / `byMonthDay` 去重并升序。
 *
 * 为什么**静默去重而不是报违规**：RFC 5545 的 `BY*` 列表允许重复，重复项对
 * 「日期集合」没有语义贡献（同一个日期不会成为两个实例——实例键的日期部分是主键，
 * ADR-011 §4），报错只会让界面多一条无意义的红线。排序则是**必须**的：
 * 命中集合的升序生成依赖它（`byDayOfWeek: [4, 0]` 与 `[0, 4]` 必须同解）。
 */
export function normalizeRule(rule: RecurrenceRule): RecurrenceRule {
  const normalized: RecurrenceRule = { freq: rule.freq, interval: rule.interval }
  if (rule.byDayOfWeek !== undefined) normalized.byDayOfWeek = sortedUnique(rule.byDayOfWeek)
  if (rule.byMonthDay !== undefined) normalized.byMonthDay = sortedUnique(rule.byMonthDay)
  if (rule.count !== undefined) normalized.count = rule.count
  if (rule.until !== undefined) normalized.until = rule.until
  return normalized
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}
