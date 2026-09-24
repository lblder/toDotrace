import type { z } from 'zod'
import type { DayKey } from '@shared/time'
import type { NextAnchorMode, RecurrenceRule, RecurrenceTemplate } from '@shared/recurrence'
import type { ProjectedTask } from '@shared/tasks/types'

/**
 * 事件存储与重放的公开类型（ADR-010）。
 *
 * 本文件只放类型与最薄的定义助手，不含任何 I/O——`project()` 的纯函数性
 * 依赖于「折叠只吃 (projection, event)」这一条（ADR-010 §4）。
 *
 * 重复域的类型（`RecurrenceRule` / `RecurrenceTemplate` / `NextAnchorMode`）
 * **一律从 `@shared/recurrence` 取用**，此处只做转发：
 * ADR-011 §4 的 `deriveRounds(template, …)` 与本层的投影吃的是同一个实体，
 * 两处各写一份就是两个真相。
 *
 * 任务域的类型（`Task` / `Step` / `ProjectedTask` / `RecurrenceSpec`）同理，
 * **一律从 `shared/tasks/types.ts` 导入**（ADR-013 §1 / §3：「`RecurrenceSpec` 的唯一落点
 * 是 `shared/tasks/types.ts`，其它模块一律导入，不得就地重写一份字面量联合」）。
 * 本文件只**转发**它们——**不再自己声明一份**：两个同名同形的接口就是两个真相的起点
 * （改一处忘一处时，编译不报错而重放结果变了）。
 * **依赖方向只能是 `shared → server`**：`shared/` 不得 import `server/`。
 *
 * 投影项目 / 每日备注的类型（`ProjectedProject` / `ProjectedDayNote`）**仍在本文件**：
 * 它们是**事件层的投影行形状**（与两张表的列一一对应），不是域实体，
 * 故不在 `shared/` 里——`shared/` 那边没有它们的第二个家。
 */

export type { NextAnchorMode, RecurrenceRule, RecurrenceTemplate }
export type { ProjectedTask, RecurrenceSpec, Step, Task } from '@shared/tasks/types'

/** 一条事件的**内存形态**：字段与 `events` 表逐列对应，`payload` 是已解析的 JSON。 */
export interface Event<P = unknown> {
  /** UUIDv7。**重放排序键唯一地是它**（ADR-001 §2 / ADR-010 §1） */
  id: string
  accountId: string
  /** 动作类别，单表判别字段；未登记的 type 一律拒绝写入（ADR-010 §2） */
  type: string
  /** 发生时刻，ISO 8601 带偏移 */
  occurredAt: string
  /** IANA 时区名，写入时固化 */
  timezone: string
  /** 归属日，**写入时按当时的 dayStartHour 固化，永不重算**（ADR-001 §4） */
  dayKey: DayKey
  /** 折算所用设置，使「这天为什么归到这天」永远可解释 */
  dayStartHour: number
  /** 关联对象类别；null 表示不针对特定对象 */
  targetKind: string | null
  /** 关联对象标识 */
  targetId: string | null
  /** 一次用户动作 = 一个批次（ADR-006 §1） */
  batchId: string
  payload: P
  /** 服务端接收时刻；离线导入时与 `occurredAt` 不同 */
  appendedAt: string
}

/**
 * 追加一条事件的入参。
 *
 * 可选字段的存在理由（ADR-010 §3）：
 * - `id` / `batchId` / `timezone` / `dayKey` / `dayStartHour` **省略时由服务端生成或折算**；
 *   **离线导入必须原样传入**——导入的事件保留原 id（合并幂等的依据）与原 batch_id
 *   （否则 `system/revoke` 会解析不到批次，被撤销的历史在导入后复活），
 *   `dayKey` / `dayStartHour` / `timezone` 已固化，**永不重算**。
 */
export interface EventDraft<P = unknown> {
  type: string
  payload: P
  /** 动作发生时刻，ISO 8601 带偏移 */
  occurredAt: string
  /**
   * 关联对象两列。**对声明了 `target` 的事件类型不必给**——`appendEvents` 会从载荷派生
   * （见 `EventDefinition.target`）；给出来则必须与派生值一致，不一致即拒绝写入
   * （导入文件被改写与 id 碰撞同样都是「同一条事件两份内容」，不能静默取其一）。
   * 未声明 `target` 的类型省略即 NULL。
   */
  targetKind?: string | null
  targetId?: string | null
  id?: string
  batchId?: string
  timezone?: string
  /** 与 `dayStartHour` **成对**出现：它们是同一份固化事实的两半 */
  dayKey?: DayKey
  dayStartHour?: number
}

/**
 * 投影中的项目行（ADR-016 §6 的 `projects` 表）。
 *
 * `isCurrent` 与 `deletedAt` 都**可由事件重放得出**（分别来自 `project/current-changed`
 * 与 `project/deleted` 的载荷 / `occurred_at`），`endsOn` 等来自载荷——故不违反 ADR-002 §2。
 * **没有 `status` 列**：项目的「是否已结束」是派生量（`projectState`，ADR-016 §4）。
 */
export interface ProjectedProject {
  id: string
  accountId: string
  name: string
  /** dayKey，**含**（闭区间左端） */
  startsOn: DayKey
  /** dayKey，**含**（闭区间右端；起止同日 = 1 天项目，合法） */
  endsOn: DayKey
  /** 「当前项目」；同一账号**至多一个** true（由部分唯一索引兜底，ADR-016 §4） */
  isCurrent: boolean
  /** 软删除时刻；`null` = 未删除。**行永不被物理删除** */
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 投影中的每日备注行（ADR-017 §6 的 `day_notes` 表）。
 *
 * 它**独立于到达**：FR1 的休息日恰恰是人最需要写一句的日子（「发烧在家」），
 * 要求先打卡才能备注等于把这个功能从最需要它的场景里拿掉。
 * 于是它不进 `days`（那会建出「有备注、无到达」的行，推翻 ADR-012 §2 的
 * 「无行 ⇔ 无到达」不变式），而是自己一张表。
 *
 * **`text` 为空串即无备注**（ADR-013 §1：能用一个值表示的状态不要用两个）——
 * 重放时空串即删除该行，`Projection.dayNotes` 里不存在「text 为空串」的元素。
 */
export interface ProjectedDayNote {
  accountId: string
  dayKey: DayKey
  text: string
  /** 最后写入时刻，取自 `note/updated` 的 `occurred_at` */
  updatedAt: string
}

/**
 * 账号设置（ADR-010 §3 的 `Projection.settings`、§6 的 `settings` 表）。
 *
 * 它是**投影的一部分**，因此与模板一样必须能由事件重放得出：唯一的来源是
 * `settings/updated` 事件的载荷（时区与 `dayStartHour`）+ 事件的 `occurred_at`
 * （`updatedAt`）——后者沿用模板的 `createdAt` / `updatedAt` 口径，载荷里不重复携带。
 *
 * ⚠️ **变更语义**（ADR-010 §6）：设置变更只影响**此后写入**的事件；
 * 历史事件的 `day_key` / `timezone` 已固化、永不重算。
 */
export interface AccountSettings {
  accountId: string
  /** IANA 时区名 */
  timeZone: string
  /** 0–23 */
  dayStartHour: number
  /** 该行最后写入时刻（取自 `settings/updated` 的 `occurred_at`） */
  updatedAt: string
}

/**
 * 打卡日（ADR-012 §2 的 `days` 表）在投影里的形态。
 *
 * **每一行必有到达**（`arrivedAt` 非空）：`checkin/left` 对没有行的日子不建行，
 * 于是「无行 ⇔ 无到达」恒成立——这是 ADR-012 §2 用结构（而非约定）保证的不变式，
 * FR1 的「无到达记录 = 休息日」与 ADR-002 §3 的「打卡天数 = COUNT(*)」都由它直接成立。
 *
 * `accountId` 与 `ProjectedTask` / `ProjectedProject` / `AccountSettings` 同理：它**可由事件重放得出**
 * （取自事件的 `account_id` 列），不违反「投影表中不得存放无法由事件重放得出的字段」
 * （ADR-002 §2）；带上它是为了让 `writeProjection` 的跨账号守卫能逐行生效。
 *
 * `dayKey` 是**归属日**：到达取 `toDayKey(occurred_at, ctx)`，
 * 离开取**它所闭合的那次到达的归属日**（ADR-012 §5 对 ADR-001 §4 的收窄）。
 * 两者的时间字段都是事件的 `occurred_at`（离开可以是次日凌晨——那正是「跨零点的到访」
 * 该有的样子，`leftAt - arrivedAt` 即时长）。
 */
export interface ProjectedDay {
  accountId: string
  dayKey: DayKey
  /** 到达时刻（ISO 8601 带偏移）。**非空** */
  arrivedAt: string
  /** 离开时刻；`null` = 尚未离开（时长未知，FR1） */
  leftAt: string | null
  breaks?: { startedAt: string; endedAt: string | null }[]
}

/**
 * 阶段 2 起的投影形状（ADR-010 §3）。后续阶段向其中追加各自的键：
 * 阶段 3 追加 `days`（ADR-012 §2）；阶段 4 追加 `tasks`（ADR-013 §5，**取代 `templates`**）、
 * `projects`（ADR-016 §6）与 `dayNotes`（ADR-017 §6）。
 *
 * **每个数组的规范化顺序见 ADR-013 §5 的那张表**（`tasks` / `projects` 按 `id` 升序、
 * `days` / `dayNotes` 按 `dayKey` 升序）——`canonicalizeProjection` 是它唯一的落点。
 */
export interface Projection {
  /**
   * 任务当前态（ADR-013 §5，取代原 `templates`）。
   *
   * **数组顺序按任务 `id` 升序规范化**：折叠顺序（事件 id）与任务 id 顺序并不相同——
   * 任务会被原地更新、软删除、撤销批次改写——若不做规范化，「增量维护」与「全量重建」
   * 两条路径产出的数组顺序会不同，使 ADR-010 §5 要求的「两者结果一致」无法逐字段断言
   * （而 flaky 的断言会被当成测试问题而不是设计问题）。
   */
  tasks: ProjectedTask[]
  /**
   * 项目当前态（ADR-016 §6）。**数组顺序按 `id` 升序规范化**——理由同上。
   *
   * **包含已软删除的项目**：`deletedAt` 非空的行仍在投影里（否则「删项目后其下任务的
   * `projectId` 仍可解析」这件事就没有落点）。要「未删除的项目」由读取方按
   * `deletedAt === null` 过滤——ADR-014 §3 的 `ctx.projects` 正是这个口径。
   */
  projects: ProjectedProject[]
  /**
   * 每日备注（ADR-017 §6）。**数组顺序按 `dayKey` 升序规范化**——理由同上。
   * `text` 为空串的行**不存在**于此（空串即清除，见 `ProjectedDayNote`）。
   */
  dayNotes: ProjectedDayNote[]
  /**
   * 账号设置当前态；`null` 表示**流水里还没有 `settings/updated` 事件**。
   *
   * `null` 与「取默认值」是两件事，这里不做合并：折叠只如实报告「事件说了什么」，
   * 「缺设置时用哪个时区」是读取方（`loadAccountSettings`）的回落策略。
   * 若在这里塞默认值，`project()` 就得读服务端时区——它立刻不再是纯函数。
   */
  settings: AccountSettings | null
  /**
   * 打卡日（ADR-012 §2）。**数组顺序按 `dayKey` 升序规范化**——理由与 `tasks` 相同：
   * 折叠顺序是事件 id 序，不规范化就无法逐字段断言「增量 == 全量重建」（ADR-010 §5）。
   *
   * 顺带满足 ADR-012 §6 对 `dayKeys` 的前置条件（「已升序、已去重」）：
   * `shared/checkin` 的三个函数吃的就是这个数组映射出的 `dayKey` 列表。
   */
  days: ProjectedDay[]
}

/**
 * 事件类型定义（ADR-010 §2）——注册表的唯一元素形状。
 * 前三个成员是必需的，`target` 可选——注册表是唯一的事件类型清单，
 * 多一个成员就多一处契约漂移。
 */
export interface EventDefinition<P> {
  type: string
  /** 写入时校验载荷；畸形数据拒绝入库 */
  schema: z.ZodType<P>
  /** 把一条事件施加到投影上。必须是**纯函数**：只看 (projection, event)，不读时钟、不读库 */
  apply(projection: Projection, event: Event<P>): void
  /**
   * 该类型事件的**标识落点**（ADR-010 §2）——它针对哪个对象。
   *
   * 声明了 `target` 的类型，其事件的 `target_kind` / `target_id` 两列由
   * `appendEvents` **从载荷派生**（`kind` 是常量，`fromPayload` 取标识），
   * 调用方无从写错，也无从漏写。导入的事件同样按此派生：载荷原样导入，
   * 派生结果自然与原事件一致（`assertSameEvent` 会逐列核对这一点）。
   *
   * 未声明 `target` 的类型（系统事件、设置事件）两列为 NULL——
   * 「不针对特定对象」（ADR-010 §1）。
   */
  target?: {
    /** `target_kind` 的取值 */
    kind: string
    /** 从载荷取出 `target_id`；返回值必须是**已通过 `schema` 校验**的载荷的非空字符串 */
    fromPayload: (payload: P) => string
  }
}

/**
 * 注册表的存储形态：各定义的载荷类型不同，取出后由调用方按 `event.type` 收窄。
 * 仅在注册表内部与 `project()` 的折叠循环里使用。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RegisteredDefinition = EventDefinition<any>

/**
 * 登记一类事件的助手：只为让各定义文件获得载荷类型推导，不做任何运行期加工。
 * 定义对象的形状**仍严格等于** `EventDefinition<P>`（ADR-010 §2）。
 */
export function defineEvent<P>(definition: EventDefinition<P>): EventDefinition<P> {
  return definition
}
