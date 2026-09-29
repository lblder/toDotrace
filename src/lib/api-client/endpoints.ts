/**
 * 服务端入口 —— 一一对应 ADR-008 §2 的路由清单。
 *
 * ADR-008 的约束：**本 ADR 未列出的路由不得实现**（避免范围蔓延）。
 * 阶段 1 用到的就是这八条：六条账号路由，加 owner 管理面的邀请码两条；
 * `GET /api/members` 只为把邀请码的「被谁使用」翻成可读的名字。
 * 阶段 3 加了 ADR-012 §3 的打卡三条（见文件末尾）。
 */

import { request } from './client'
import type { DayKey } from '@shared/time'
import type { PauseTimerInput, StartTimerInput, TimerSnapshot } from '@shared/timer'
import type {
  AuthPayload,
  CheckinResult,
  CreateInvitePayload,
  CreateOwnerInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskPayload,
  DayNotePayload,
  DeletedPayload,
  InviteListPayload,
  IssueInviteInput,
  LoginInput,
  MemberListPayload,
  MePayload,
  OccurrencePayload,
  ProjectListPayload,
  ProjectRow,
  RegisterInput,
  RescheduleItem,
  ReschedulePayload,
  SetTaskStatusInput,
  SettingsPayload,
  SetupStatus,
  TaskDetailPayload,
  TaskListPayload,
  TaskPayload,
  TodayCheckin,
  UndoPayload,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
} from './types'

export const api = {
  /** GET /api/setup/status —— 无鉴权，前端据此决定是否进首启引导 */
  getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    return request<SetupStatus>({
      method: 'GET',
      path: '/api/setup/status',
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** POST /api/setup/owner —— 仅在无 owner 时可用；已有 owner 时 409 */
  createOwner(input: CreateOwnerInput): Promise<AuthPayload> {
    return request<AuthPayload>({ method: 'POST', path: '/api/setup/owner', body: input })
  },

  /** POST /api/auth/login */
  login(input: LoginInput): Promise<AuthPayload> {
    return request<AuthPayload>({ method: 'POST', path: '/api/auth/login', body: input })
  },

  /** POST /api/auth/logout —— 需要令牌，作废当前令牌，204 无响应体 */
  logout(): Promise<void> {
    return request<void>({ method: 'POST', path: '/api/auth/logout', auth: true })
  },

  /** GET /api/auth/me —— 需要令牌，前端启动时校验会话 */
  me(signal?: AbortSignal): Promise<MePayload> {
    return request<MePayload>({
      method: 'GET',
      path: '/api/auth/me',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** POST /api/auth/register —— 无鉴权，凭邀请码 */
  register(input: RegisterInput): Promise<AuthPayload> {
    return request<AuthPayload>({ method: 'POST', path: '/api/auth/register', body: input })
  },

  /* ---------------------------------------------------------------------
     owner 专属（ADR-008 §2）：服务端对非 owner 一律 403，前端据此做显隐
     --------------------------------------------------------------------- */

  /**
   * POST /api/invites —— 签发邀请码。
   * 响应里的 `invite.code` 是**明文唯一一次出现**；列表接口不会再有它。
   */
  createInvite(input: IssueInviteInput): Promise<CreateInvitePayload> {
    return request<CreateInvitePayload>({
      method: 'POST',
      path: '/api/invites',
      body: input,
      auth: true,
    })
  },

  /** GET /api/invites —— 本账号签发过的邀请码元信息（不含 code） */
  listInvites(signal?: AbortSignal): Promise<InviteListPayload> {
    return request<InviteListPayload>({
      method: 'GET',
      path: '/api/invites',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** GET /api/members —— 只为把 usedBy 的 uuid 翻成显示名 */
  listMembers(signal?: AbortSignal): Promise<MemberListPayload> {
    return request<MemberListPayload>({
      method: 'GET',
      path: '/api/members',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /* ---------------------------------------------------------------------
     打卡（ADR-012 §3）—— 全部需鉴权，响应只含本账号的数据
     --------------------------------------------------------------------- */

  /**
   * POST /api/checkin/arrive —— 记录「今日到达」。
   *
   * **不带请求体**（§3：两个 POST 都不接受请求体）。发生时刻由服务端取 `now`、
   * 归属日由 `shared/time` 折算——客户端指定时刻等于开放「补记任意历史打卡」，
   * 01 FR1 没有要求这个能力，所以客户端这边连表达它的方式都不留。
   */
  arriveCheckin(): Promise<CheckinResult> {
    return request<CheckinResult>({ method: 'POST', path: '/api/checkin/arrive', auth: true })
  },

  /**
   * POST /api/checkin/leave —— 闭合最近一次到达（同样不带请求体）。
   *
   * 分流键是「**有无到达**」而不是「有无未闭合的到达」（ADR-012 §5，v1.2 的裁决）：
   *   · 账户从无到达 → `409 conflict/not-arrived`（没有可配对的到达，也就无从知道记哪一天）；
   *   · 最近那条到达已闭合 → **200，`created: false`，返回该行**——重复点击与网络重试
   *     都走幂等而不是报错，界面据此如实说出第一次记录的时刻。
   * 这两种情形在投影上本是同一个状态，只有换掉分流键才能让幂等与 409 同时成立。
   */
  awayCheckin(): Promise<CheckinResult> {
    return request<CheckinResult>({ method: 'POST', path: '/api/checkin/away', auth: true })
  },
  returnCheckin(): Promise<CheckinResult> {
    return request<CheckinResult>({ method: 'POST', path: '/api/checkin/return', auth: true })
  },
  correctDeparture(dayKey: string, leftAt: string): Promise<TodayCheckin> {
    return request<TodayCheckin>({ method: 'PUT', path: `/api/checkin/days/${encodeURIComponent(dayKey)}/departure`, auth: true, body: { leftAt } })
  },
  leaveCheckin(): Promise<CheckinResult> {
    return request<CheckinResult>({ method: 'POST', path: '/api/checkin/leave', auth: true })
  },

  /**
   * GET /api/checkin/today —— 今日状态与连续天数。
   *
   * `streak` 由服务端按 `shared/checkin` 的口径算好（ADR-012 §6），
   * 前端**不再自己算一遍**：同一个数字两个实现就是两个真相，
   * 而 §5 删掉 `isRestDay` 字段正是为了这个理由。
   */
  getTodayCheckin(signal?: AbortSignal): Promise<TodayCheckin> {
    return request<TodayCheckin>({
      method: 'GET',
      path: '/api/checkin/today',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /*
   * ADR-012 §3 的第四条 `GET /api/checkin/days?from=&to=` 本阶段不在此实现：
   * 它服务的用例（范围统计、热力图）分别属阶段 6 与后续阶段，而本阶段界面
   * 只用得到 /today。契约里 `from`/`to` 均必填、返回升序这类约定是服务端
   * 必须满足的，不是「客户端先备着」的理由——留到真正调用它的那一阶段再加。
   */

  /* ---------------------------------------------------------------------
     阶段 4（ADR-017 §1）—— 全部需鉴权，响应只含本账号的数据
     --------------------------------------------------------------------- */

  /**
   * GET /api/tasks —— 既有五种 scope 加逐实例的 `completed` 历史视图。
   *
   * ⚠️ **排序与筛选不走服务端参数**（ADR-017 §1.1）：既有五种视图按 ADR-015 §4 的
   * 默认顺序返回，历史完成视图按 completedAt 倒序；交互式换序与筛选由前端处理。
   * 那两份是同一份纯函数——**组件里不得重写排序**（ADR-015 §7）。
   *
   * `scope=today` 是 ADR-015 §3 的入选规则 A–F；`week` / `range` 是区间判定；
   * **`project` 是归属判定（`item.projectId === projectId`），不是区间判定**。
   */
  listTasks(query: TaskListQuery, signal?: AbortSignal): Promise<TaskListPayload> {
    return request<TaskListPayload>({
      method: 'GET',
      path: `/api/tasks?${taskListSearch(query)}`,
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** GET /api/tasks/:id —— 明细页用（`occurrences` 的形状 ADR-017 未定义，界面不消费） */
  getTask(taskId: string, signal?: AbortSignal): Promise<TaskDetailPayload> {
    return request<TaskDetailPayload>({
      method: 'GET',
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /**
   * POST /api/tasks —— 新建。
   *
   * **`taskId` 由客户端生成**（ADR-017 §5）：不是为了幂等，而是为了让新建与导入
   * 走同一条代码路径（ADR-010 §3 要求导入保留原 id）。幂等是顺带收益：
   * 双击提交不会产生两条任务。
   */
  createTask(input: CreateTaskInput): Promise<CreateTaskPayload> {
    return request<CreateTaskPayload>({ method: 'POST', path: '/api/tasks', body: input, auth: true })
  },

  /**
   * PATCH /api/tasks/:id —— **整行快照**，不是差量（ADR-017 §4）。
   *
   * 与 HTTP 惯例不符是有意的：事件载荷是整行，服务端若接受差量就得先合并再写，
   * 而那次合并不体现在任何事件上（ADR-013 §4.2）。
   */
  updateTask(taskId: string, input: UpdateTaskInput): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'PATCH',
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      body: input,
      auth: true,
    })
  },

  /**
   * POST /api/tasks/:id/status —— 任务级意图态迁移（ADR-013 §2）。
   *
   * **只由用户显式动作触发**：`to: 'in_progress'` 绝不自动推断——打开详情、
   * 设日期、建子任务都不改变状态（01 FR2.1 v1.3）。
   */
  setTaskStatus(taskId: string, input: SetTaskStatusInput): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/status`,
      body: input,
      auth: true,
    })
  },

  /**
   * POST /api/tasks/reschedule —— 顺延，**只有批量一条路径**（ADR-017 §9）：
   * 单条即 `items.length === 1`。一个请求 = 一个批次 ≠ 一次撤销。
   */
  rescheduleTasks(items: readonly RescheduleItem[]): Promise<ReschedulePayload> {
    return request<ReschedulePayload>({
      method: 'POST',
      path: '/api/tasks/reschedule',
      body: { items },
      auth: true,
    })
  },

  /** POST /api/tasks/:id/order —— 手动排序位置的**唯一写入者**（ADR-013 §4.5） */
  reorderTask(taskId: string, manualOrder: number): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/order`,
      body: { manualOrder },
      auth: true,
    })
  },

  /** DELETE /api/tasks/:id —— **软删除**；`batchId` 是撤销它的钥匙（ADR-017 §8） */
  deleteTask(taskId: string): Promise<DeletedPayload> {
    return request<DeletedPayload>({
      method: 'DELETE',
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      auth: true,
    })
  },

  /** POST /api/tasks/:id/occurrences/:key/complete —— 路径里的 `:key` 就是实例键 */
  completeOccurrence(taskId: string, occurrenceKey: string): Promise<OccurrencePayload> {
    return request<OccurrencePayload>({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceKey)}/complete`,
      auth: true,
    })
  },

  /** POST /api/tasks/:id/occurrences/:key/uncomplete —— **追加一条事件，不是删除** */
  uncompleteOccurrence(taskId: string, occurrenceKey: string): Promise<OccurrencePayload> {
    return request<OccurrencePayload>({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceKey)}/uncomplete`,
      auth: true,
    })
  },

  /** 任务计时由服务端事件折叠，刷新和跨日都沿用同一运行片段。 */
  getTimer(signal?: AbortSignal): Promise<TimerSnapshot> {
    return request<TimerSnapshot>({
      method: 'GET',
      path: '/api/timer',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  configureTimer(taskId: string, enabled: boolean): Promise<TimerSnapshot> {
    return request<TimerSnapshot>({
      method: 'PUT',
      path: `/api/timer/tasks/${encodeURIComponent(taskId)}`,
      body: { enabled },
      auth: true,
    })
  },

  startTimer(input: StartTimerInput): Promise<TimerSnapshot> {
    return request<TimerSnapshot>({ method: 'POST', path: '/api/timer/start', body: input, auth: true })
  },

  pauseTimer(input: PauseTimerInput): Promise<TimerSnapshot> {
    return request<TimerSnapshot>({ method: 'POST', path: '/api/timer/pause', body: input, auth: true })
  },

  /* --- 步骤（ADR-017 §1.2） --------------------------------------------- */

  addStep(taskId: string, title: string): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/steps`,
      body: { title },
      auth: true,
    })
  },

  renameStep(taskId: string, stepId: string, title: string): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'PATCH',
      path: `/api/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}`,
      body: { title },
      auth: true,
    })
  },

  /** DELETE /api/tasks/:id/steps/:stepId —— **只删定义**，勾选留在流水里（ADR-013 §4.10） */
  deleteStep(taskId: string, stepId: string): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'DELETE',
      path: `/api/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}`,
      auth: true,
    })
  },

  /**
   * POST /api/tasks/:id/steps/:stepId/toggle —— 勾选**属于某一轮实例**（ADR-013 §4.12）。
   *
   * ⚠️ **`originalPlannedDate` 是必填的**（ADR-017 §1.2）：不带它服务端无从知道
   * 勾的是哪一轮。**不回落成「任务的 `indexDate`」**——那样的回落对单轮任务看起来
   * 正常，对重复任务则**每次都在勾第一轮**，症状是「勾了没反应」。
   * 故本方法的入参是**必填的具名参数**，不是可选项。
   */
  toggleStep(
    taskId: string,
    stepId: string,
    input: { readonly originalPlannedDate: DayKey; readonly checked: boolean },
  ): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/toggle`,
      body: input,
      auth: true,
    })
  },

  /** PUT /api/tasks/:id/steps/order —— `order` 必须与该任务现存 stepId **集合相等** */
  reorderSteps(taskId: string, order: readonly string[]): Promise<TaskPayload> {
    return request<TaskPayload>({
      method: 'PUT',
      path: `/api/tasks/${encodeURIComponent(taskId)}/steps/order`,
      body: { order },
      auth: true,
    })
  },

  /* --- 项目（ADR-017 §1.3；语义见 ADR-016） ------------------------------ */

  listProjects(signal?: AbortSignal): Promise<ProjectListPayload> {
    return request<ProjectListPayload>({
      method: 'GET',
      path: '/api/projects',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** PUT /api/projects/order —— 提交当前账号全部未归档、未删除项目的完整显示顺序。 */
  reorderProjects(projectIds: readonly string[]): Promise<ProjectListPayload> {
    return request<ProjectListPayload>({
      method: 'PUT',
      path: '/api/projects/order',
      body: { projectIds },
      auth: true,
    })
  },

  createProject(input: CreateProjectInput): Promise<{ project: ProjectRow }> {
    return request<{ project: ProjectRow }>({
      method: 'POST',
      path: '/api/projects',
      body: input,
      auth: true,
    })
  },

  updateProject(projectId: string, input: UpdateProjectInput): Promise<{ project: ProjectRow }> {
    return request<{ project: ProjectRow }>({
      method: 'PATCH',
      path: `/api/projects/${encodeURIComponent(projectId)}`,
      body: input,
      auth: true,
    })
  },

  /** 归档保留项目和任务历史，恢复后重新进入活跃项目列表。 */
  setProjectArchived(projectId: string, archived: boolean): Promise<{ project: ProjectRow }> {
    return request<{ project: ProjectRow }>({
      method: 'PATCH',
      path: `/api/projects/${encodeURIComponent(projectId)}/archive`,
      body: { archived },
      auth: true,
    })
  },

  deleteProject(projectId: string): Promise<DeletedPayload> {
    return request<DeletedPayload>({
      method: 'DELETE',
      path: `/api/projects/${encodeURIComponent(projectId)}`,
      auth: true,
    })
  },

  /** POST /api/projects/:id/activate —— 切换当前项目（**绝不参与归属推导**，ADR-016 §4） */
  activateProject(projectId: string): Promise<{ project: ProjectRow }> {
    return request<{ project: ProjectRow }>({
      method: 'POST',
      path: `/api/projects/${encodeURIComponent(projectId)}/activate`,
      auth: true,
    })
  },

  /** DELETE /api/projects/current —— 显式取消当前项目（ADR-017 §1.3 明写「必需」） */
  clearCurrentProject(): Promise<{ currentProjectId: null }> {
    return request<{ currentProjectId: null }>({
      method: 'DELETE',
      path: '/api/projects/current',
      auth: true,
    })
  },

  /* --- 每日备注（ADR-017 §1.4） ----------------------------------------- */

  getDayNote(dayKey: DayKey, signal?: AbortSignal): Promise<DayNotePayload> {
    return request<DayNotePayload>({
      method: 'GET',
      path: `/api/checkin/days/${encodeURIComponent(dayKey)}/note`,
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  /** PUT —— `text: ''` 即清除备注（能用一个值表示的状态不要用两个，ADR-013 §6） */
  putDayNote(dayKey: DayKey, text: string): Promise<DayNotePayload> {
    return request<DayNotePayload>({
      method: 'PUT',
      path: `/api/checkin/days/${encodeURIComponent(dayKey)}/note`,
      body: { text },
      auth: true,
    })
  },

  /* --- 设置（ADR-017 §1.5 / §7） ---------------------------------------- */

  getSettings(signal?: AbortSignal): Promise<SettingsPayload> {
    return request<SettingsPayload>({
      method: 'GET',
      path: '/api/settings',
      auth: true,
      ...(signal === undefined ? {} : { signal }),
    })
  },

  patchSettings(input: UpdateSettingsInput): Promise<SettingsPayload> {
    return request<SettingsPayload>({
      method: 'PATCH',
      path: '/api/settings',
      body: input,
      auth: true,
    })
  },

  /* --- 撤销（ADR-017 §8） ------------------------------------------------ */

  /**
   * POST /api/undo —— 按批次撤销（ADR-006）。
   *
   * **不做 30 秒窗口的服务端强制**（FR3：那是界面提示时长，不是服务端能力边界）。
   * 窗口是**界面**的事，故「撤销」按钮的消失时机由组件自己掌握。
   */
  undo(batchId: string): Promise<UndoPayload> {
    return request<UndoPayload>({
      method: 'POST',
      path: '/api/undo',
      body: { batchId },
      auth: true,
    })
  },
} as const

/** `GET /api/tasks` 的查询（既有五种 scope + 逐完成实例的 completed） */
export type TaskListQuery =
  | { readonly scope: 'today' | 'all' | 'completed' }
  | { readonly scope: 'week' }
  | { readonly scope: 'range'; readonly from: DayKey; readonly to: DayKey }
  | { readonly scope: 'project'; readonly projectId: string }

/**
 * 查询串的拼装只有这一处。
 *
 * `encodeURIComponent` 不是形式：`projectId` 与 `from`/`to` 都来自本应用，
 * 但把「值直接拼进 URL」写成惯例之后，第一个例外就会是静默的错误请求。
 */
function taskListSearch(query: TaskListQuery): string {
  const parts = [`scope=${query.scope}`]
  if (query.scope === 'range') {
    parts.push(`from=${encodeURIComponent(query.from)}`, `to=${encodeURIComponent(query.to)}`)
  }
  if (query.scope === 'project') {
    parts.push(`projectId=${encodeURIComponent(query.projectId)}`)
  }
  return parts.join('&')
}

export type Api = typeof api
