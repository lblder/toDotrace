/**
 * 重复任务模板与实例语义 —— 类型契约（ADR-011 §2 / §4 / §6）。
 *
 * 与 ADR-011 的对应关系：
 * - §2 规则词汇对齐 RFC 5545 的 `RRULE`，导出即直译（架构文档 §7 → 阶段 5）；
 * - §4 实例键 =（模板标识 + 原计划日期），`Round` 就是它的读取形态；
 * - §6 完成事件固化 `nextAnchorDate` / `nextAnchorMode`，见 `RoundCompletion`。
 *
 * 命名：ADR 的 SQL 列是 snake_case（`rule_json` / `starts_on` / `next_anchor_mode`），
 * TS 层一律 camelCase，与 ADR-011 既有的 `byMonthDay` / `originalPlannedDate` 一致。
 */
import type { DayKey } from '@shared/time'

/** ADR-011 §2：`freq` 与 RFC 5545 的 `FREQ` 同一套词汇 */
export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** ADR-011 §1 / §5：下一轮锚点三选一 */
export type NextAnchorMode = 'extend' | 'catch_up' | 'recompute'

/**
 * ADR-011 §2 的重复规则。
 *
 * 语法约束（§2「既然声称与 RRULE 直译，就必须遵守 RRULE 的语法约束」）：
 * - `interval ≥ 1`；
 * - `count` 与 `until` **互斥**（RFC 5545 规定二者 MUST NOT 同时出现）；
 * - `byMonthDay` 取值 `1…31` 或 `-1`（`-1` = 月末）；
 * - `byDayOfWeek` 取值 `0`（周一）… `6`（周日），仅 `weekly` 使用；
 * - `byMonthDay` 仅 `monthly` 使用；`yearly` 无 `BY*` 时命中日 = `startsOn` 的月日。
 */
export interface RecurrenceRule {
  freq: Freq
  /** ≥ 1，以 `freq` 为单位 */
  interval: number
  /** 0 = 周一 … 6 = 周日；仅 weekly 使用（ADR-011 §2） */
  byDayOfWeek?: readonly number[]
  /** 1…31，或 -1 表示「月末」；仅 monthly 使用（ADR-011 §2 / §3） */
  byMonthDay?: readonly number[]
  /** 总轮数上限（≥ 1）；与 `until` 互斥 */
  count?: number
  /** 截止日（含）；与 `count` 互斥 */
  until?: DayKey
}

/** ADR-011 §4 的 `RecurrenceTemplate`（`recurrence_templates` 行的 TS 形态） */
export interface RecurrenceTemplate {
  /** UUIDv7；实例键的一半 */
  id: string
  accountId: string
  title: string
  rule: RecurrenceRule
  nextAnchorMode: NextAnchorMode
  /** 首轮的「原计划日期」起点，同时是命中集合的**相位原点**（ADR-011 §1 / §3 / §5） */
  startsOn: DayKey
  createdAt: string
  updatedAt: string
}

/**
 * ADR-011 §4 / §6 的 `recurrence/round-completed` 事件载荷。
 *
 * 两条固化值（ADR-007 §4）：
 * - `originalPlannedDate` —— 本轮实例键的后半（前半是 `templateId`）；
 * - `nextAnchorDate` —— 完成时刻按锚点模式算出的下一轮日期，FR2.5 逾期提示的直接来源。
 *
 * `nextAnchorDate` 为 `null` 表示**规则已终止**（达到 `count` 或越过 `until`），
 * 不存在下一轮，此时 FR2.5 的「下一轮 X 日」提示不出现——**不得填越界日期充数**（§4）。
 */
export interface RoundCompletion {
  /**
   * 归属账号——**账号隔离的结构性防线**（主控 2026-09-22 裁决，取代「登记一条调用方义务」）。
   *
   * 为什么必须有：§1 的模板表主键是 `(account_id, id)`，**模板 id 只在账号内唯一**——
   * ADR-005 明确允许「B 导入 A 导出的同一份文件」，此时两个账号各持一份**同 id** 的模板副本。
   * `deriveRounds` 若只按 `templateId` 过滤，账号 B 的完成记录会被算进账号 A 的轮次里，
   * **且不报错**——这正是 02 §3.2 的逐资源所有权校验要防的失败模式（账号隔离被破坏）。
   *
   * 故一致性做成**结构**而不是**约定**：账号随完成记录一起流到推导里，
   * 由 `deriveRounds` 按 `completion.accountId === template.accountId` 过滤
   * （与 ADR-010 §2 把 `target` 做成派生式同思路）。账号可从事件行自身的
   * `account_id` 列取（ADR-010 §1），不必进 §6 的载荷。
   */
  accountId: string
  templateId: string
  /** 实例键的**日期分量** */
  originalPlannedDate: DayKey
  completedDayKey: DayKey
  nextAnchorDate: DayKey | null
  nextAnchorMode: NextAnchorMode
  /**
   * ADR-001 §2 的排序键。「最近一次完成」按它判定（§4）——**不是**按 `completedDayKey`、
   * 更不是按数组顺序：跨设备合并与导入之后，「按事件 id 序」与「按完成日序」会给出不同答案，
   * 只有前者与 ADR-001 的重放排序一致，因而跨设备可复现。
   *
   * ⚠️ 判定用的是**字符串比较**，故依赖 ADR-001「约束」节的那条性质：
   * 标识形态可直接排序（规范 UUIDv7、小写、**定长 36**）⇒ 字典序 === 时间序。
   * 形态若改变，比较会**静默反向**且不报错（该性质由生成器一侧的测试固化）。
   */
  eventId: string
}

/**
 * 一个轮次（ADR-011 §4）。
 *
 * **实例键 =（`templateId` + `originalPlannedDate`）**，与 iCalendar 的
 * `RECURRENCE-ID` 同构（ADR-007 §2 / 架构文档 §7）。
 *
 * 已完成轮次来自完成事件（原样返回、永不重算）；待完成轮次由本模块推导，
 * 每个模板**至多一条**（ADR-011 §4「为什么至多一个待完成轮次」）。
 *
 * 字段就是 §4 冻结的那五个，不加不减——它是阶段 4 的读取契约。
 */
export interface Round {
  templateId: string
  originalPlannedDate: DayKey
  status: 'pending' | 'completed'
  /** 仅 `completed` 时存在 */
  completedDayKey?: DayKey
  /**
   * **取自模板当前值，非快照**（§4「这是一处有意选择，不是遗漏」）。
   *
   * 于是改标题后**已完成的轮次也显示新标题**——轮次从属于模板，把「晨跑」改名成
   * 「晨间跑步」后历史轮次显示新名字符合直觉；反之冻结历史标题会让同一模板下新旧名字并存。
   *
   * **代价**（§4 已登记）：阶段 6 若需要「按当时的标题展示」（周报里还原历史用词），
   * `Round` 与 `RoundCompletion` 都取不到——那时必须在完成事件载荷里加快照，
   * 且只对加字段之后新产生的完成生效。
   */
  title: string
}

/** 规则校验的一处违规。服务端据此产出 ADR-008 的 `validation/invalid-input`。 */
export interface RuleViolation {
  /** 出问题的字段路径，如 `rule.byMonthDay[1]` */
  path: string
  /** 机器可判定的违规码 */
  code: RuleViolationCode
  message: string
}

export type RuleViolationCode =
  | 'not-an-object'
  | 'invalid-freq'
  | 'invalid-interval'
  | 'count-until-exclusive'
  | 'invalid-count'
  | 'invalid-until'
  | 'until-before-starts-on'
  | 'invalid-by-day-of-week'
  | 'invalid-by-month-day'
  | 'by-part-not-allowed-for-freq'
  | 'invalid-starts-on'
  | 'invalid-anchor-mode'
  | 'invalid-template-id'

/**
 * 下面是 §4.1 登记的**域错误**（三个，不多不少）。
 *
 * **编程错误不在此列、也不入 §4.1 的表**（§4.1 有显式声明）：调用方传了非法的 `today`
 * 抛内建 `RangeError`（见 `derive.ts`）、漏填必填字段抛内建 `TypeError`（见 `derive.ts`
 * 的 accountId 守卫）。它们**不该被服务端映射成 HTTP 状态码**，而应当直接暴露为缺陷——
 * 把编程错误登记成域错误会诱导调用方去 `catch`，那是把 bug 静默化。
 */

/**
 * 规则违反 ADR-011 §2 的语法约束。
 *
 * 本模块零依赖（03 §2），因此不引 zod：校验以**违规列表**的形式返回，
 * 由服务端路由层映射进 zod / ADR-008 的错误码——而不是让 `shared/` 依赖服务端框架。
 *
 * §4.1 登记：属**用户输入错误**，阶段 3 应映射为 `400 validation/invalid-input` 一类。
 */
export class RecurrenceRuleError extends Error {
  override readonly name = 'RecurrenceRuleError'
  readonly code = 'recurrence/invalid-rule'
  readonly violations: readonly RuleViolation[]

  constructor(violations: readonly RuleViolation[]) {
    super(
      `重复规则不合法（${violations.length} 处）：` +
        violations.map((violation) => `${violation.path} ${violation.message}`).join('；'),
    )
    this.violations = violations
  }
}

/**
 * 单次推导的迭代次数超过上限（ADR-011 §4 规则 4：10000 次）。
 *
 * **不静默截断**——截断会得到一个看起来正常但错误的日期，比抛错危险得多（§4 理由）。
 *
 * §4.1 登记：属**不变量被破坏**（正常输入不该触发，只可能是起点过早或日期数据异常），
 * 阶段 3 应映射为 `500` 并记录，**不得吞掉**。
 */
export class ProgressionLimitError extends Error {
  override readonly name = 'ProgressionLimitError'
  readonly code = 'recurrence/progression-limit'
  readonly startsOn: DayKey
  readonly limit: number

  constructor(startsOn: DayKey, limit: number) {
    super(
      `重复规则推导迭代超过 ${limit} 次上限（starts_on = '${startsOn}'）：` +
        '规则起点过早或日期数据异常。按 ADR-011 §4 规则 4 抛错，不截断。',
    )
    this.startsOn = startsOn
    this.limit = limit
  }
}

/**
 * 完成事件里固化的锚点不满足 ADR-011 §5 的**锚点不变式**。
 *
 * > `nextAnchorDate` 恒为一个「尚不存在」的轮次，即**严格晚于**本轮的原计划日期 `P`。
 *
 * 三锚点都保证它：①② 由「取 > 起点 的第一个命中日」天然成立；③ 的候选 `T + 间隔` 在
 * 提前完成（`T < P`）时可能落到 `≤ P`，故 `anchors.ts` 的 `recompute` 分支对此有显式守卫。
 *
 * 不成立即说明**固化值被写坏**（典型来源正是 §5 点名的那类标量加减缺陷，`P + I` 算出
 * `2026-02-31`），或上游把一个撞键的锚点写进了事件。因此 §4.1 把它登记为
 * **服务端不变量被破坏**：阶段 3 应映射为 `500` 并记录，**不得吞掉**。
 */
export class AnchorInvariantError extends Error {
  override readonly name = 'AnchorInvariantError'
  readonly code = 'recurrence/anchor-invariant'
  readonly originalPlannedDate: DayKey
  readonly nextAnchorDate: DayKey | null

  constructor(originalPlannedDate: DayKey, nextAnchorDate: DayKey | null) {
    super(
      `完成事件固化的下一轮锚点 '${String(nextAnchorDate)}' 不晚于本轮原计划日期 ` +
        `'${originalPlannedDate}'：锚点必须严格前进（ADR-011 §5）。`,
    )
    this.originalPlannedDate = originalPlannedDate
    this.nextAnchorDate = nextAnchorDate
  }
}
