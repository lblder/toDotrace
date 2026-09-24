import type { Db } from '../db/connection.js'
import { compareDayKey, today as accountToday, toIsoInZone } from '@shared/time'
import type { DayKey } from '@shared/time'
import { projectState } from '@shared/plan'
import type { ProjectedProject } from '../events/types.js'
import type { EventDraft } from '../events/types.js'
import { appendEvents } from '../events/append.js'
import {
  projectCreatedDefinition,
  projectArchiveChangedDefinition,
  projectCurrentChangedDefinition,
  projectDeletedDefinition,
  projectOrderDefinition,
  projectUpdatedDefinition,
  type ProjectOrderPayload,
  type ProjectArchiveChangedPayload,
} from '../events/index.js'
import { loadAccountSettings } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import { invalidInput, notFound } from '../lib/errors.js'
import { loadTaskSources } from '../tasks/sources.js'

/**
 * 项目的域逻辑（ADR-017 §1.3；语义见 ADR-016 §4 / §5 / §6）。
 *
 * ## 六条路由与四类事件（ADR-016 §10 的对照表）
 *
 * | 路由 | 事件 |
 * |---|---|
 * | `POST /api/projects` | `project/created`（+ 同批次的 `project/current-changed`，若要求设为当前） |
 * | `PATCH /api/projects/:id` | `project/updated`（**整行快照**） |
 * | `DELETE /api/projects/:id` | `project/deleted`（软删除） |
 * | `POST /api/projects/:id/activate` | `project/current-changed { projectId }` |
 * | `DELETE /api/projects/current` | `project/current-changed { projectId: null }` |
 * | `GET /api/projects` | —（只读） |
 *
 * ## 三条纪律
 *
 * 1. **`PATCH` 收差量、事件载荷是整行快照**（ADR-017 §1.3 注 + ADR-016 §5.2）：
 *    服务层先读当前行、合成为整行、再写。**不得把差量直接写进事件载荷**——那会让重放
 *    依赖「前一条事件一定在」，而撤销与合并导入都可能让它不在；
 * 2. **`isCurrent` 只有一个来源**（ADR-016 §5.2 的「一个字段只有一个写入者」）：
 *    它是 `project/current-changed` 的专职；`project/created` 的 `apply` 里恒为 `false`，
 *    `project/deleted` 顺带置 0 是**不变式**而不是第二个来源（表侧 CHECK 兜底）。
 *    故「新建并设为当前」是**同一批次里的两条事件**；
 * 3. **项目永不物理删除**：软删除下行还在，于是「删项目后其下任务的 `projectId` 仍可解析」
 *    这件事不需要任何额外机制——**任务一条都不动**（ADR-016 §6 的明文）。
 *
 * ## 为什么「起晚于止」在路由层也要判一次
 *
 * ADR-016 §5.1 说它「由 `projects` 表的 `CHECK (ends_on >= starts_on)` 兜底」——
 * 但那条 CHECK 是**结构兜底**，不是入口校验：用户提交一个反向区间时，
 * SQLite 会抛 `SQLITE_CONSTRAINT_CHECK`，落到 ADR-008 的错误信封之外（500）。
 * **用户输入不该得到 500**，故本层先判成 400；表侧 CHECK 原样保留（它挡的是绕过路由的写入）。
 */

/** 项目行对外的形态（`accountId` 不外泄，与任务的 `TaskView` 同一条取舍） */
export interface ProjectView {
  projectId: string
  name: string
  startsOn: DayKey
  endsOn: DayKey
  isCurrent: boolean
  /** 归档只影响导航与活跃排序，不删除项目或其下任务。 */
  archived: boolean
  /** 派生状态（ADR-016 §4：不落库） */
  state: 'upcoming' | 'active' | 'ended'
  createdAt: string
  updatedAt: string
}

export interface ProjectListResult {
  projects: ProjectView[]
  /** 当前项目标识；`null` = 没有当前项目（一个真实状态，不是错误） */
  currentProjectId: string | null
  /** 服务端算出的今日（ADR-015 §6：含日期判定的响应必须回带它，`state` 就吃它） */
  today: DayKey
}

/** `POST /api/projects` 的入参 */
export interface CreateProjectInput {
  projectId: string
  name: string
  startsOn: DayKey
  endsOn: DayKey
  /**
   * 是否顺带设为当前项目。**默认 `false`**——ADR-016 §4 的「当前项目」绝不参与归属推导，
   * 把它做成新建的副作用，等于让「新建一个项目」悄悄改变快速录入的预选对象。
   */
  makeCurrent?: boolean
}

/** `PATCH /api/projects/:id` 的差量（`isCurrent` 不在其中——它有专属路由） */
export interface ProjectPatch {
  name?: string
  startsOn?: DayKey
  endsOn?: DayKey
}

/**
 * `GET /api/projects`（ADR-017 §1.3）。
 *
 * **只返回未删除的项目**（ADR-016 §6：软删除的项目不该出现在任何清单里），
 * 未保存手动顺序前按 `(startsOn, id)` 稳定升序；保存后按最新有效
 * `project/order` 排序。后来新建的项目按创建事件顺序接在末尾。
 */
export function listProjects(db: Db, accountId: string, now: Date): ProjectListResult {
  const sources = loadTaskSources(db, accountId)
  const today = todayOf(db, accountId, now)
  const savedOrder = latestProjectOrder(sources.events)
  const archive = archiveStateOf(sources.events)
  const rank = new Map(savedOrder?.projectIds.map((id, index) => [id, index] as const) ?? [])
  const createdRank = new Map<string, number>()
  for (const [index, event] of sources.events.entries()) {
    if (event.type !== projectCreatedDefinition.type) continue
    const id = (event.payload as { projectId: string }).projectId
    createdRank.set(id, index)
  }
  const compareActive = (a: ProjectedProject, b: ProjectedProject): number => {
    if (savedOrder !== null) {
      const aRank = rank.get(a.id)
      const bRank = rank.get(b.id)
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank
      if (aRank !== undefined) return -1
      if (bRank !== undefined) return 1
      const aCreated = archive.get(a.id)?.index ?? createdRank.get(a.id)
      const bCreated = archive.get(b.id)?.index ?? createdRank.get(b.id)
      if (aCreated !== undefined && bCreated !== undefined && aCreated !== bCreated) {
        return aCreated - bCreated
      }
    }
    if (a.startsOn !== b.startsOn) return a.startsOn < b.startsOn ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
  const live = sources.projection.projects.filter((project) => project.deletedAt === null)
  const active = live.filter((project) => archive.get(project.id)?.archived !== true).sort(compareActive)
  const archived = live.filter((project) => archive.get(project.id)?.archived === true)
    .sort((a, b) => {
      const aIndex = archive.get(a.id)?.index ?? -1
      const bIndex = archive.get(b.id)?.index ?? -1
      return bIndex - aIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })
  const rows = [...active, ...archived]

  const current = active.find((project) => project.isCurrent)
  return {
    projects: rows.map((row) => viewOf(row, today, archive.get(row.id)?.archived ?? false)),
    currentProjectId: current?.id ?? null,
    today,
  }
}

interface ArchiveState {
  archived: boolean
  /** 该归档/恢复事件在有效事件序列中的位置，用于稳定排列。 */
  index: number
}

function archiveStateOf(events: readonly { type: string; payload: unknown }[]): Map<string, ArchiveState> {
  const state = new Map<string, ArchiveState>()
  for (const [index, event] of events.entries()) {
    if (event.type !== projectArchiveChangedDefinition.type) continue
    const payload = event.payload as ProjectArchiveChangedPayload
    state.set(payload.projectId, { archived: payload.archived, index })
  }
  return state
}

function latestProjectOrder(events: readonly { type: string; payload: unknown }[]): ProjectOrderPayload | null {
  let latest: ProjectOrderPayload | null = null
  for (const event of events) {
    if (event.type === projectOrderDefinition.type) latest = event.payload as ProjectOrderPayload
  }
  return latest
}

/** 提交完整当前集合，拒绝缺项、重复项和他账号项目；不改当前项目或任务归属。 */
export function reorderProjects(
  db: Db,
  accountId: string,
  now: Date,
  projectIds: readonly string[],
): ProjectListResult {
  assertInTransaction(db, '调整项目顺序')
  const sources = loadTaskSources(db, accountId)
  const archive = archiveStateOf(sources.events)
  const liveIds = sources.projection.projects
    .filter((project) => project.deletedAt === null
      && archive.get(project.id)?.archived !== true)
    .map((project) => project.id)
  const expected = new Set(liveIds)
  if (projectIds.length !== liveIds.length
    || new Set(projectIds).size !== projectIds.length
    || projectIds.some((id) => !expected.has(id))) {
    throw invalidInput('projectIds 必须完整列出当前账号所有未归档、未删除项目，且不能重复')
  }

  const saved = latestProjectOrder(sources.events)
  if (saved !== null && saved.projectIds.length === projectIds.length
    && saved.projectIds.every((id, index) => id === projectIds[index])) {
    return listProjects(db, accountId, now)
  }
  const write = writeContextOf(db, accountId, now)
  appendEvents(db, accountId, [{
    type: projectOrderDefinition.type,
    occurredAt: write.occurredAt,
    payload: { projectIds: [...projectIds] },
    dayKey: write.dayKey,
    dayStartHour: write.dayStartHour,
  }])
  return listProjects(db, accountId, now)
}

/** 归档独立于删除：任务归属、项目日期和历史都保持；归档当前项目时清空当前选择。 */
export function setProjectArchived(
  db: Db,
  accountId: string,
  now: Date,
  projectId: string,
  archived: boolean,
): { project: ProjectView } {
  assertInTransaction(db, '归档或恢复项目')
  const sources = loadTaskSources(db, accountId)
  const project = requireLiveProject(sources, projectId)
  const current = archiveStateOf(sources.events).get(projectId)?.archived ?? false
  const write = writeContextOf(db, accountId, now)
  if (current === archived) return { project: viewOf(project, write.today, current) }

  const drafts: EventDraft[] = [{
    type: projectArchiveChangedDefinition.type,
    occurredAt: write.occurredAt,
    payload: { projectId, archived },
    dayKey: write.dayKey,
    dayStartHour: write.dayStartHour,
  }]
  if (archived && project.isCurrent) {
    drafts.push({
      type: projectCurrentChangedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { projectId: null },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    })
  }
  appendEvents(db, accountId, drafts)
  const after = loadTaskSources(db, accountId)
  return { project: viewOf(requireProjectIn(after, projectId), write.today, archived) }
}

/**
 * `POST /api/projects`（ADR-017 §1.3）。
 *
 * **幂等**与 `POST /api/tasks` 同形（§5.3 的「同惯例」）：`projectId` 已存在 → 不报错、
 * 不写事件，返回既有项目与 `created: false`。
 *
 * ⚠️ **幂等的判据是「项目行是否存在」，与 `makeCurrent` 无关**：第二次请求里带着
 * `makeCurrent: true` 时**不会**因此切换当前项目——那会让「重复提交」产生第一次没有的
 * 副作用。要切当前就调 `…/activate`（它是自己的入口，语义不含混）。
 */
export function createProject(
  db: Db,
  accountId: string,
  now: Date,
  input: CreateProjectInput,
): { project: ProjectView; created: boolean } {
  assertInTransaction(db, '新建项目')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)

  const existing = sources.projection.projects.find((project) => project.id === input.projectId)
  if (existing !== undefined) {
    return {
      project: viewOf(existing, write.today,
        archiveStateOf(sources.events).get(existing.id)?.archived ?? false),
      created: false,
    }
  }
  assertRange(input.startsOn, input.endsOn)

  const drafts: EventDraft[] = [
    {
      type: projectCreatedDefinition.type,
      occurredAt: write.occurredAt,
      payload: {
        projectId: input.projectId,
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ]
  if (input.makeCurrent === true) {
    // 「新建项目并设为当前」是**同一批次里的两条事件**（ADR-016 §5.5）：代价是多一条事件，
    // 换来的是 `isCurrent` 只有一个来源——不需要在 created 的载荷里再放一份，
    // 也不需要「created 时顺带设当前」这种特例。
    drafts.push({
      type: projectCurrentChangedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { projectId: input.projectId },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    })
  }
  appendEvents(db, accountId, drafts)

  const written = requireProjectIn(loadTaskSources(db, accountId), input.projectId)
  return { project: viewOf(written, write.today, false), created: true }
}

/**
 * `PATCH /api/projects/:id`（ADR-017 §1.3：**HTTP 收差量、事件载荷是整行快照**）。
 *
 * 服务层读当前行 → 合并 → 写整行（ADR-016 §5.2 的明文要求）。合并后的区间同样要过
 * 「起晚于止」的入口判定：改 `startsOn` 也可能把区间弄反，
 * 而表侧 CHECK 的失败会变成 500 而不是 400。
 */
export function updateProject(
  db: Db,
  accountId: string,
  now: Date,
  projectId: string,
  patch: ProjectPatch,
): { project: ProjectView } {
  assertInTransaction(db, '修改项目')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  const project = requireLiveProject(sources, projectId)

  const merged = {
    name: patch.name ?? project.name,
    startsOn: patch.startsOn ?? project.startsOn,
    endsOn: patch.endsOn ?? project.endsOn,
  }
  assertRange(merged.startsOn, merged.endsOn)

  appendEvents(db, accountId, [
    {
      type: projectUpdatedDefinition.type,
      occurredAt: write.occurredAt,
      payload: {
        projectId,
        name: merged.name,
        startsOn: merged.startsOn,
        endsOn: merged.endsOn,
      },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  const after = loadTaskSources(db, accountId)
  return {
    project: viewOf(requireProjectIn(after, projectId), write.today,
      archiveStateOf(after.events).get(projectId)?.archived ?? false),
  }
}

/**
 * `DELETE /api/projects/:id`（ADR-016 §5.3：软删除，**载荷不带快照**）。
 *
 * 返回 `{ projectId, batchId }`（与 `DELETE /api/tasks/:id` 同形）：
 * `batchId` 就是撤销这次删除的入参。
 *
 * **其下任务一条都不动**（ADR-016 §6）：级联删除会让一次误删抹掉几十条真实任务，
 * 而清空 `projectId` 会让「这条任务当时属于哪个项目」这段历史静默丢失。
 * 软删除下行仍在，`projectId` 根本不会悬挂——清空它是在解决一个不存在的问题。
 */
export function deleteProject(
  db: Db,
  accountId: string,
  now: Date,
  projectId: string,
): { projectId: string; batchId: string } {
  assertInTransaction(db, '删除项目')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  requireLiveProject(sources, projectId)

  const appended = appendEvents(db, accountId, [
    {
      type: projectDeletedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { projectId },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])
  const batchId = appended[0]?.batchId
  if (batchId === undefined) {
    throw new Error('删除事件没有写进流水：这是事件层的不变式被破坏（ADR-010 §3）。')
  }
  return { projectId, batchId }
}

/**
 * `POST /api/projects/:id/activate` ≡ `project/current-changed { projectId }`（ADR-016 §5.4）。
 *
 * 载荷**只带 `to`、不带 `from`**：`to` 已足以决定状态，带上 `from` 就是第二个真相
 * （且会让事件在导入合并后与新状态不一致）。本事件因此**幂等**：重复激活同一个项目
 * 照常写入（重放结果不变）——这与「重试一个响应丢失的请求」是同一件事。
 *
 * ⚠️ **指向不存在 / 已删除 / 他人的项目 → `400 validation/invalid-input`**
 * （ADR-016 §5.4 的明文，**不新增错误码**，且**不区分**三种情形以免泄露存在性）。
 * 这与 `:id` 路由的 404 不冲突：404 是「这个资源对你不存在」，而这里是
 * 「事件载荷指向了一个不可用的目标」——ADR-016 把它定义为一个**语义非法**的请求。
 */
export function activateProject(
  db: Db,
  accountId: string,
  now: Date,
  projectId: string,
): { currentProjectId: string } {
  assertInTransaction(db, '切换当前项目')
  const write = writeContextOf(db, accountId, now)
  const sources = loadTaskSources(db, accountId)
  requireLiveProjectAsInput(sources, projectId)
  if (archiveStateOf(sources.events).get(projectId)?.archived === true) {
    throw invalidInput('已归档项目不能设为当前项目')
  }

  appendEvents(db, accountId, [
    {
      type: projectCurrentChangedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { projectId },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { currentProjectId: projectId }
}

/**
 * `DELETE /api/projects/current` ≡ `project/current-changed { projectId: null }`（ADR-017 §1.3）。
 *
 * **这条路由是必需的，不是可有可无**：当前项目被删除时 `currentProjectId` 必然变成 `null`
 * （ADR-016 §5.4 的载荷允许 `null`），若没有显式取消的入口，用户就会处在一个
 * 「没有当前项目、且无法主动清空」的状态里——**一个只能被事件推入、不能主动进入的状态，
 * 界面就没法诚实地呈现它**。
 *
 * 没有当前项目时调用它是**幂等**的（写入一条 `null`，重放结果不变）。
 */
export function clearCurrentProject(
  db: Db,
  accountId: string,
  now: Date,
): { currentProjectId: null } {
  assertInTransaction(db, '取消当前项目')
  const write = writeContextOf(db, accountId, now)

  appendEvents(db, accountId, [
    {
      type: projectCurrentChangedDefinition.type,
      occurredAt: write.occurredAt,
      payload: { projectId: null },
      dayKey: write.dayKey,
      dayStartHour: write.dayStartHour,
    },
  ])

  return { currentProjectId: null }
}

// ───────────────────────── 内部 ─────────────────────────

interface WriteContext {
  occurredAt: string
  dayKey: DayKey
  dayStartHour: number
  today: DayKey
}

function writeContextOf(db: Db, accountId: string, now: Date): WriteContext {
  const settings = loadAccountSettings(db, accountId)
  const dayKey = todayOf(db, accountId, now)
  return {
    occurredAt: toIsoInZone(now, settings.timeZone),
    dayKey,
    dayStartHour: settings.dayStartHour,
    today: dayKey,
  }
}

function todayOf(db: Db, accountId: string, now: Date): DayKey {
  const settings = loadAccountSettings(db, accountId)
  // 项目的 `state`（upcoming / active / ended）是派生量（ADR-016 §4），它的输入就是今日
  return accountToday({ timeZone: settings.timeZone, dayStartHour: settings.dayStartHour }, now)
}

function requireProjectIn(sources: ReturnType<typeof loadTaskSources>, projectId: string) {
  const project = sources.projection.projects.find((row) => row.id === projectId)
  if (project === undefined) throw notFound(`项目不存在（${projectId}）`)
  return project
}

/**
 * 项目必须存在**且未删除**（`PATCH` / `DELETE` 用）。
 *
 * 「跨账号」与「不存在」在这里同解：投影已是当前账号的（ADR-017 §2）。
 */
function requireLiveProject(
  sources: ReturnType<typeof loadTaskSources>,
  projectId: string,
): ProjectedProject {
  const project = requireProjectIn(sources, projectId)
  if (project.deletedAt !== null) throw notFound(`项目不存在（${projectId}）`)
  return project
}

/**
 * `activate` 的目标校验：不存在 / 已删除 / 他人 → **`400`**（ADR-016 §5.4）。
 *
 * 与 `requireLiveProject` 分开，正是因为两者的**状态码不同**，而那是一个刻意的裁决：
 * §5.4 把「切换到一个不可用的项目」定义为**语义非法的请求**（事件载荷指向了一个
 * 不存在的目标），而不是「访问一个不存在的资源」。
 */
function requireLiveProjectAsInput(
  sources: ReturnType<typeof loadTaskSources>,
  projectId: string,
): ProjectedProject {
  const project = sources.projection.projects.find((row) => row.id === projectId)
  if (project === undefined || project.deletedAt !== null) {
    throw invalidInput(`项目不存在或不可用（${projectId}）`)
  }
  return project
}

/** 闭区间：`endsOn >= startsOn`（起止同日 = 1 天项目，合法，ADR-016 §6） */
function assertRange(startsOn: DayKey, endsOn: DayKey): void {
  if (compareDayKey(endsOn, startsOn) < 0) {
    throw invalidInput(
      `结束日（${endsOn}）不能早于开始日（${startsOn}）：项目区间是闭区间，` +
        '起止同日是 1 天的项目（ADR-016 §6）。',
    )
  }
}

function viewOf(project: ProjectedProject, today: DayKey, archived: boolean): ProjectView {
  return {
    projectId: project.id,
    name: project.name,
    startsOn: project.startsOn,
    endsOn: project.endsOn,
    isCurrent: project.isCurrent && !archived,
    archived,
    // 状态是**派生**的，不落库（ADR-016 §4）：`ended ⇔ today > endsOn`。
    // 判据取自 `shared/plan` 的 `projectState`——本模块不自己写那三个分支。
    state: projectState({ startsOn: project.startsOn, endsOn: project.endsOn }, today),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}
