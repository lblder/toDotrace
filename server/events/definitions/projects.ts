import { z } from 'zod'
import { isDayKey } from '@shared/time'
import { defineEvent, type EventDefinition, type ProjectedProject, type Projection, type RegisteredDefinition } from '../types.js'

/**
 * 项目的四类事件（ADR-016 §5）——阶段 4（FR2.8）登记项。
 *
 * | # | type | 载荷 | 施加到投影 |
 * |---|---|---|---|
 * | 5.1 | `project/created` | `projectId` + `name` + 起止 | 插入行（`isCurrent = false`） |
 * | 5.2 | `project/updated` | **整行快照**（同样四个字段） | 覆盖 `name` / `startsOn` / `endsOn` |
 * | 5.3 | `project/deleted` | `projectId`（**不带快照**） | 置 `deletedAt`；若 `isCurrent` 一并置 0 |
 * | 5.4 | `project/current-changed` | `projectId: string \| null` | 全部行 `isCurrent = false`，再把该项目置 `true` |
 *
 * ## 三条贯穿本文件的口径
 *
 * 1. **载荷命名一律 `projectId`**；`target` 一律 `{ kind: 'project', fromPayload: p => p.projectId }`
 *    （ADR-016 §5）——**只有 5.4 例外**，原因见下；
 * 2. **每个字段只有一个写入者**（ADR-013 §4.2）：`isCurrent` 只由 5.4 写、`deletedAt` 只由 5.3 写，
 *    5.2 因此**不携带**这两个字段；
 * 3. **`status`（upcoming / active / ended）不落库**：它是派生量（`projectState`，ADR-016 §4），
 *    02 §4 已立规矩「派生量一律计算，不落库——避免存的和算的对不上」。
 *
 * ## 为什么 `project/current-changed` 不声明 `target`
 *
 * `EventDefinition.target.fromPayload` **必须返回非空字符串**（`server/events/types.ts`），
 * 而本事件的载荷允许 `projectId: null`——它是一条**合法的真实状态**（一个项目都没有、
 * 显式取消、当前项目被删除）。声明 `target` 会让这一类合法事件**根本写不进去**。
 * 故两列为 NULL（ADR-016 §5.4 的明文例外）。
 *
 * **代价（如实记录）**：按 `target_id` 反查「这个项目被切过几次」查不到，
 * 需要按 `type` + 载荷过滤。十万级事件下可接受，但这是一处真实的查询能力缺失，不是「不需要」。
 *
 * ⚠️ **`startsOn` / `endsOn` 的「起晚于止」不在载荷层判**：那是**跨字段**约束，
 * 由 `projects` 表的 `CHECK (ends_on >= starts_on)` 兜底（ADR-016 §6）。
 * 这里只判「是不是一个真实存在的日历日」——两处各判一条、不重复。
 */

/** `target_kind` 常量（ADR-016 §5） */
export const PROJECT_TARGET_KIND = 'project'

const projectTarget = {
  kind: PROJECT_TARGET_KIND,
  fromPayload: (payload: { projectId: string }): string => payload.projectId,
}

const dayKeySchema = z
  .string()
  .refine(isDayKey, '必须是真实存在的日历日（零填充定宽 YYYY-MM-DD）')

/**
 * 5.1 `project/created` —— 创建。
 *
 * **起止同日合法**（`endsOn === startsOn` 是一个 1 天项目）：FR2.8 说「长短**完全自定义**」
 * （举例「3 天的项目到 1 年的课题」），那么一天的项目也该允许——没有理由替用户划一条
 * 他不需要的下界。「起晚于止」由表侧 CHECK 拒（§6），此处不重复定义。
 *
 * **`isCurrent` 与 `deletedAt` 不在载荷里**：新建即 `false` / `null`（5.5 的 apply 表）。
 * 「新建项目并设为当前」是**同一批次里的两条事件**（本事件 + 5.4）——代价是多一条事件，
 * 换来的是 `isCurrent` 只有一个来源，不需要在 created 的载荷里再放一份、
 * 也不需要「created 时顺带设当前」这种特例。
 */
export const projectCreatedPayloadSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    startsOn: dayKeySchema,
    endsOn: dayKeySchema,
  })
  .strict()

/**
 * 5.2 `project/updated` —— 改名 / 改期（**整行快照，不是差量**）。
 *
 * 载荷 = 5.1 的**全部定义字段**（同样四个）。差量与快照的取舍沿用 ADR-013 §4.2 的既有裁决：
 * 差量只有在「创建事件一定先于更新事件」时才拼得出完整行，而事件集合可能因撤销、
 * 合并导入而缺前半截；整行载荷让每一条更新事件**自身就足以决定状态**。
 *
 * ⚠️ **HTTP 层收差量、事件载荷是整行**（ADR-017 §1.3）：`PATCH /api/projects/:id` 的请求体
 * 是 `{ name?, startsOn?, endsOn? }`，**服务层必须先读当前行、合成为整行、再写事件**。
 * **不得把差量直接写进事件载荷**——那会让重放依赖「前一条事件一定在」。
 *
 * **提前结束 / 延期 = 改 `endsOn`**，一条本事件即可，**不引入 `endedAt` / `archived` 之类的新字段**：
 * 那会造出「`endsOn` 说 9/25、`archived` 说 9/10 结束」的第二真相。
 */
export const projectUpdatedPayloadSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    startsOn: dayKeySchema,
    endsOn: dayKeySchema,
  })
  .strict()

/**
 * 5.3 `project/deleted` —— 软删除。
 *
 * **不携带快照**（与 ADR-011 §6 的 `template-deleted` 相反）：那条事件的 `apply` 是
 * **删除该行**，行没了，所以载荷必须自带定义；本事件的 `apply` 只置 `deletedAt`（**软删除**），
 * **行本身仍在**——名字与区间照常解析得到。**携带快照在这里是第二个真相**：
 * 同一个定义既有行、又有快照副本，两者会漂移（例如导入一份含删除事件的旧文件后，
 * 快照与行不一致）。
 *
 * **软删除而非物理删除**，理由与 ADR-013 §4.8 同源：撤销 = 撤销该批次（ADR-006），
 * 行回来即可，**不需要还原动作**。且「项目删除时其下任务全部保留、`projectId` 一个都不清」
 * 这件事**不需要任何额外机制**（§6）——清空引用会丢历史，允许悬挂则每处读取都要处理，
 * 而软删除下行仍在，`projectId` 根本不会悬挂。
 */
export const projectDeletedPayloadSchema = z.object({ projectId: z.string().min(1) }).strict()

/**
 * 5.4 `project/current-changed` —— 切换当前项目。
 *
 * **只带 `to`，不带 `from`**（ADR-013 §4.4 的同一条规矩）：`to` 已足以决定状态，
 * 带上 `from` 就是第二个真相，且会让事件在导入合并后与新状态不一致。本事件因此**幂等**。
 *
 * **`projectId: null` 的语义是「没有当前项目」**，它是一个真实状态（一个项目都没有、
 * 显式取消、当前项目被删除），**必须能表达**——用一个随便挑的项目充数就是伪造。
 * 对应 `DELETE /api/projects/current`（ADR-017 §1.3）：没有显式取消的入口，
 * 用户就会处在一个**只能被事件推入、不能主动进入**的状态里，界面无法诚实地呈现它。
 *
 * **「至多一个」由结构保证**，不靠写入方自觉：`projects.is_current` 列 +
 * 部分唯一索引 `idx_projects_current ... WHERE is_current = 1`（ADR-016 §4/§6）。
 * 本事件是**至多一个**而非「恰好一个」的由来之一：删除当前项目时若强制「恰好一个」，
 * 就必须替用户挑一个继任者，而那是替用户决定。
 */
export const projectCurrentChangedPayloadSchema = z
  .object({ projectId: z.string().min(1).nullable() })
  .strict()

export type ProjectCreatedPayload = z.infer<typeof projectCreatedPayloadSchema>
export type ProjectUpdatedPayload = z.infer<typeof projectUpdatedPayloadSchema>
export type ProjectDeletedPayload = z.infer<typeof projectDeletedPayloadSchema>
export type ProjectCurrentChangedPayload = z.infer<typeof projectCurrentChangedPayloadSchema>

/** 定位项目行。**纯函数**（ADR-010 §4：折叠只吃 (projection, event)）。 */
function findProject(projection: Projection, projectId: string): ProjectedProject | undefined {
  return projection.projects.find((project) => project.id === projectId)
}

export const projectCreatedDefinition: EventDefinition<ProjectCreatedPayload> = defineEvent({
  type: 'project/created',
  schema: projectCreatedPayloadSchema,
  target: projectTarget,
  apply(projection, event) {
    const payload = event.payload
    const project: ProjectedProject = {
      id: payload.projectId,
      accountId: event.accountId,
      name: payload.name,
      startsOn: payload.startsOn,
      endsOn: payload.endsOn,
      isCurrent: false, // 新建即「不是当前项目」；要设当前，追加一条 5.4（§5.5）
      deletedAt: null,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    }
    const at = projection.projects.findIndex((candidate) => candidate.id === project.id)
    if (at >= 0) {
      // 同一项目 id 的第二次 created（合并导入、或「创建—删除—再导入」）：
      // 覆盖而不是抛错——重放对任何一条合法流水都必须有定义（与 `task/created` 同）。
      projection.projects[at] = project
    } else {
      projection.projects.push(project)
    }
  },
})

export const projectUpdatedDefinition: EventDefinition<ProjectUpdatedPayload> = defineEvent({
  type: 'project/updated',
  schema: projectUpdatedPayloadSchema,
  target: projectTarget,
  apply(projection, event) {
    const project = findProject(projection, event.payload.projectId)
    // 无对应行（创建批次被撤销、或更新先于创建到达）：**无操作**，不插入半行。
    if (project === undefined) return
    project.name = event.payload.name
    project.startsOn = event.payload.startsOn
    project.endsOn = event.payload.endsOn
    project.updatedAt = event.occurredAt
    // 明确不碰 isCurrent（5.4 专管）与 deletedAt（5.3 专管）——每个字段只有一个写入者。
  },
})

export const projectDeletedDefinition: EventDefinition<ProjectDeletedPayload> = defineEvent({
  type: 'project/deleted',
  schema: projectDeletedPayloadSchema,
  target: projectTarget,
  apply(projection, event) {
    const project = findProject(projection, event.payload.projectId)
    if (project === undefined) return
    project.deletedAt = event.occurredAt
    project.updatedAt = event.occurredAt
    // 「已删除的项目不能是当前项目」是**不变式**，不是第二个写入者：
    // `isCurrent` 的唯一**来源**仍是 5.4，删除事件的这一动作由表的
    // `CHECK (NOT (is_current = 1 AND deleted_at IS NOT NULL))` 兜底
    // ——漏写即当场报错，不会静默留下非法状态（ADR-016 §5.3）。
    project.isCurrent = false
  },
})

export const projectCurrentChangedDefinition: EventDefinition<ProjectCurrentChangedPayload> =
  defineEvent({
    type: 'project/current-changed',
    schema: projectCurrentChangedPayloadSchema,
    // **无 target**：载荷允许 null，而 fromPayload 必须返回非空字符串——见文件头。
    apply(projection, event) {
      const projectId = event.payload.projectId
      for (const project of projection.projects) {
        // 「该账号全部行 isCurrent = false，再按载荷把该项目置 true（载荷为 null 则只清）」（§5.5）。
        project.isCurrent = projectId !== null && project.id === projectId
      }
      // 载荷指向不存在的项目（或已删除的项目）时，结果是「一个当前项目都没有」——
      // 服务层在写入前就拒绝这种请求（400，ADR-016 §5.4），故这条路径只在
      // 重放一段被撤销过的流水时出现，而那时「全清」正是那段流水的真实含义。
    },
  })

/** 阶段 4 登记的全部项目事件定义 */
export const projectEventDefinitions: readonly RegisteredDefinition[] = [
  projectCreatedDefinition,
  projectUpdatedDefinition,
  projectDeletedDefinition,
  projectCurrentChangedDefinition,
]
