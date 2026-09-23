/**
 * 重复任务推导 —— 纯函数模块（ADR-011）。
 *
 * 位置：`shared/` 而不是 `server/` 或 `src/`。理由同 ADR-009：服务端要在事件写入时
 * 算三锚点（ADR-007 §5），前端要推导「今日待办」（ADR-011 §4），两边若各写一份
 * 就是两个真相。`shared/` 是「唯一一份」这条纪律的物理形态。
 *
 * 零依赖、纯函数：不读时钟（`today` 显式传入）、不读库、不写库。日期运算一律经
 * `@shared/time`（ADR-009），本模块**不自写任何日期折算**——月 / 年算术的接缝在
 * `./calendar`，那里也是唯一说明当前阻塞点的地方。
 */
/** 本模块的公开签名里到处是 `DayKey`，故顺手转出（它仍只有 `shared/time` 一份定义） */
export type { DayKey } from '@shared/time'

export {
  AnchorInvariantError,
  DEFAULT_NEXT_ANCHOR_MODE,
  ProgressionLimitError,
  RecurrenceRuleError,
} from './types'
export type {
  Freq,
  NextAnchorMode,
  RecurrenceRule,
  RecurrenceTemplate,
  Round,
  RoundCompletion,
  RuleViolation,
  RuleViolationCode,
} from './types'

export { assertValidRule, assertValidTemplate, normalizeRule, validateRule, validateTemplate } from './rule'

export { MAX_PROGRESSION_ITERATIONS, hitSequence, hitsBetween } from './hits'

export { addOneInterval, nextAnchorDate, shouldPromptOverdue } from './anchors'
export type { AnchorInput } from './anchors'

export { deriveRounds } from './derive'
