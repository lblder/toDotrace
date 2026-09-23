/**
 * 快速录入的类型契约 —— ADR-014 §1 / §6。
 *
 * 位置：`shared/` 而不是 `src/` 或 `server/`。理由与 ADR-009 / ADR-011 / ADR-013 同：
 * 解析要被前端（预览）与任何将来的调用方共用，**两处解析就是两个真相**（§8），
 * 而「预览说了什么、存的就是什么」才是预览存在的意义。
 *
 * 零依赖、纯函数：不读时钟（`now` 显式传入，ADR-009 §3）、不读全局状态、不写存储。
 * **运行时导入白名单 = `@shared/time`**（§8）；**类型导入不限**（§1 的注），
 * 故此处从 `@shared/tasks/types` 取 `Importance` / `RecurrenceSpec`——
 * 它们是 ADR-013 §1 / §3 定义的**唯一一份**，本模块**不得就地再写一份字面量联合**
 * （§后果：「`Importance` 与 `DEFAULT_NEXT_ANCHOR_MODE` 各自只能有一处声明」）。
 */
import type { DayKey, TimeContext } from '@shared/time'
import type { Importance, RecurrenceSpec } from '@shared/tasks/types'

/** 项目的读取形态（实体定义见 ADR-016；本模块只用到 `id` 与 `name`） */
export interface ProjectRef {
  readonly id: string
  readonly name: string
}

export interface QuickAddContext {
  /** 「现在」。**必须显式传入**——本模块不读系统时钟（ADR-009 §3「理由」） */
  readonly now: Date
  /** 账号设置包成的时区口径（ADR-009 §2） */
  readonly timeContext: TimeContext
  /**
   * 本账号**未删除**的项目（ADR-016 §6 的项目是软删除）。
   * **空数组 ⇒ `#` 片段一律不识别**，不报错。
   * 「未删除」不是修饰语：把已删除的项目放进来，`#实验` 会解析成一个服务端
   * 归属校验必然拒绝的 `projectId`，用户看到的是一个 400（ADR-016 §10 第 2 条）。
   */
  readonly projects: readonly ProjectRef[]
}

/**
 * 规则表的行标识（ADR-014 §3 表的 id 列，逐字）。
 *
 * 是**字面量联合**：规则表以它为键，漏一条编译不过（§1）。
 */
export type PatternId =
  | 'ymd-cn'
  | 'md-cn'
  | 'ymd'
  | 'days-after'
  | 'week-prefixed'
  | 'week-prefix'
  | 'weekday'
  | 'day-word'
  | 'md-slash'
  | 'md-dash'
  | 'recur-yearly'
  | 'recur-monthly'
  | 'recur-weekly'
  | 'recur-daily'
  | 'due-brace'
  | 'priority'
  | 'project'
  | 'tag'

/**
 * 位置区间是**必须的，不是便利**（§6 的四条硬性约定之二）：
 * 三层逃生舱里的两层靠它——层②要 `escapeOffsets` 才能把 `\` 从标题里去掉，
 * 层③（`×` 取消）就是「按偏移从采纳集里去掉一个 token」。
 * 没有区间，取消与转义都只剩「重新按文本匹配一次」这条路，
 * 而那会引入第二套匹配逻辑（也就是第二个真相）。
 */
export interface TokenBase {
  /** §3 表的 id，用于测试与文案 */
  readonly pattern: PatternId
  /** 原文下标，**闭** */
  readonly start: number
  /** 原文下标，**开**；跨度 = `[start, end)`。**UTF-16 码元下标**，与 `String.prototype.slice` 对齐 */
  readonly end: number
  /** 原文片段，逐字（预览的括号里显示它） */
  readonly text: string
}

export type QuickAddToken =
  | (TokenBase & { kind: 'date'; date: DayKey })
  /**
   * `[P]周`（不带星期几）→ 周级锚点，值为该周周一（§4.3 的粒度判据）。
   * **它是 §3 片段表 #6 的落点**，与 `kind:'date'`（片段 #5/#7 等）互不重叠——
   * 最长匹配保证 `下周三` 先被片段 #5 收下，落 `date`。
   */
  | (TokenBase & { kind: 'plannedWeek'; weekStart: DayKey })
  | (TokenBase & { kind: 'dueDate'; date: DayKey })
  | (TokenBase & { kind: 'importance'; importance: Importance })
  | (TokenBase & { kind: 'tag'; tag: string })
  | (TokenBase & { kind: 'project'; projectId: string; projectName: string })
  | (TokenBase & { kind: 'recurrence'; recurrence: RecurrenceSpec })

export interface QuickAddParse {
  readonly text: string
  /** 本次解析使用的「今天」，由 `today(timeContext, now)` 派生并随结果固化 */
  readonly today: DayKey
  /** **全部**识别结果，升序、互不重叠；含互相冲突的（取舍在阶段 2） */
  readonly tokens: readonly QuickAddToken[]
  /** 需从标题中移除的反斜杠的偏移（阶段 1 的转义层），升序 */
  readonly escapeOffsets: readonly number[]
  /** 整串引号层是否命中；命中时 `tokens` 为空、`escapeOffsets` 为空 */
  readonly quoted: boolean
}

export interface QuickAddResult {
  readonly today: DayKey
  readonly title: string
  readonly plannedDate: DayKey | null
  /**
   * 周级锚点，**规范化存该周周一**（ADR-016 §1）。
   * 由 `[P]周`（不带星期几）系列碎片产出，见 §4.3 的**粒度判据**。
   * 与 `plannedDate` **永不同时非空**（ADR-013 §5 的 CHECK 兜底）。
   */
  readonly plannedWeek: DayKey | null
  readonly dueDate: DayKey | null
  /** `null` = 用户没写优先级（**不**用 `'normal'` 兜底，见 §6「为什么 importance 可空」） */
  readonly importance: Importance | null
  readonly tags: readonly string[]
  readonly projectId: string | null
  readonly recurrence: RecurrenceSpec | null
  /** 被采纳的碎片（预览里显示为可取消的碎片） */
  readonly adopted: readonly QuickAddToken[]
  /** 未被采纳的碎片（冲突落选或被 `×` 取消）；**它们的原文仍在 `title` 里** */
  readonly released: readonly QuickAddToken[]
}

/**
 * §6 的三条上限（来自 ADR-017 §3）。越界的后果是 `400`，
 * 而 `400` 是**用户看不出原因**的失败，故本模块**前置拦截**。
 */
/** `title` 上限：超长**不截断**（截断是伪造），由 `canSubmit` 拦下 */
export const MAX_TITLE_LENGTH = 500
/** `tags` 个数上限：第 21 个及以后**不识别**（退回标题） */
export const MAX_TAGS = 20
/** 单个标签名长度上限：超长**不识别** */
export const MAX_TAG_NAME_LENGTH = 50

export type { Importance, RecurrenceSpec }
