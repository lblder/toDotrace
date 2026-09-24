/**
 * 服务端契约类型 —— **逐条对照 ADR-008**，不假设未列出的字段。
 *
 * ADR-008 的后果一节写得很明确：
 *   「`src/` 据此写 api client 与 hooks，**不得**假设本 ADR 未列出的字段存在」
 * 因此这里没有 `passwordHash` 一类东西——`user` 对象就只有 ADR-008 §2
 * 列出的四个字段。
 *
 * 邀请码与成员列表是 ADR-008 §2 路由表里明列的 owner 专属资源，
 * 字段照 §2 与 §8 补遗抄录：**列表接口不返回明文 code**（只在签发响应里出现一次）。
 */

import type { DayKey } from '@shared/time'
import type { ProjectInterval } from '@shared/plan'
import type { Round } from '@shared/recurrence'
import type {
  Importance,
  RecurrenceSpec,
  Step,
  TaskStatus,
  TodoItem,
  TodoItemStep,
} from '@shared/tasks'

export type Role = 'owner' | 'member'

/** ADR-008 §2：登录 / 注册 / me 三处形态一致 */
export interface User {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
}

/** POST /api/setup/owner、/api/auth/login、/api/auth/register 的响应 */
export interface AuthPayload {
  readonly user: User
  readonly token: string
}

/** GET /api/setup/status */
export interface SetupStatus {
  readonly needsOwner: boolean
}

/** GET /api/auth/me */
export interface MePayload {
  readonly user: User
}

/** ADR-008 §1：错误信封的唯一形态 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

/** POST /api/setup/owner 的请求体 */
export interface CreateOwnerInput {
  readonly username: string
  readonly password: string
  readonly displayName: string
}

/** POST /api/auth/login 的请求体 */
export interface LoginInput {
  readonly username: string
  readonly password: string
}

/** POST /api/auth/register 的请求体 */
export interface RegisterInput {
  readonly username: string
  readonly password: string
  readonly displayName: string
  readonly inviteCode: string
}

/* -------------------------------------------------------------------------
   owner 专属：邀请码与成员（ADR-008 §2）
   ------------------------------------------------------------------------- */

/** POST /api/invites 的响应体。**明文 code 只在这里出现一次**，此后无法再取回。 */
export interface IssuedInvite {
  readonly id: string
  readonly code: string
  readonly expiresAt: string
}

/** POST /api/invites 的请求体；不传 expiresInDays 即服务端默认 7 天（§8 补遗） */
export interface IssueInviteInput {
  readonly expiresInDays?: number
}

export interface CreateInvitePayload {
  readonly invite: IssuedInvite
}

/** GET /api/invites 的列表项 —— 注意**没有** code 字段 */
export interface InviteSummary {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly usedBy: string | null
  readonly usedAt: string | null
}

export interface InviteListPayload {
  readonly invites: readonly InviteSummary[]
}

/** GET /api/members 的列表项：只有身份与活跃时间，不含任何成员的数据内容 */
export interface MemberSummary {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly role: Role
  readonly createdAt: string
  readonly lastSeenAt: string | null
}

export interface MemberListPayload {
  readonly members: readonly MemberSummary[]
}

/* -------------------------------------------------------------------------
   打卡（ADR-012 §3）—— 契约只有那四条路由，字段照抄，不假设别的
   ------------------------------------------------------------------------- */

/**
 * 一天的打卡记录（ADR-012 §2 的 `days` 行）。
 *
 * `leftAt` 可空：无离开记录 = 时长未知（01 FR1），界面**不得**替它猜一个值。
 * 每一行都必有 `arrivedAt`——这是 §2 的结构保证，故「无行 ⇔ 无到达」恒成立。
 */
export interface DayRow {
  /** 归属日 'YYYY-MM-DD'，写入时按 `shared/time` 固化；凌晨到达归前一天 */
  readonly dayKey: string
  readonly arrivedAt: string
  readonly leftAt: string | null
}

/**
 * POST /api/checkin/arrive、`/api/checkin/leave` 的响应（ADR-012 §3）。
 *
 * `created: false` 表示**这次请求没有写入新记录**，服务端把既有状态原样返回
 * （幂等语义：重复到达 / 重复离开都不写第二条事件）。界面据此必须说
 * 「你今天 9:12 已经打过卡了」，而不是假装刚打上——`day.arrivedAt` 就是那次
 * 真实到达的时刻，`created: false` 时尤其不能拿当前时间来顶替它。
 */
export interface CheckinResult {
  readonly day: DayRow
  readonly created: boolean
}

/**
 * GET /api/checkin/today。
 *
 * `day === null` ⇔ 今天还没有到达记录 ⇔ 休息日（ADR-012 §5），
 * 界面呈现为「今天偷偷懒」，不计入打卡天数——**不是错误态、不是缺失态**。
 * 响应里没有 `isRestDay` 字段：它完全由 `day === null` 决定（v1.1 删去了这个冗余）。
 */
export interface TodayCheckin {
  readonly day: DayRow | null
  readonly streak: number
}

/* -------------------------------------------------------------------------
   阶段 4（ADR-017 §1）—— 任务、项目、备注、设置、撤销
   ------------------------------------------------------------------------- */

/**
 * 读模型的**行形态就是 `TodoItem` 本身**（ADR-015 §1），这里不再抄一遍。
 *
 * 抄一遍的代价是具体的：ADR-015 §1 的字段表与 `shared/tasks/types.ts` 已经
 * 逐字对齐过一次（且那次对齐发现了三处缺口：`pending` / `createdAt` /
 * `bucket_abandoned`），第三方副本只会让「哪一份是对的」变成一个问题。
 */
export type { TodoItem }

/** GET /api/tasks?scope=… —— `today` 由**服务端**回带（ADR-015 §6） */
export interface TaskListPayload {
  /**
   * 服务端实际使用的今日归属日。
   *
   * ⚠️ **前端不得自行计算 `today` 用于提交**：跨零点或跨 `dayStartHour` 时两端会
   * 算出不同日期，症状是「任务点不动」且**没有任何报错**（ADR-015 §6）。
   * 界面必须显示它，否则用户不知道自己看的是哪一天（ADR-017 §10 末段）。
   */
  readonly today: DayKey
  readonly items: readonly TodoItem[]
}

/**
 * 任务的**对外形态**。
 *
 * ⚠️ **ADR-017 没有定义它**（§1.1 只给了路径与 `{ task, … }` 这个外壳），
 * 于是两端各猜了一次、且**猜得不一样**：本文件初稿写的是 `ProjectedTask`
 * 逐字照搬（`id` / `accountId`），而服务端给的是下面这个 `taskId` 起头的形态
 * （`accountId` 不外泄，与 ADR-008 §2 的 `user` 只给四个字段同一条取舍）。
 * 这是 ADR 的一处真实缺口，已如实上报；此处按**实际跑得通的那一份**对齐，
 * 而不是留一个「按文档写、跑起来全 undefined」的类型。
 */
export interface TaskView {
  readonly taskId: string
  readonly title: string
  readonly notes: string
  readonly importance: Importance
  readonly plannedDate: DayKey | null
  readonly plannedWeek: DayKey | null
  readonly dueDate: DayKey | null
  readonly tags: readonly string[]
  readonly projectId: string | null
  readonly status: TaskStatus
  readonly manualOrder: number | null
  readonly recurrence: RecurrenceSpec | null
  /** `recurrence !== null` 的**派生便利字段**（界面据此区别呈现） */
  readonly recurring: boolean
  /** 实例键（ADR-013 §2）——**不可变**；非重复任务的实例键恒为它 */
  readonly indexDate: DayKey
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
  readonly steps: readonly Step[]
}

/**
 * `GET /api/tasks/:id` 的响应（ADR-017 §1.1）。
 *
 * ⚠️ **`occurrences` 与 `steps` 的元素形状 ADR-017 也没定义**（只写了字段名）。
 * 这里按服务端实际给出的形态收：`occurrences` 是 `Round[]`（ADR-011 §4 的轮次，
 * 它就是**历史区**要的那份数据），`steps` 是**本实例**的勾选态（`TodoItemStep[]`）。
 * 另有的 `occurrenceKey` / `today` / `carryCount` 等字段本类型不声明——
 * 界面不用它们；**声明了不用的字段会让「契约里有什么」变成一团模糊**。
 */
export interface TaskDetailPayload {
  readonly task: TaskView
  /** 全部轮次（已完成 + 至多一条待完成）。**历史区**用它，`taskId` 相同时按轮次区分 */
  readonly occurrences: readonly Round[]
  /** 步骤定义 + **当前那一轮**的勾选态（ADR-013 §4.12） */
  readonly steps: readonly TodoItemStep[]
  /** `steps` 的勾选态所属的实例键（服务端解算结果） */
  readonly occurrenceKey: DayKey
  readonly today: DayKey
}

/** `POST /api/tasks` 的请求体（ADR-017 §3）。**`taskId` 由客户端生成**（UUIDv7） */
export interface CreateTaskInput {
  readonly taskId: string
  readonly title: string
  readonly notes?: string
  /**
   * ⚠️ **没写优先级时整条键都不出现**，而不是 `?? 'normal'`——
   * 默认值只有 ADR-017 §3 一处，客户端再写一次就是第二个默认值（ADR-014 §6）。
   */
  readonly importance?: Importance
  readonly plannedDate?: DayKey | null
  readonly plannedWeek?: DayKey | null
  readonly dueDate?: DayKey | null
  readonly tags?: readonly string[]
  readonly projectId?: string | null
  readonly recurrence?: RecurrenceSpec | null
  readonly steps?: readonly { readonly id: string; readonly title: string }[]
  readonly pomodoroEnabled?: boolean
}

/** `POST /api/tasks` 的响应。`created: false` = 该 `taskId` 已存在，返回既有任务（幂等） */
export interface CreateTaskPayload {
  readonly task: TaskView
  readonly created: boolean
}

/** PATCH 只发送需要修改的定义字段；其余字段由服务端保留。 */
export type UpdateTaskInput = Partial<Omit<
  CreateTaskInput,
  'taskId' | 'steps' | 'plannedDate' | 'plannedWeek' | 'dueDate' | 'pomodoroEnabled'
>>

/** `POST /api/tasks/:id/status` 的请求体 */
export interface SetTaskStatusInput {
  readonly to: TaskStatus
}

/** `POST /api/tasks/reschedule` 的单项（ADR-017 §9） */
export interface RescheduleItem {
  readonly taskId: string
  readonly plannedDate: DayKey | null
  /**
   * ⚠️ **周级锚点必须在这个请求体里**（ADR-017 §9 的警告）：漏掉它会让
   * `plannedWeek` 在创建之后**永远无法修改**——`task/updated` 不带日期锚点，
   * 而 `task/rescheduled` 是创建之后日期锚点的唯一写入者。
   */
  readonly plannedWeek: DayKey | null
  readonly dueDate: DayKey | null
}

/** `POST /api/tasks/reschedule` 的响应。**一个请求 = 一个批次**（ADR-017 §9） */
export interface ReschedulePayload {
  readonly tasks: readonly TaskView[]
}

/** 单个任务变动的响应（状态 / 重排 / 步骤系列路由共用这一层形状） */
export interface TaskPayload {
  readonly task: TaskView
}

/** `DELETE /api/tasks/:id` 与 `DELETE /api/projects/:id` 的响应（软删除 + 可撤销批次） */
export interface DeletedPayload {
  readonly taskId?: string
  readonly projectId?: string
  /** 撤销入口的入参（ADR-017 §8 / ADR-006） */
  readonly batchId: string
}

/** `POST /api/tasks/:id/occurrences/:key/complete|uncomplete` 的响应 */
export interface OccurrencePayload {
  readonly item: TodoItem
}

/** `POST /api/undo` 的响应 */
export interface UndoPayload {
  readonly batchId: string
  readonly revoked: true
}

/* ---------------------------------------------------------------------
   项目（ADR-017 §1.3；语义见 ADR-016）
   --------------------------------------------------------------------- */

/**
 * 项目的读取形态。
 *
 * ⚠️ **ADR-017 §1.3 同样只给了路径、没给字段**（`{ projects, currentProjectId }` 这个外壳
 * 之外什么都没有）。这里按服务端实际给出的形态对齐，三条值得写明：
 *
 * - 标识字段叫 **`projectId`**（与任务的 `taskId` 对称），不是 `id`；
 * - **没有 `deletedAt`**：`GET /api/projects` 只返回未删除的项目
 *   （ADR-016 §6 的软删除在读取侧就折掉了）。界面据此**不能**假设有这一列——
 *   也不能再按它过滤一次（那会把所有项目滤空）；
 * - `state` 是**派生量**（ADR-016 §4：`upcoming` / `active` / `ended`，不落库），
 *   由服务端算出。界面用它，不自己再算一份。
 *
 * `isCurrent` 是**服务端**从 `projects.is_current` 列读出来的，
 * 不是客户端从 `currentProjectId` 推的——两处推同一件事就是两个来源。
 */
export interface ProjectView extends ProjectInterval {
  readonly projectId: string
  readonly name: string
  readonly isCurrent: boolean
  readonly archived: boolean
  /** 派生状态（ADR-016 §4） */
  readonly state: 'upcoming' | 'active' | 'ended'
  readonly createdAt: string
  readonly updatedAt: string
}

/** 兼容别名：`ProjectRow` 是本文件早期的名字，语义与 `ProjectView` 完全同一 */
export type ProjectRow = ProjectView

/** GET /api/projects 的响应 */
export interface ProjectListPayload {
  readonly projects: readonly ProjectRow[]
  /**
   * 当前项目；`null` = 没有当前项目。
   *
   * ⚠️ **「至多一个」不是「恰好一个」**（ADR-016 §4）：项目一个都没有、或当前项目
   * 被删除时它必然为 `null`，故 `DELETE /api/projects/current` 是必需的入口——
   * 一个只能被事件推入、不能主动进入的状态，界面就没法诚实地呈现它。
   */
  readonly currentProjectId: string | null
}

export interface CreateProjectInput {
  /** **客户端生成**的 UUIDv7（与任务同一条纪律，ADR-017 §5） */
  readonly projectId: string
  readonly name: string
  readonly startsOn: DayKey
  readonly endsOn: DayKey
  /**
   * 建完顺手设为当前项目。
   *
   * ⚠️ ADR-017 §1.3 的载荷里**没有这个字段**（它只列了 `projectId` / `name` / `startsOn` / `endsOn`），
   * 是服务端多给的一个便利：设「当前」本来要再发一条 `POST /projects/:id/activate`。
   * 界面**不用它**（本文件的默认值是不发这个键），两条路由的语义因此保持各管各的。
   */
  readonly makeCurrent?: boolean
}

/** `PATCH /api/projects/:id` 收**差量**（服务层合成为整行再写事件，ADR-017 §1.3 注） */
export interface UpdateProjectInput {
  readonly name?: string
  readonly startsOn?: DayKey
  readonly endsOn?: DayKey
}

/* ---------------------------------------------------------------------
   每日备注（ADR-017 §1.4 / §6）—— **无到达也可以备注**
   --------------------------------------------------------------------- */

export interface DayNotePayload {
  readonly dayKey: DayKey
  /** 空串 = 没有备注（清除即写空串，不引入 `null`，ADR-017 §6） */
  readonly text: string
}

/* ---------------------------------------------------------------------
   设置（ADR-017 §1.5 / §7）
   --------------------------------------------------------------------- */

export interface SettingsPayload {
  readonly timeZone: string
  readonly dayStartHour: number
  readonly updatedAt: string
  /**
   * 新设置**开始生效**的归属日（= 该账号当前的 `today`）。
   *
   * 界面据此显示「此设置自 9月22日 起生效，此前的记录不会改变」——
   * 比一句抽象的「不影响历史」更能让用户相信自己没看错（ADR-017 §7）。
   */
  readonly affectsFrom: DayKey
}

/** `PATCH /api/settings` 收差量（服务层合成整行后写事件，ADR-017 §7） */
export interface UpdateSettingsInput {
  readonly timeZone?: string
  readonly dayStartHour?: number
}
