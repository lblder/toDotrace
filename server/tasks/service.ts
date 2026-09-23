import type { Db } from '../db/connection.js'
import { today as accountToday, toIsoInZone, weekEnd, weekStart } from '@shared/time'
import type { DayKey } from '@shared/time'
import { AnchorInvariantError, nextAnchorDate } from '@shared/recurrence'
import type { NextAnchorMode, Round } from '@shared/recurrence'
import {
  buildTodoItem,
  buildTodoItems,
  canChangeStatus,
  canCompleteOccurrence,
  canRescheduleTask,
  canUncompleteOccurrence,
  effectiveCompletions,
  queryItems,
  roundsOf,
  sortItems,
  todayItems,
} from '@shared/tasks'
import type {
  Importance,
  ProjectedTask,
  RecurrenceSpec,
  Step,
  TaskActionRejection,
  TaskActionVerdict,
  TaskStatus,
  TodoItem,
  TodoItemStep,
  TodoReadInput,
} from '@shared/tasks'
import { appendEvents } from '../events/append.js'
import {
  taskDeletedDefinition,
  taskOccurrenceCompletedDefinition,
  taskOccurrenceUncompletedDefinition,
  taskReorderedDefinition,
  taskRescheduledDefinition,
  taskStatusChangedDefinition,
  taskStepAddedDefinition,
  taskStepRemovedDefinition,
  taskStepRenamedDefinition,
  taskStepToggledDefinition,
  taskStepsReorderedDefinition,
  taskUpdatedDefinition,
} from '../events/index.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import {
  dateDrivenByRule,
  invalidInput,
  notFound,
  occurrenceAlreadyCompleted,
  occurrenceNotCompleted,
  statusTransition,
  taskNotCompletable,
  type ApiError,
} from '../lib/errors.js'
import { uuidv7 } from '../lib/uuid.js'
import {
  buildItem,
  findTask,
  loadTaskSources,
  occurrenceEventsOf,
  reschedulesOf,
  stepChecksOf,
  todoInputOf,
  withTaskId,
  type RescheduleRecord,
  type TaskSources,
} from './sources.js'

/**
 * 任务的域逻辑（ADR-017 §1.1 / §1.2 / §3 / §4 / §9；判据取自 ADR-013 / ADR-015）。
 *
 * ## 与路由的分工
 *
 * - **路由**（`routes/tasks.ts`）做**入口契约**：字段上限、`.strict()`、scope 解析，
 *   以及「`accountId` 只能来自鉴权上下文」；
 * - **本模块**做**域判定**：状态迁移、实例存在性、批次原子性、跨行守卫。
 *   它**不开事务**（ADR-002 §1：事务由请求处理层开），只断言行在事务内——
 *   绕开路由直接调用会在 `appendEvents` 之前就抛错，而不是留下半条数据。
 *
 * ## 三条贯穿全文件的纪律
 *
 * 1. **`accountId` 只来自调用方传入的鉴权上下文**（ADR-017 §5）：每个函数都把它作为
 *    显式参数，**从不读请求体的任何字段**——请求体里的 `accountId` 在路由层就被
 *    `.strict()` 拒掉（400），不是被忽略；
 * 2. **`PATCH` 收差量、事件载荷是整行快照**（ADR-017 §4 / §1.3 注 / §7 三处同名纪律）：
 *    `updateTaskDefinition` 先读当前行、**合成为整行**、再写事件。把差量直接写进载荷
 *    会让重放依赖「前一条事件一定在」，而撤销与合并导入都可能让它不在；
 * 3. **一个用户动作 = 一个批次 = 一个事务**（ADR-006 §1 / ADR-012 §4）：批量顺延的
 *    N 条事件共用一次 `appendEvents` 调用给出的 `batchId`，且**任一 item 失败则整批不写**
 *    ——部分成功会让用户看到「一半挪了一半没挪」，而他无从知道是哪一半。
 *
 * ## 时刻由调用方传入
 *
 * 与 `checkin/service.ts` 同一纪律：本模块**不读系统时钟**，`now` 由路由传入并在一个
 * 请求内只取一次。于是「归属日」与「完成时刻」在同一事务里出自同一瞬间，
 * 不会出现「读的是一个时刻、写的是另一个」。
 */

/** 列表的查询形态（ADR-017 §1.1 的五个 `scope`；`week` 由服务端折算成区间） */
export type TaskListQuery =
  | { scope: 'today' }
  | { scope: 'week' }
  | { scope: 'range'; from: DayKey; to: DayKey }
  | { scope: 'project'; projectId: string }
  | { scope: 'all' }

/**
 * 任务行对外的形态。
 *
 * **不是 `ProjectedTask` 本身**：`accountId` 不外泄（响应体「一律只含当前账号的数据」，
 * 多一个自己的 id 也无用——与 `checkin/service.ts` 的 `toDayRow` 同一条取舍），
 * 且 `recurring` 是给调用方的**派生便利字段**（读模型有，行上没有）。
 */
export interface TaskView {
  taskId: string
  title: string
  notes: string
  importance: Importance
  plannedDate: DayKey | null
  plannedWeek: DayKey | null
  dueDate: DayKey | null
  tags: string[]
  projectId: string | null
  status: TaskStatus
  manualOrder: number | null
  recurrence: RecurrenceSpec | null
  /** `recurrence !== null` 的派生便利字段（界面据此区别呈现） */
  recurring: boolean
  /** 实例键（ADR-013 §2）——**不可变**；非重复任务的实例键恒为它 */
  indexDate: DayKey
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  steps: Step[]
}

/** `POST /api/tasks` 的入参：与 ADR-017 §3 的载荷同形，**默认值与上限已在路由层处理** */
export interface CreateTaskInput {
  taskId: string
  title: string
  notes: string
  importance: Importance
  plannedDate: DayKey | null
  plannedWeek: DayKey | null
  dueDate: DayKey | null
  tags: string[]
  projectId: string | null
  recurrence: RecurrenceSpec | null
  steps: Step[]
}

/** `PATCH /api/tasks/:id` 的差量：**只有这六个字段可改**（其余各有专属路由，ADR-017 §4） */
export interface TaskDefinitionPatch {
  title?: string
  notes?: string
  importance?: Importance
  tags?: string[]
  projectId?: string | null
  recurrence?: RecurrenceSpec | null
}

/** `POST /api/tasks/reschedule` 的一条（ADR-017 §9） */
export interface RescheduleItem {
  taskId: string
  /** 省略 = **保持当前值**；`null` = 清空（取舍见 `rescheduleTasks`） */
  plannedDate?: DayKey | null
  plannedWeek?: DayKey | null
  dueDate?: DayKey | null
}

/** 列表结果（ADR-017 §1.1：`{ today, items }`） */
export interface TaskListResult {
  today: DayKey
  items: TodoItem[]
}

/**
 * 任务明细（`GET /api/tasks/:id`）。
 *
 * ⚠️ ADR-017 §1.1 写的响应是 `{ task, occurrences, steps }`；这里的**多出四项已如实报告**：
 *
 * - `occurrenceKey`：`steps` 带的是**某一轮的**勾选态（ADR-013 §4.12），而载荷里没有任何
 *   字段说明是哪一轮——不给出它，调用方只能自己再推一次实例解算（那就是第二个真相）；
 * - `today`：ADR-015 §6 要求「响应用的服务端 `today` 必须回带」，凡是含日期判定的响应都适用；
 * - `carryCount` / `reschedules`：**FR2.7 要求展示「原定 X → 现 Y」与顺延次数**，
 *   而载体只能是流水——本阶段没有别的路由能提供它们（详见实现报告）。
 */
export interface TaskDetail {
  task: TaskView
  /** 全部轮次（已完成 + 至多一条待完成，ADR-011 §4）——历史区与「下一轮」都吃它 */
  occurrences: Round[]
  /** 步骤定义 + **当前那一轮**的勾选态（ADR-013 §4.12） */
  steps: TodoItemStep[]
  /** `steps` 的勾选态所属的实例键（§2 的实例解算结果） */
  occurrenceKey: DayKey
  today: DayKey
  /** 顺延次数（ADR-013 §4.3：派生量 = `reschedules` 的条数，**不落库**） */
  carryCount: number
  /** 顺延历史（FR2.7），最早在前 */
  reschedules: RescheduleRecord[]
}

// ───────────────────────── 读路径 ─────────────────────────

/**
 * `GET /api/tasks?scope=…`（ADR-017 §1.1）。
 *
 * 五个 scope 的判据**全部取自 `shared/tasks`**，本模块只负责拼装：
 *
 * | scope | 判据 |
 * |---|---|
 * | `today` | ADR-015 §3 的 A–F（`todayItems`）——**不是区间判定** |
 * | `week` | §5 的区间 `[weekStart(today), weekEnd(today)]`（两端都含） |
 * | `range` | §5 的区间 `[from, to]`（闭区间，两端都含） |
 * | `project` | §5 的**归属**判据 `item.projectId === projectId`（**不是区间**） |
 * | `all` | 不做范围判定 |
 *
 * 排序一律是 `sortItems` 的默认 `smart` 模式（ADR-015 §4）。**排序模式与筛选不做成
 * 服务端参数**（ADR-017 §1.1：它们是交互式的，走一次网络往返会让每次点排序都卡一下，
 * 而判据只有一份、不存在漂移风险）——故 `?sort=due` 这类参数会被 `.strict()` 拒成 400，
 * 而不是被静默忽略。
 *
 * ## ⚠️ 状态筛选：四个非今日 scope 一律传 `status: 'all'`（**实测出来的 bug，已修**）
 *
 * `queryItems` 不传 `status` 时走的是**默认视图**判据（`filter.ts` 的
 * `case null: return item.status !== 'abandoned'`）——那会把**已放弃的任务整批删掉**，
 * 于是前端手里的 `items` 里根本没有已放弃的行，**「已放弃」与「全部」两个筛选永远是空的**，
 * 而 ADR-015 §4 明令「已放弃的任务仍然要能被找到（**否则用户无法重新打开它**）」
 * ——一条用户可见的功能缺失，不是口味问题。
 *
 * 两层判据必须分清：
 *
 * | 判据 | 属于谁 | 在这里怎么体现 |
 * |---|---|---|
 * | **入选规则**（今日视图的 A–F，含 `status !== 'abandoned'` 那道门槛） | ADR-015 §3，**视图自身的定义** | `todayItems` 内部已实现，**不由调用方传参决定** |
 * | **状态筛选**（FR2.6 的四值：进行中/已完成/已放弃/全部） | **前端**（ADR-017 §1.1 的分工） | 服务端**不筛**，把整集交给调用方去筛 |
 *
 * 故 `today` **不传** `status`（它的门槛在 `selectionReasons` 里，与筛选器无关），
 * 其余四个 scope 传 `'all'`——「`all` 不做判定」说的是 **scope 判定**，
 * 服务端这一层不替前端做筛选。
 */
export function listTasks(db: Db, accountId: string, now: Date, query: TaskListQuery): TaskListResult {
  const today = todayOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const input = todoInputOf(sources, today)

  switch (query.scope) {
    case 'today':
      // ⚠️ 不得改用 `inScope(item, {kind:'range', from: today, to: today})`——
      // 那会让所有逾期项从今日视图消失（ADR-015 §5 的警告，有专门的回归测试）。
      return { today, items: sortItems(todayItems(input), today) }
    case 'week':
      return {
        today,
        items: sortItems(
          queryItems(buildItems(input), {
            scope: { kind: 'range', from: weekStart(today), to: weekEnd(today) },
            // 状态筛选归前端（见文件头的 `listTasks` 注释）：服务端把整集交出去，
            // 否则「已放弃」筛选在前端永远是空的。
            status: 'all',
          }),
          today,
        ),
      }
    case 'range':
      return {
        today,
        items: sortItems(
          queryItems(buildItems(input), {
            scope: { kind: 'range', from: query.from, to: query.to },
            status: 'all',
          }),
          today,
        ),
      }
    case 'project': {
      const project = requireProject(sources, query.projectId)
      return {
        today,
        items: sortItems(
          queryItems(buildItems(input), {
            scope: { kind: 'project', projectId: query.projectId },
            // 区间只用于**分组标注**（`outside_project_range`）——项目清单是归属，不是区间：
            // 一条属于 P、日期全在 P 区间外的任务**仍要出现**（ADR-016 §10 的裁决）。
            projectInterval: { startsOn: project.startsOn, endsOn: project.endsOn },
            status: 'all',
          }),
          today,
        ),
      }
    }
    case 'all':
      return {
        today,
        items: sortItems(queryItems(buildItems(input), { scope: { kind: 'all' }, status: 'all' }), today),
      }
  }
}

/**
 * `GET /api/tasks/:id`（ADR-017 §1.1）。
 *
 * **已软删除的任务返回 404**：ADR-013 §4.8 说软删除是「任务从所有视图消失」，
 * 而明细页正是视图之一。恢复的路径是撤销删除批次（`POST /api/undo`），
 * 而不是「点进一条已删除的任务」。
 */
export function getTaskDetail(db: Db, accountId: string, now: Date, taskId: string): TaskDetail {
  const today = todayOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireLiveTask(sources, taskId)
  const input = todoInputOf(sources, today)
  const item = buildItem(input, task)
  const reschedules = reschedulesOf(sources.events, taskId)

  return {
    task: viewOf(task),
    occurrences: roundsOf(task, input.events, today),
    steps: item.steps,
    occurrenceKey: item.occurrenceKey,
    today,
    carryCount: reschedules.length,
    reschedules,
  }
}

// ───────────────────────── 写路径 ─────────────────────────

/**
 * `POST /api/tasks`（ADR-017 §3 / §5）。
 *
 * ## 幂等
 *
 * `taskId` 已存在于本账号 → **不报错、不写任何事件**，返回既有任务与 `created: false`
 * （ADR-017 §5.3）。「双击提交不得产生两条任务」——判据是**任务行是否存在**，
 * 而不是「标题是否相同」：后者会在用户真的想建两条同名任务时静默吞掉一条。
 *
 * ⚠️ **已软删除的任务也算「存在」**：它的行还在、事件也还在，故这个 id 不能用来再建一条
 * （那会让同一个 id 指向两条任务）。要重做它，走撤销删除批次。
 *
 * ## 归属校验（ADR-016 §6 的「写入前」那一层）
 *
 * `projectId` 必须指向**本账号未删除**的项目；不满足 → `400 validation/invalid-input`，
 * **不区分「不存在」「已删除」与「属于其它账号」**（区分即泄露存在性）。
 */
export function createTask(
  db: Db,
  accountId: string,
  now: Date,
  input: CreateTaskInput,
): { task: TaskView; created: boolean } {
  assertInTransaction(db, '新建任务')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)

  const existing = findTask(sources.projection, input.taskId)
  if (existing !== undefined) {
    return { task: viewOf(existing), created: false }
  }

  if (input.projectId !== null) requireProject(sources, input.projectId)

  appendEvents(db, accountId, [
    {
      type: 'task/created',
      occurredAt: write.occurredAt,
      payload: {
        taskId: input.taskId,
        title: input.title,
        notes: input.notes,
        importance: input.importance,
        plannedDate: input.plannedDate,
        plannedWeek: input.plannedWeek,
        dueDate: input.dueDate,
        tags: [...input.tags],
        projectId: input.projectId,
        recurrence: input.recurrence,
        steps: input.steps.map((step) => ({ id: step.id, title: step.title })),
      },
      // 归属日与折算设置**显式成对给出**：`indexDate` 取自本事件的 `day_key`
      // （ADR-013 §1/§2），故「这条任务的实例键是哪一天」必须在此刻钉死，
      // 不留给事件层再折一次（两次折算在跨 `dayStartHour` 的瞬间会给出不同的日）。
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  const written = findTask(loadTaskSources(db, accountId).projection, input.taskId)
  if (written === undefined) throw projectionMissing(input.taskId)
  return { task: viewOf(written), created: true }
}

/**
 * `PATCH /api/tasks/:id`（ADR-017 §4：**整行快照**，不是差量）。
 *
 * 服务层先把差量合并进当前行、再写**整行载荷**——这次合并**不体现在任何事件上**
 * （事件里只有合并后的整行），故它必须是纯粹的「读当前行 + 覆盖给出的字段」，
 * 不得有第二处状态参与。
 *
 * ## 跨行守卫（ADR-013 §3.1 的第 2 道，**这一道归服务层**）
 *
 * 「给一条**已有日期锚点**的任务加重复规则」在载荷层判不出来——`task/updated` 的载荷
 * **不含**日期锚点（§4.2 的不携带清单），故这条冲突只能读当前行再判，违者 `400`。
 * 载荷那一道管「同一条事件内自相矛盾」，表侧 CHECK 兜底绕过路由的写入，三道各管一段。
 */
export function updateTaskDefinition(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  patch: TaskDefinitionPatch,
): { task: TaskView } {
  assertInTransaction(db, '修改任务')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireLiveTask(sources, taskId)

  // 差量 → 整行：只有**给出**的字段被覆盖，其余保持当前行原值。
  const merged = {
    title: patch.title ?? task.title,
    notes: patch.notes ?? task.notes,
    importance: patch.importance ?? task.importance,
    tags: patch.tags ?? task.tags,
    projectId: patch.projectId === undefined ? task.projectId : patch.projectId,
    recurrence: patch.recurrence === undefined ? task.recurrence : patch.recurrence,
  }

  if (merged.recurrence !== null) {
    const anchors: [string, DayKey | null][] = [
      ['plannedDate', task.plannedDate],
      ['plannedWeek', task.plannedWeek],
      ['dueDate', task.dueDate],
    ]
    for (const [field, value] of anchors) {
      if (value === null) continue
      throw invalidInput(
        `任务 '${taskId}' 已有日期锚点 ${field}='${value}'，不能再给它加重复规则：` +
          '重复任务的「哪天做」由规则唯一决定，任务行上再存一个日期必然与当前轮次分叉，' +
          '分叉之后没有任何依据判断该信哪个（ADR-013 §3.1）。' +
          '要转换，请先用 /api/tasks/reschedule 清空三个日期锚点。',
      )
    }
  }
  if (merged.projectId !== null && merged.projectId !== task.projectId) {
    requireProject(sources, merged.projectId)
  }

  appendEvents(db, accountId, [
    {
      type: taskUpdatedDefinition.type,
      occurredAt: write.occurredAt,
      payload: {
        taskId,
        title: merged.title,
        notes: merged.notes,
        importance: merged.importance,
        tags: [...merged.tags],
        projectId: merged.projectId,
        recurrence: merged.recurrence === null ? null : { ...merged.recurrence },
      },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

/**
 * `POST /api/tasks/:id/status`（ADR-017 §1.1）。
 *
 * 判据**唯一地**来自 `shared/tasks/state.ts` 的 `canChangeStatus`——ADR-013 §后果 明令
 * 「前端据同一份判据禁用非法按钮，服务端据同一份判据产出 409」，两处各写一份必然漂移，
 * 漂移的症状是「按钮是亮的、点下去报错」。
 *
 * **`已完成 → 已放弃` 走的就是这里**：它是**一条事件**（`task/status-changed`），
 * **不取消任何完成记录**（ADR-013 §2）。`TaskStatus` 里没有 `completed`
 * ——「已完成」是实例的属性，故这条迁移与「未开始 → 已放弃」是同一条边，不需要分支。
 *
 * **同值（无操作）照收**（`canChangeStatus` 的 `noop`）：事件只带 `to`、本身幂等，
 * 拒掉它会让客户端重试一个「响应丢失但服务端已写入」的请求时拿到 409。
 */
export function changeTaskStatus(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  to: TaskStatus,
): { task: TaskView } {
  assertInTransaction(db, '修改任务状态')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireLiveTask(sources, taskId)

  assertAllowed(canChangeStatus({ from: task.status, to, recurring: task.recurrence !== null }))

  appendEvents(db, accountId, [
    {
      type: taskStatusChangedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, to },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

/**
 * `POST /api/tasks/reschedule`（ADR-017 §9：**只有批量一条路径**，单条即 `length === 1`）。
 *
 * ## 一个请求 = 一个批次
 *
 * N 条 `task/rescheduled` 事件共用一次 `appendEvents` 给出的 `batchId`，于是
 * 「撤销刚才那次顺延」是一次撤销（FR3 的直接要求），且**原子**：`items` 里任一任务
 * 不存在、跨账号、已删除或是重复任务 → **整批失败、一条都不写**。部分成功会让用户看到
 * 「一半挪了一半没挪」，而他无从知道是哪一半。原子性在这里是**结构**的：全部 item
 * 先校验完，再一次性调 `appendEvents`（它本身也是「整批校验先行，任一条不合法就一个字都不写」）。
 *
 * ## 三个日期字段「省略 = 保持原值，`null` = 清空」
 *
 * ⚠️ **ADR-017 §9 只给了请求体的形状**（`{ taskId, plannedDate, plannedWeek, dueDate }`），
 * 没说省略时怎么办。这里取「省略 = 保持原值」，理由是另一条路会**静默毁数据**：
 * 若把省略当成 `null`，「把这条任务顺延到今天」这个最常见的动作会**顺带清掉期限**，
 * 而调用方完全没有表达过这个意图。要清空就显式给 `null`——它只有一个含义。
 *
 * ## 无变化的 item **不写事件**
 *
 * `carryCount` 是 `task/rescheduled` 事件的**条数**（ADR-013 §4.3），而它的用途是
 * 「一次完成率」这类统计：把「挪到今天、而它本来就在今天」记成一次顺延，
 * 会凭空给这条任务加一次「拖过」。故前后值完全相同的 item 被跳过（响应里照常返回该任务）。
 */
export function rescheduleTasks(
  db: Db,
  accountId: string,
  now: Date,
  items: readonly RescheduleItem[],
): { tasks: TaskView[] } {
  assertInTransaction(db, '批量顺延')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)

  // ── 整批校验先行（只读，不写）──────────────────────────────────
  const seen = new Set<string>()
  const drafts: {
    type: string
    occurredAt: string
    payload: unknown
    dayKey: DayKey
    dayStartHour: number
  }[] = []

  for (const item of items) {
    if (seen.has(item.taskId)) {
      throw invalidInput(
        `任务 '${item.taskId}' 在 items 里出现了两次：同一批次内两条顺延的前后值会互相矛盾` +
          '（第二条的「原定值」在写入前就已经过时），故拒绝整批。',
      )
    }
    seen.add(item.taskId)

    const task = requireLiveTask(sources, item.taskId)
    assertAllowed(canRescheduleTask({ recurrence: task.recurrence }))

    const to = {
      plannedDate: item.plannedDate === undefined ? task.plannedDate : item.plannedDate,
      plannedWeek: item.plannedWeek === undefined ? task.plannedWeek : item.plannedWeek,
      dueDate: item.dueDate === undefined ? task.dueDate : item.dueDate,
    }
    const unchanged =
      to.plannedDate === task.plannedDate &&
      to.plannedWeek === task.plannedWeek &&
      to.dueDate === task.dueDate
    if (unchanged) continue

    drafts.push({
      type: taskRescheduledDefinition.type,
      occurredAt: write.occurredAt,
      // 六个日期字段**全显式**（三对前后值）：重放无需 diff，且「原定 X → 现 Y」的呈现
      // 不必回溯事件历史（FR2.7 要求展示它）。
      payload: {
        taskId: task.id,
        fromPlannedDate: task.plannedDate,
        toPlannedDate: to.plannedDate,
        fromPlannedWeek: task.plannedWeek,
        toPlannedWeek: to.plannedWeek,
        fromDueDate: task.dueDate,
        toDueDate: to.dueDate,
      },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    })
  }

  if (drafts.length > 0) appendEvents(db, accountId, drafts)

  const after = loadTaskSources(db, accountId)
  return { tasks: items.map((item) => viewOf(requireTaskIn(after, item.taskId))) }
}

/**
 * `POST /api/tasks/:id/order`（ADR-013 §4.5）。
 *
 * `manualOrder` 是 `REAL`：插入两条之间取中值，**避免「插一条要改后面所有行」**。
 * 它是这个字段**唯一**的写入者（§4.2「一个字段只有一个写入者」）。
 */
export function reorderTask(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  manualOrder: number,
): { task: TaskView } {
  assertInTransaction(db, '手动排序')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  requireLiveTask(sources, taskId)

  appendEvents(db, accountId, [
    {
      type: taskReorderedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, manualOrder },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

/**
 * `DELETE /api/tasks/:id`（ADR-013 §4.8：**软删除**）。
 *
 * `deletedAt` 置位、任务从所有视图消失，**但行还在、事件流水保留**。
 * 载荷**只有标识、不带快照**——软删除下行还在，多存一份就是第二个真相。
 *
 * 返回 `{ taskId, batchId }`：`batchId` 就是撤销删除的入参（`POST /api/undo`）。
 * 「撤销删除 = 撤销该批次」**不设 `task/restored`**——恢复已有机制覆盖，
 * 多一个事件类型就多一条可以与之冲突的路径。
 */
export function deleteTask(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
): { taskId: string; batchId: string } {
  assertInTransaction(db, '删除任务')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  requireLiveTask(sources, taskId)

  const appended = appendEvents(db, accountId, [
    {
      type: taskDeletedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])
  const batchId = appended[0]?.batchId
  if (batchId === undefined) {
    throw new Error('删除事件没有写进流水：这是事件层的不变式被破坏（ADR-010 §3）。')
  }
  return { taskId, batchId }
}

/**
 * `POST /api/tasks/:id/occurrences/:key/complete`（ADR-013 §4.6）。
 *
 * ## 响应里**没有 `created`**
 *
 * 与 `POST /api/tasks` 不同（ADR-017 §1.1 的明文）：重复完成与取消一个未完成的实例
 * 都被 §2 定为 `409`，故**不存在「已经就是这样」的成功路径**，`created: false` 不可达。
 * 留一个恒为 `true` 的字段会让调用方以为存在幂等分支——**不可达的分支不该出现在契约里**。
 *
 * ## `next` 在**写入时刻**算好并固化
 *
 * `next` 是「本轮的下一轮锚点」（ADR-011 §5 的三锚点，`catch_up` 为默认）：从 `P`
 * （本轮原计划日）按规则推进到 `> 完成日` 的第一个命中日。`next === null` 的两种情形
 * （非重复任务、规则已终止）在读取方需要知道的**全部信息**上等价，故合并成一个取值
 * （ADR-013 §4.6）；**不填越界日期充数**。
 *
 * ## 校验顺序（先 404 后 409）
 *
 * 任务不存在 → `404`；`:key` 不是该任务的实例 → `404`；状态不允许 → `409`。
 * 「实例不存在」排在状态判定之前：一个拼错的 key 若拿到 `409 已放弃`，
 * 排查方向会被引到状态上，而真正的问题在 key。
 */
export function completeOccurrence(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  key: DayKey,
): { item: TodoItem } {
  assertInTransaction(db, '完成实例')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireTaskIn(sources, taskId)
  const events = occurrenceEventsOf(sources.events)
  requireRound(task, events, write.today, key)

  assertAllowed(
    canCompleteOccurrence({ task, instanceCompleted: isCompleted(task, events, key) }),
  )

  appendEvents(db, accountId, [
    {
      type: taskOccurrenceCompletedDefinition.type,
      occurredAt: write.occurredAt,
      payload: {
        taskId,
        originalPlannedDate: key,
        // 完成时刻的归属日 = 本事件自己的 `day_key`（同一份固化事实的两半，故显式给出）。
        completedDayKey: write.today,
        next: nextAnchorFor(task, key, write.today),
      },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { item: rebuildItemAfterWrite(db, accountId, taskId, write.today) }
}

/**
 * `POST /api/tasks/:id/occurrences/:key/uncomplete`（ADR-013 §4.7）。
 *
 * 它是**追加一条事件**，不是删除 `task/occurrence-completed`——
 * FR2.1 的「取消完成支持，且**不抹除任何历史记录**」。
 *
 * ⚠️ **已放弃 / 已删除的任务也能取消完成**（`shared/tasks/state.ts` 的裁决）：
 * 放弃与完成态**正交**，而「误点了完成」需要一个更正入口。故本函数**不**要求任务未删除，
 * 只要求它存在（不存在 → `404`）——这与完成路径不同，后者对已删除的任务是 `409`。
 */
export function uncompleteOccurrence(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  key: DayKey,
): { item: TodoItem } {
  assertInTransaction(db, '取消完成')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireTaskIn(sources, taskId)
  const events = occurrenceEventsOf(sources.events)
  requireRound(task, events, write.today, key)

  assertAllowed(canUncompleteOccurrence({ instanceCompleted: isCompleted(task, events, key) }))

  appendEvents(db, accountId, [
    {
      type: taskOccurrenceUncompletedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, originalPlannedDate: key },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { item: rebuildItemAfterWrite(db, accountId, taskId, write.today) }
}

// ───────────────────────── 步骤（ADR-017 §1.2） ─────────────────────────

/**
 * `POST /api/tasks/:id/steps` —— 追加到末尾。
 *
 * 步骤 id 由**服务端生成**（UUIDv7）：`§1.2` 的请求体只有 `{ title }`；而新建载荷的
 * `steps[].id` 由**客户端**生成（为的是导入保留原 id）。两处的差别是契约本身，
 * 不是疏漏——新建路径要承载「导出再导入仍是同一条任务」，给已有任务加一步没有这个问题。
 *
 * **上限与新建载荷同一口径**（ADR-017 §3 的 `steps ≤ 100`）：那条上限的判据是
 * 「单层步骤超过 100 条已不是清单」，说的是**这条任务**的步骤数，故逐次追加同样受它约束
 * ——否则绕过上限只需点 100 次。
 */
export function addStep(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  title: string,
): { task: TaskView } {
  assertInTransaction(db, '添加步骤')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireLiveTask(sources, taskId)

  if (task.steps.length >= STEP_LIMIT) {
    throw invalidInput(
      `这条任务已有 ${task.steps.length} 个步骤，达到上限 ${STEP_LIMIT}：` +
        '单层步骤超过 100 条已不是清单（ADR-017 §3）。',
    )
  }

  appendEvents(db, accountId, [
    {
      type: taskStepAddedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, step: { id: uuidv7(), title } },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

/** `PATCH /api/tasks/:id/steps/:stepId` —— 改标题（定义层）。 */
export function renameStep(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  stepId: string,
  title: string,
): { task: TaskView } {
  assertInTransaction(db, '重命名步骤')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  requireStep(requireLiveTask(sources, taskId), stepId)

  appendEvents(db, accountId, [
    {
      type: taskStepRenamedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, stepId, title },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

/**
 * `DELETE /api/tasks/:id/steps/:stepId` —— **只删定义**，勾选留在流水里（ADR-013 §4.10）。
 *
 * 故它是**软**的：撤销删除批次之后那些勾选记录原样回来（重放时按「该 stepId 是否还在
 * 定义里」过滤）。**物理删掉它们等于让一次误删不可撤销**——撤销的语义是追加事件，
 * 不是完善删除。
 */
export function removeStep(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  stepId: string,
): { task: TaskView } {
  assertInTransaction(db, '删除步骤')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  requireStep(requireLiveTask(sources, taskId), stepId)

  appendEvents(db, accountId, [
    {
      type: taskStepRemovedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, stepId },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

/**
 * `POST /api/tasks/:id/steps/:stepId/toggle`（ADR-013 §4.12）——**勾选属于某一轮实例**。
 *
 * `originalPlannedDate` **不是可选参数**（ADR-017 §1.2 的明文）：不带它服务端无从知道
 * 勾的是哪一轮，**且不回落成「任务的 `indexDate`」**——那个回落对单轮任务看起来正常，
 * 对重复任务则**每次都在勾第一轮**，症状是「勾了没反应」。
 *
 * **状态已经一致时不写事件**：事件流记的是「变化」，而重复一次相同的勾选只会把
 * `checkedAt` 往前推、状态一字不变。这也顺带让网络重试安全（与 ADR-012 §3 对打卡幂等的
 * 取舍同源：客户端无法区分「超时但服务端已写入」与「真被拒」）。
 */
export function toggleStep(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  stepId: string,
  originalPlannedDate: DayKey,
  checked: boolean,
): { item: TodoItem } {
  assertInTransaction(db, '勾选步骤')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireLiveTask(sources, taskId)
  requireStep(task, stepId)
  const events = occurrenceEventsOf(sources.events)
  requireRound(task, events, write.today, originalPlannedDate)

  const alreadyChecked = currentCheckOf(sources.events, taskId, stepId, originalPlannedDate) !== null
  if (alreadyChecked !== checked) {
    appendEvents(db, accountId, [
      {
        type: taskStepToggledDefinition.type,
        occurredAt: write.occurredAt,
        payload: {
          taskId,
          stepId,
          originalPlannedDate,
          // 时间戳自带布尔（非 null 即已勾选），取消勾选就是 `null`
          // ——不引入 `checked: boolean`（ADR-013 §4.12 的 Joplin 哨兵值教训）。
          checkedAt: checked ? write.occurredAt : null,
        },
        dayKey: write.dayKey,
        dayStartHour: write.dayStartHour,
      },
    ])
  }

  return { item: rebuildItemAfterWrite(db, accountId, taskId, write.today) }
}

/**
 * `PUT /api/tasks/:id/steps/order` —— stepId 的**完整新顺序**（ADR-013 §4.13）。
 *
 * **集合相等是硬要求**（ADR-017 §3）：「未出现在 `order` 里的步骤」若被允许，它就处于
 * 未定义状态——实现者会各自选择「保留原位置」或「删除」，**而两种选择都不报错**。
 * 少一个、多一个、有重复，三者都 `400`；**集合相同而顺序不同必须成功**（那正是这条路由的用途）。
 */
export function reorderSteps(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  order: readonly string[],
): { task: TaskView } {
  assertInTransaction(db, '步骤重排')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const task = requireLiveTask(sources, taskId)

  const existing = new Set(task.steps.map((step) => step.id))
  const given = new Set(order)
  const missing = [...existing].filter((id) => !given.has(id))
  const extra = [...given].filter((id) => !existing.has(id))
  if (order.length !== given.size || missing.length > 0 || extra.length > 0) {
    throw invalidInput(
      'order 必须与该任务现存步骤的 id 集合**完全相等**（不多、不少、不重复）：' +
        `现有 ${existing.size} 个、给出 ${order.length} 个` +
        (missing.length > 0 ? `、缺少 ${missing.join(' / ')}` : '') +
        (extra.length > 0 ? `、多出 ${extra.join(' / ')}` : '') +
        '。未列出的步骤会处于未定义位置，故集合不等即拒绝（ADR-017 §3）。',
    )
  }

  appendEvents(db, accountId, [
    {
      type: taskStepsReorderedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { taskId, order: [...order] },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { task: viewOf(reloadTask(db, accountId, taskId)) }
}

// ───────────────────────── 内部 ─────────────────────────

/** 步骤数上限（ADR-017 §3 的 `steps` 一行；追加路径同样受它约束，见 `addStep`） */
const STEP_LIMIT = 100

interface WriteContext {
  /** 事件行与载荷共用的发生时刻（账号时区的 ISO 8601） */
  occurredAt: string
  /** 本次动作的归属日——事件的 `day_key` 与载荷里的「完成日」都是它 */
  dayKey: DayKey
  dayStartHour: number
  today: DayKey
}

/** 账号设置 + 时刻 → 写入上下文（一个请求内只取一次，见文件头） */
function writeContextOf(db: Db, accountId: string, now: Date): WriteContext {
  const settings = loadAccountSettings(db, accountId)
  const ctx = timeContextOf(settings)
  const dayKey = accountToday(ctx, now)
  return {
    occurredAt: toIsoInZone(now, settings.timeZone),
    dayKey,
    dayStartHour: settings.dayStartHour,
    today: dayKey,
  }
}

/** 只读路径用的 `today`（不写事件，故不需要 `occurredAt`） */
function todayOf(db: Db, accountId: string, now: Date): DayKey {
  return accountToday(timeContextOf(loadAccountSettings(db, accountId)), now)
}

function requireTaskIn(sources: TaskSources, taskId: string): ProjectedTask {
  const task = findTask(sources.projection, taskId)
  if (task === undefined) throw notFound(`任务不存在（${taskId}）`)
  return task
}

/**
 * 任务必须存在**且未删除**（明细 / 修改 / 删除 / 步骤 / 顺延用）。
 *
 * 「跨账号」与「不存在」返回**同一个响应**（ADR-017 §2）：投影已经是**当前账号**的，
 * 故「找不到」天然覆盖两种情形，无需再区分——403 会泄露「该资源存在但不属于你」。
 */
function requireLiveTask(sources: TaskSources, taskId: string): ProjectedTask {
  const task = requireTaskIn(sources, taskId)
  if (task.deletedAt !== null) throw notFound(`任务不存在（${taskId}）`)
  return task
}

function requireStep(task: ProjectedTask, stepId: string): Step {
  const step = task.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) throw notFound(`步骤不存在（${stepId}）`)
  return step
}

/** 项目必须存在**且未删除**（ADR-016 §6 的「写入前」那一层） */
function requireProject(sources: TaskSources, projectId: string) {
  const project = sources.projection.projects.find((row) => row.id === projectId)
  if (project === undefined || project.deletedAt !== null) {
    // **不区分「不存在」「已删除」与「属于其它账号」**：三者同码，避免泄露存在性
    // （ADR-016 §5.4 / §6 的明文）。
    throw invalidInput(`项目不存在或不可用（${projectId}）`)
  }
  return project
}

/**
 * `:key` 必须是该任务**真实存在的实例**（ADR-013 §2 的实例键）。
 *
 * 判据是 `roundsOf`：非重复任务恒为一条（键 = `indexDate`），重复任务由 `deriveRounds`
 * 给出（已完成轮次 + 至多一条待完成轮次）。
 *
 * **为什么必须校验**：不校验就会写出一条指向「不存在的轮次」的完成事件，而它不报错——
 * `resolveInstance` 对非重复任务恒取 `indexDate`，于是那条事件永远不显示，
 * 用户看到的是「点了完成但没反应」。
 */
function requireRound(
  task: ProjectedTask,
  events: TodoReadInput['events'],
  today: DayKey,
  key: DayKey,
): Round {
  const round = roundsOf(task, events, today).find((row) => row.originalPlannedDate === key)
  if (round === undefined) {
    throw notFound(`实例不存在（任务 ${task.id} 没有原计划日期为 '${key}' 的轮次）`)
  }
  return round
}

/** 该实例当前是否已完成（`effectiveCompletions`：每键取**最后一条**事件，ADR-015 §2） */
function isCompleted(task: ProjectedTask, events: TodoReadInput['events'], key: DayKey): boolean {
  return effectiveCompletions(task, events).some(
    (completion) => completion.payload.originalPlannedDate === key,
  )
}

/**
 * 写入时刻算出的**下一轮锚点**（ADR-011 §5；ADR-013 §4.6 的固化值）。
 *
 * 非重复任务恒为 `null`（它没有下一轮）；重复任务按 `nextAnchorMode` 算，规则已终止
 * （达到 `count` 或越过 `until`）时同样是 `null`。两种情形在读取方需要知道的**全部信息**
 * 上等价，故合并成一个取值（ADR-013 §4.6）。
 */
function nextAnchorFor(
  task: ProjectedTask,
  key: DayKey,
  completedDayKey: DayKey,
): { date: DayKey; mode: NextAnchorMode } | null {
  const spec = task.recurrence
  if (spec === null) return null
  const date = nextAnchorDate(spec.nextAnchorMode, {
    rule: spec.rule,
    startsOn: spec.startsOn,
    plannedDate: key,
    completedDayKey,
  })
  if (date === null) return null
  return { date, mode: spec.nextAnchorMode }
}

/** 该轮次上某步骤当前的勾选时刻（`null` = 未勾选）；折叠规则见 `sources.stepChecksOf` */
function currentCheckOf(
  events: TaskSources['events'],
  taskId: string,
  stepId: string,
  occurrenceKey: DayKey,
): string | null {
  for (const check of stepChecksOf(events)) {
    if (check.taskId === taskId && check.stepId === stepId && check.occurrenceKey === occurrenceKey) {
      return check.checkedAt
    }
  }
  return null
}

/**
 * 读模型的行 —— `buildTodoItems` **外加出错时的归因**。
 *
 * 正常路径原样走 `shared/tasks` 的实现（**不复制**它那条 `deletedAt` 过滤：
 * 复制之后，`shared/` 改了过滤规则而这里没改，两份就会分叉，且不会有任何症状）。
 * 只有抛 `AnchorInvariantError` 时才逐条重试一次，找出是**哪条任务**坏了——
 * 那次重试**只为日志**（ADR-017 §2 要求日志里同时有 `taskId` 与 `originalPlannedDate`），
 * 控制流与结果都不变：找到就把同一个错误对象（附上 `taskId`）抛出，找不到就原样抛出。
 */
function buildItems(input: TodoReadInput): TodoItem[] {
  try {
    return buildTodoItems(input)
  } catch (error) {
    if (error instanceof AnchorInvariantError) throw locateAnchorError(input, error)
    throw error
  }
}

/** 逐条重试以定位是哪条任务的锚点坏了（只在失败路径上跑；结果确定，见 `buildItems`） */
function locateAnchorError(input: TodoReadInput, error: AnchorInvariantError): Error {
  for (const task of input.tasks) {
    try {
      buildTodoItem(input, task)
    } catch (inner) {
      if (inner instanceof AnchorInvariantError) return withTaskId(inner, task.id)
    }
  }
  return error
}

/** 写完之后**重新读**投影与流水，返回该任务当前那一行（响应即「动作之后的状态」） */
function rebuildItemAfterWrite(db: Db, accountId: string, taskId: string, today: DayKey): TodoItem {
  const sources = loadTaskSources(db, accountId)
  return buildItem(todoInputOf(sources, today), requireTaskIn(sources, taskId))
}

/** 写完之后重新读该任务行（`{ task }` 型响应用） */
function reloadTask(db: Db, accountId: string, taskId: string): ProjectedTask {
  return requireTaskIn(loadTaskSources(db, accountId), taskId)
}

function viewOf(task: ProjectedTask): TaskView {
  // 逐字段显式构造：`accountId` 不外泄（响应体「一律只含当前账号的数据」）。
  return {
    taskId: task.id,
    title: task.title,
    notes: task.notes,
    importance: task.importance,
    plannedDate: task.plannedDate,
    plannedWeek: task.plannedWeek,
    dueDate: task.dueDate,
    tags: [...task.tags],
    projectId: task.projectId,
    status: task.status,
    manualOrder: task.manualOrder,
    recurrence: task.recurrence === null ? null : { ...task.recurrence },
    recurring: task.recurrence !== null,
    indexDate: task.indexDate,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    deletedAt: task.deletedAt,
    steps: task.steps.map((step) => ({ id: step.id, title: step.title })),
  }
}

/**
 * 把 `shared/tasks/state.ts` 的裁决落成 HTTP 错误。
 *
 * **文案直接用裁决里的那句**：判据与理由是同一件事的两半，判据在 `shared/` 只有一份，
 * 文案跟着它走——两处各写一句的后果是「界面禁用按钮时说的是 A、服务端 409 说的是 B」，
 * 而用户看到的是 B，于是他不知道界面为什么禁用。
 */
function assertAllowed(verdict: TaskActionVerdict): void {
  if (verdict.allowed) return
  throw rejectionError(verdict.code, verdict.message)
}

function rejectionError(code: TaskActionRejection, message: string): ApiError {
  switch (code) {
    case 'conflict/task-not-completable':
      return taskNotCompletable(message)
    case 'conflict/occurrence-already-completed':
      return occurrenceAlreadyCompleted(message)
    case 'conflict/occurrence-not-completed':
      return occurrenceNotCompleted(message)
    case 'conflict/date-driven-by-rule':
      return dateDrivenByRule(message)
    case 'conflict/status-transition':
      return statusTransition(message)
    default: {
      // 新增一个 `TaskActionRejection` 成员时这里必须有个落点——否则它会静默变成 500。
      const exhaustive: never = code
      throw new Error(`未映射的任务动作拒绝码：${String(exhaustive)}（这是实现缺口，不是输入问题）`)
    }
  }
}

/** 事件写进去了、投影却查不到——只可能是事件层坏了（非调用方所能造成），故是内部错误 */
function projectionMissing(taskId: string): Error {
  return new Error(
    `任务事件已写入，但投影里没有 '${taskId}' 这一行：` +
      '「投影 = 重放结果」这条不变式被破坏了（ADR-010 §4/§5）。',
  )
}
