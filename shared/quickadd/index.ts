/**
 * 快速录入解析 —— 公开接口（ADR-014 §1）。
 *
 * ```
 * 阶段 0  整串引号        text 首尾同为 " 且 length ≥ 2 → 剥引号、quoted=true、结束
 * 阶段 1  转义 + 扫描     左到右，每点取「最长匹配」，产出全部 token + escapeOffsets
 * 阶段 2  取舍 + 落点     按「同字段后到者胜」定采纳集，拼标题、定七个字段值
 * ```
 *
 * 零依赖纯函数，两端共用（`shared/` 是「唯一一份」这条纪律的物理形态）。
 * **运行时导入白名单 = `@shared/time`**（§8）；类型导入不限。
 *
 * 三条容易被做错、因此写在这里的口径：
 *
 * - **`kind` 与落点由 §6 那张表唯一决定**，两列并排（非重复任务 / 重复任务）。
 *   重复任务上 `date` → `startsOn` 的相位输入、`plannedWeek` 与 `dueDate` → 退回标题；
 * - **无法解析的文本一律留在标题**（FR2.3 / 用户裁决 4）。本模块的失败模式**只有**
 *   「不识别」：不报错、不猜测、不夹取、不自动创建实体；
 * - **不存在的日历日不识别、绝不夹取**（`2月30日` 退回标题）。夹取在**重复规则**里是
 *   口径（ADR-011 §3 的用户裁决），在**用户手写的具体日期**里是伪造——两者不可混同。
 */
import { formatDayKey, formatWeek, parseDayKey } from '@shared/time'
import type { DayKey } from '@shared/time'

import { MAX_TITLE_LENGTH } from './types'
import type { QuickAddResult } from './types'

export { parseQuickAdd, scanTokens } from './scan'
export { resolveQuickAdd } from './resolve'
export { MAX_TAG_NAME_LENGTH, MAX_TAGS, MAX_TITLE_LENGTH } from './types'
export type {
  Importance,
  PatternId,
  ProjectRef,
  QuickAddContext,
  QuickAddParse,
  QuickAddResult,
  QuickAddToken,
  RecurrenceSpec,
  TokenBase,
} from './types'

/**
 * 预览用的日期呈现：**年份与 `today` 同年用短式，否则用长式**。
 * 内部**只调 `formatDayKey`**（ADR-009 §6：不得在组件里各自拼日期字符串）。
 *
 * 注意它**不含**「(明天)」「(周五)」这类相对词——那是调用方的措辞，
 * 本函数的输出必须与 `formatWeek` 一样是**确定的**（不随宿主 locale 变化）。
 */
export function describeDay(dk: DayKey, today: DayKey): string {
  const sameYear = parseDayKey(dk).year === parseDayKey(today).year
  return formatDayKey(dk, sameYear ? 'short' : 'long')
}

/**
 * 预览用的**周**呈现（`计划周 9月28日那一周`）。内部**只调 `formatWeek`**（ADR-009 §10）。
 *
 * **必须与 `describeDay` 分开**：周级锚点若显示成「计划日 9月28日(周一)」，
 * 就是**用一个错的粒度**回答用户的输入（§4.3）——比不显示更糟。
 * 故两者**不可互相代用**。
 */
export function describeWeek(dk: DayKey): string {
  return formatWeek(dk)
}

/**
 * 提交前置条件，两条：标题非空（ADR-013 §6「`title` 不得为空串」）
 * 且长度 ≤ 500 字符（ADR-017 §3 的上限）。UI 据此禁用提交。
 *
 * 判据放这里而不是散在组件里：服务端会以 `400` 拒绝，
 * 而 `400` 是用户看不出原因的失败。**超长不截断**（截断是伪造），只拦下并提示。
 */
export function canSubmit(result: QuickAddResult): boolean {
  return result.title.length > 0 && result.title.length <= MAX_TITLE_LENGTH
}
