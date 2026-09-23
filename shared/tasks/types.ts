/**
 * 任务域与读模型的**类型唯一落点**（ADR-013 §1 / ADR-015 §1 / §5）。
 *
 * 为什么集中在一处：ADR-013 §3 明令「`RecurrenceSpec` 只能有一份定义，其它模块一律导入」——
 * 两处各写一份的后果很具体：字段一旦不同步，解析器的输出会被服务端载荷 schema 拒绝，
 * 症状是「预览显示解析成功、提交却 400」，用户看不出原因。同一理由适用于本文件全部类型。
 *
 * 依赖方向：本文件只 import `@shared/time` 与 `@shared/recurrence` 的**类型**，
 * **不得** import `server/`（阶段 4 复核实测：`Event<P>` 是服务端类型，
 * 故 ADR-015 §2 把 `eventToCompletion` 的入参收窄成结构化参数）。
 */
import type { DayKey } from '@shared/time'
import type { NextAnchorMode, RecurrenceRule } from '@shared/recurrence'

// ─────────────────────── ADR-013 §1：实体 ───────────────────────

/** FR2.1 的重要性（星标 = 高） */
export type Importance = 'low' | 'normal' | 'high'

/**
 * 任务级**意图态**（ADR-013 §2 的第一层）。
 *
 * ⚠️ 这里**没有 `completed`**——「已完成」是**实例**的属性，由完成事件固化
 * （ADR-013 §2 的核心决定）。加一个 `completed` 进来就会让每一轮完成都抹掉上一轮的记录，
 * 那正是 Logseq 2023 年丢失全部 Logbook 历史的形态。
 *
 * 因此 `TodoItem.status` 的取值也只有这三个（ADR-015 §4 的「已完成」筛选因此**查状态不查事件**）。
 */
export type TaskStatus = 'not_started' | 'in_progress' | 'abandoned'

/**
 * 任务（`tasks` 行的内存形态，ADR-013 §1）。
 *
 * **没有 `carryCount`**：顺延次数是派生量，由 `task/rescheduled` 事件的条数算出
 * （ADR-002 §2 / ADR-013 §4.3），落库就多一处会与事件分叉的地方。
 */
export interface Task {
  id: string
  accountId: string
  title: string
  /** 无备注 = 空串，不是 null（ADR-013 §理由：能用一个值表示的状态不要用两个） */
  notes: string
  importance: Importance
  /** 「打算哪天做」——**日级锚点**（ADR-016 §1）。重复任务恒为 null（ADR-013 §3.1） */
  plannedDate: DayKey | null
  /** 「打算哪周做」——**周级锚点**；非空时恒为该周周一（ADR-016 §1）。重复任务恒为 null */
  plannedWeek: DayKey | null
  /** 「必须哪天前做完」（FR2.4）。重复任务恒为 null（ADR-013 §3.1：没有「相对期限」） */
  dueDate: DayKey | null
  /** 无标签 = 空数组 */
  tags: string[]
  /** 至多一个项目（对齐 Todoist，ADR-016 §1） */
  projectId: string | null
  status: TaskStatus
  /** 手动排序位置；null = 未手动排过（FR2.7 / ADR-013 §4.5） */
  manualOrder: number | null
  /** null ⇔ 非重复任务（ADR-013 §3：用可空对象而非「规则字段各自可空」） */
  recurrence: RecurrenceSpec | null
  /** 软删除时刻；null = 未删除（ADR-013 §4.8：行保留，只是不再出现） */
  deletedAt: string | null
  /**
   * **实例键**（ADR-013 §2）——**不可变**，取自 `task/created` 事件的 `day_key` 列。
   *
   * 非重复任务的实例键恒为它（**与当前 `plannedDate` 无关**，故顺延后已完成态不丢）；
   * 重复任务的实例键由 `deriveRounds` 给出（ADR-015 §2）。
   */
  indexDate: DayKey
  createdAt: string
  updatedAt: string
}

/** 步骤的**定义**（属于任务，跨轮次共享）——ADR-013 §1 */
export interface Step {
  /** UUIDv7，稳定（阶段 6 要按步骤统计，没有稳定 id 无从追溯） */
  id: string
  title: string
}

/**
 * 步骤的**勾选状态**（属于**某一轮实例**，不属于任务）——ADR-013 §1 / §4.12。
 *
 * 键 =（`taskId`, `stepId`, `occurrenceKey`）。若把 `checkedAt` 放在 `Step` 上，
 * 一个「每日复盘」的昨天勾选今天还亮着，`3/5` 从第二轮起永远显示 5/5。
 *
 * 本类型的 `checkedAt` 非空：它是**折叠后的「当前已勾选」集合**，
 * 未勾选的键不出现（见 `TodoItemStep.checkedAt` 的 `string | null`）。
 * 折叠规则与完成事件同源：同一键取**最后一条** `task/step-toggled`（ADR-001 §2 的事件 id 序）。
 */
export interface StepCheck {
  taskId: string
  stepId: string
  occurrenceKey: DayKey
  checkedAt: string
}

/** `tasks` 行的完整内存形态：`Task` + `steps`（ADR-013 §1） */
export interface ProjectedTask extends Task {
  steps: Step[]
}

/**
 * 重复规则是任务的**可选部分**（ADR-013 §3）——**唯一落点就是这里**。
 *
 * `task.recurrence === null` ⇔ 非重复任务。用可空对象而不是「规则字段各自可空」：
 * 后者能表达出「有规则但没有起点」这种不合法组合。
 */
export interface RecurrenceSpec {
  /** ADR-011 §2 的规则词汇（RFC 5545 的 `RRULE`，导出即直译） */
  rule: RecurrenceRule
  /** ADR-011 §5 的三锚点，创建时可选，默认 `catch_up` */
  nextAnchorMode: NextAnchorMode
  /**
   * 相位原点（ADR-011 §1）——「首轮的**原计划日期**起点」。
   *
   * ⚠️ **不得由 `plannedDate` 推导**：某任务「每周一」起于 9/7，用户 9/20 顺延到 9/23，
   * `plannedDate` 变了但 `startsOn` 必须仍是 9/7，否则整条序列的相位平移（ADR-013 §3）。
   */
  startsOn: DayKey
}

// ────────── ADR-013 §4.6 / §4.7：完成事件（**结构化**，不依赖 server 的 `Event<P>`）──────────

/**
 * 完成事件固化的下一轮锚点（ADR-013 §4.6 的嵌套可空对象）。
 *
 * 用「嵌套可空」而不是 `nextAnchorDate: null` + 独立 `nextAnchorMode`：后者在
 * 「没有下一轮」时 `nextAnchorMode` 无处安放，会得到一个「有模式没日期 / 有日期没模式」
 * 的非法组合空间。嵌套让**「没有下一轮」在类型上只有一个表示**。
 */
export interface NextAnchor {
  date: DayKey
  mode: NextAnchorMode
}

/** `task/occurrence-completed` 的载荷（ADR-013 §4.6） */
export interface OccurrenceCompletedPayload {
  taskId: string
  /** 实例键的日期分量 */
  originalPlannedDate: DayKey
  /** 完成时刻的归属日 */
  completedDayKey: DayKey
  /** null = **没有下一轮**（非重复任务，或规则已终止）；不得填越界日期充数 */
  next: NextAnchor | null
}

/** `task/occurrence-uncompleted` 的载荷（ADR-013 §4.7）——追加一条，**不是删除** */
export interface OccurrenceUncompletedPayload {
  taskId: string
  originalPlannedDate: DayKey
}

/**
 * 完成 / 取消完成事件的结构化形态。
 *
 * **为什么是结构化的**：`shared/` 不得 import `server/`（阶段 4 复核实测），
 * 而服务端的 `Event<P>` 住在 `server/events/types.ts`。这里只保留读模型**实际用到**的字段：
 * `eventId`（判定「最后一条」，ADR-001 §2）、`accountId`（账号隔离的结构性防线，
 * ADR-011 §4）、`occurredAt`（`TodoItem.completedAt` 的取处）、载荷。
 *
 * `type` 直接用事件类型名（ADR-013 §4.6 / §4.7），使服务端的映射一眼可对。
 */
export type OccurrenceEvent =
  | {
      type: 'task/occurrence-completed'
      /** 事件行的 `id` 列，**按它排序**（ADR-001 §2：字典序 === 时间序） */
      eventId: string
      /** 事件行的 `account_id` 列（ADR-011 §4：跨账号串台防线） */
      accountId: string
      /** 事件行的 `occurred_at` 列 */
      occurredAt: string
      payload: OccurrenceCompletedPayload
    }
  | {
      type: 'task/occurrence-uncompleted'
      eventId: string
      accountId: string
      occurredAt: string
      payload: OccurrenceUncompletedPayload
    }

// ─────────────────────── ADR-015 §1：读模型 ───────────────────────

/**
 * 为什么出现在这个视图 / 为什么排在这里（FR2.6 要求「规则透明、界面上可见排序理由」）。
 *
 * **两类理由不能混为一谈**（ADR-015 §1）：入选理由回答「它为什么在这儿」，
 * 档位理由回答「它为什么排第一」。界面要展示的是**后者**（FR2.6 的原文是
 * 「可见**排序**理由」），而前者是排查「任务怎么不见了」时的依据。
 * 本类型按 ADR 的三组原样分成三段，界面用 `today.ts` 的
 * `isSelectionReason` / `isBucketReason` 区分，**不要按数组位置取**。
 */
export type TodoReason =
  // —— 为什么「入选」——
  | 'planned_today'
  | 'planned_overdue' // §3 A
  | 'due_today'
  | 'due_overdue' // §3 B
  | 'in_progress_undated' // §3 C
  | 'completed_today' // §3 D / F
  | 'recurring_pending'
  | 'recurring_overdue' // §3 E
  // —— 为什么「排在这里」——
  | 'bucket_overdue'
  | 'bucket_today'
  | 'bucket_tomorrow'
  | 'bucket_this_week'
  | 'bucket_no_date'
  | 'bucket_done'
  // ⚠️ **`bucket_abandoned` 是 ADR-015 §1 漏掉的一个取值**（实现时发现，已报告）：
  // §4 的档位表有**七**档（0–6），而 §1 的 `TodoReason` 只列了**六**个 bucket 理由
  // （`bucket_overdue` / `bucket_today` / `bucket_tomorrow` / `bucket_this_week` /
  // `bucket_no_date` / `bucket_done`），**档 5「已放弃」没有对应的理由**。
  // 少了它，已放弃的任务既无法在界面上说明「它为什么排最后」（FR2.6 要求理由可见），
  // 排序也无从判定档位。档 5 与档 6 必须各有自己的理由——把它们合并
  // 恰恰是 §4 那一整段要防的错（「已放弃不得呈现为已完成」）。
  | 'bucket_abandoned'
  // —— 项目视图专用的分组标注（§5）——
  | 'outside_project_range'

/** `TodoItem.steps` 的元素：步骤定义 + **本实例**的勾选态（ADR-013 §4.12） */
export interface TodoItemStep extends Step {
  /** null = 本实例未勾选。**本实例**由 `TodoItem.occurrenceKey` 定（§2 的实例键） */
  checkedAt: string | null
}

/**
 * 读模型 `TodoItem` —— 界面看见的每一行（ADR-015 §1）。
 *
 * **它不是 `Task` 的别名，而是「任务 × 实例」里被选中的那些格子**：
 * 同一个重复任务在不同日子里产出 `taskId` 相同、`occurrenceKey` 不同的行。
 *
 * ⚠️ **`pending` 与 `createdAt` 当初不在 §1 的字段表里**，是本实现补的
 * （分别支撑 §3 的入选规则 E 与 §4 的排序第 2 级；缺陷已回填进 §1，
 * 故现在两边一致）。**`manualOrder` 由 §1 与 §4.1 定义**（`manual` 模式的排序键）。
 * 除这三处之外，本接口与 §1 逐字相同。
 */
export interface TodoItem {
  taskId: string
  /** 实例键的日期分量（§2）：非重复任务恒为 `indexDate`；重复任务为该轮的「原计划日期」 */
  occurrenceKey: DayKey
  title: string
  notes: string
  importance: Importance
  tags: string[]
  projectId: string | null
  /** 定义 + 本实例的勾选态 */
  steps: TodoItemStep[]
  /** 重复任务恒为 null（ADR-013 §3.1） */
  plannedDate: DayKey | null
  /** 周级锚点（ADR-016 §1）；重复任务同样恒为 null */
  plannedWeek: DayKey | null
  dueDate: DayKey | null
  status: TaskStatus
  /** **本实例**的完成时刻（取自完成事件的 `occurred_at`）；已取消完成时为 null */
  completedAt: string | null
  /** **本实例**的完成归属日；已取消完成时为 null */
  completedDayKey: DayKey | null
  /**
   * 本行显示的是重复任务的**待完成轮次**（ADR-011 §4「每个模板至多一条」）。
   *
   * ⚠️ **这个字段当初不在 ADR-015 §1 的字段表里**（实现时发现，已回填进 §1）：
   * §3 的入选规则 E 是「重复任务：**待完成轮次**的 `originalPlannedDate ≤ today`」，
   * 而「本行是不是待完成轮次」在 §1 给的字段里**判不出来**——
   * `completedAt === null && recurring` 这个替代判据会把「`startsOn` 在未来、
   * 到 today 为止一轮都没有」的重复任务误判成待完成（它的 `occurrenceKey` 会回落成
   * `indexDate`，从而**误进今日视图**）。宁可加一个可判定的字段，也不留一条猜出来的判据。
   *
   * 非重复任务恒为 `false`（它的唯一实例没有「轮次」可言）。
   */
  pending: boolean
  /**
   * 任务创建时刻（`Task.createdAt` 原样）。
   *
   * ⚠️ **这个字段同样是 ADR-015 §1 当初漏掉的**（实现时发现，已回填进 §1）：
   * §4 的全序第 2 级是「`createdAt` 升序」，而 §1 的 `TodoItem` 里没有 `createdAt`——
   * 没有它，§4 的排序**无法按规格实现**，只能退化成「只比 `taskId`」，
   * 即把「按创建先后」悄悄换成「按标识序」（二者今天恰好一致，因为 id 是 UUIDv7；
   * 但那是 ADR-001「约束」节的一条**格式前提**，把它当成排序依据会让
   * 「id 形态一变、顺序静默改变」）。
   */
  createdAt: string
  /**
   * 手动排序位置（`Task.manualOrder` 原样）；`null` = 从未手动排过。
   *
   * `manual` 模式的**唯一排序键**（§4.1）：`null` 统一排在已手动排过的**之后**，
   * 于是**新任务不会插队到用户手工排好的清单中间**。
   * `smart` 模式**忽略它**——两种模式不互相污染（§4.1）。
   *
   * 写入侧只有 `task/reordered` 一个入口（ADR-013 §4.5）。
   */
  manualOrder: number | null
  /**
   * 是否重复任务（界面据此区别呈现：重复图标、轮次说明）。
   *
   * ⚠️ **它不是装饰**：ADR-015 §4 的紧迫度判定按它分流
   * （非重复任务的 `occurrenceKey` 是**创建日**，无条件计入会让任何过夜任务恒判逾期）。
   */
  recurring: boolean
  /**
   * 逾期判据只此一份（FR2.2 + §4 的紧迫日折算），界面不得自己写 `dueDate < today`。
   *
   * **已放弃的任务恒为 `false`**（§1 / §理由 的裁定）：那个 `true` 驱动的是
   * 「期限标红」与档 0 的呈现，而**已经放弃的事不该继续催**——界面把一条用户明确说了
   * 「不做了」的任务标红，是在替他惋惜，不是在描述事实。
   * ⚠️ 它与**档位**是两件事：档位仍按 §4 的 status 优先落档 5。
   */
  overdue: boolean
  /** 入选理由（前）+ 档位理由（后，恒为一条）；项目视图另有 `outside_project_range` */
  reasons: readonly TodoReason[]
}

/**
 * 视图范围（ADR-015 §5，判别联合）。
 *
 * 项目视图**不是区间判定**而是**归属判据**（`item.projectId === scope.projectId`）——
 * 区间判据会让「属于 P、但两个日期锚点皆空」的任务永远不出现，
 * 而它恰是最典型的项目任务（ADR-016 §10 的裁决）。
 */
export type Scope =
  | { kind: 'range'; from: DayKey; to: DayKey }
  | { kind: 'project'; projectId: string }
  | { kind: 'all' }

// ⚠️ **项目区间（`ProjectInterval`）不在这里定义**：它的唯一落点是
// `shared/plan/project.ts`（ADR-016 §2），本目录若要它就从 `@shared/plan` 导入。
// 两处各写一份 `{ startsOn, endsOn }` 正是本仓反复栽的「同一概念两个名字」。
//
// 同理，`OwnershipLevel` / `Anchors` / `ownershipLevelOf` 属 ADR-016 §1 的产物、
// 落在 `shared/plan/ownership.ts`——`shared/tasks` 与 `shared/plan` 是
// **分工而非重复**（ADR-015 §后果）：`tasks` 管「某一天要做什么」，
// `plan` 管「这条任务归在哪一层」。
