/**
 * 测试夹具（**不是模块的一部分**，故不参与 `discipline.test.ts` 的静态扫描）。
 *
 * 「现在」必须显式传入（ADR-009 §3）：这里把 DayKey + 小时拼成一个带 `+08:00` 偏移的
 * 瞬间，于是 `today(Asia/Shanghai, now)` 恰好等于给定的那个 DayKey——
 * **测试里的「今天」是构造出来的，不是读时钟读来的**。
 */
import type { DayKey } from '@shared/time'

import { resolveQuickAdd } from './resolve'
import { parseQuickAdd } from './scan'
import type {
  ProjectRef,
  QuickAddContext,
  QuickAddParse,
  QuickAddResult,
  QuickAddToken,
  RecurrenceSpec,
} from './types'

/** 账号设置包成的时区口径（ADR-009 §2）：上海 + 凌晨 4 点切日 */
export const TIME_CONTEXT = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }

/** ADR-014 §后果的测试矩阵统一用这一天（周二） */
export const TODAY = '2026-09-22'

export function ctxOn(
  dayKey: DayKey = TODAY,
  options: { readonly projects?: readonly ProjectRef[]; readonly hour?: number } = {},
): QuickAddContext {
  const hour = options.hour ?? 12
  return {
    now: new Date(`${dayKey}T${String(hour).padStart(2, '0')}:00:00+08:00`),
    timeContext: TIME_CONTEXT,
    projects: options.projects ?? [],
  }
}

export function parseOn(
  text: string,
  dayKey: DayKey = TODAY,
  projects: readonly ProjectRef[] = [],
): QuickAddParse {
  return parseQuickAdd(text, ctxOn(dayKey, { projects }))
}

export function resolveOn(
  text: string,
  dayKey: DayKey = TODAY,
  projects: readonly ProjectRef[] = [],
  suppressed: readonly number[] = [],
): QuickAddResult {
  return resolveQuickAdd(parseOn(text, dayKey, projects), suppressed)
}

/** 项目夹具：`id` 可指定，便于断言「同名两个」这类情形 */
export function project(name: string, id = `id-${name}`): ProjectRef {
  return { id, name }
}

/** 取唯一的重复碎片（没有则 `null`），供「重复 → 规则」一类的断言使用 */
export function recurrenceOf(
  text: string,
  dayKey: DayKey = TODAY,
  projects: readonly ProjectRef[] = [],
): RecurrenceSpec | null {
  return resolveOn(text, dayKey, projects).recurrence
}

/** `parse.tokens` 里某个 pattern 的碎片（没有则 `undefined`） */
export function tokenOf(parse: QuickAddParse, pattern: QuickAddToken['pattern']): QuickAddToken | undefined {
  return parse.tokens.find((token) => token.pattern === pattern)
}
