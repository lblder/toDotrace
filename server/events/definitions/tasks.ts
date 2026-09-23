import { z } from 'zod'
import { compareDayKey, isDayKey, weekStart } from '@shared/time'
import { validateRule } from '@shared/recurrence'
import type { NextAnchorMode } from '@shared/recurrence'
import type { ProjectedTask, RecurrenceSpec, Step, Task } from '@shared/tasks/types'
import { defineEvent, type EventDefinition, type Projection, type RegisteredDefinition } from '../types.js'

/**
 * 任务的 13 类事件（ADR-013 §4）——阶段 4 登记项，**取代 ADR-011 §6 的四类 `recurrence/*`**。
 *
 * | # | type | 载荷 | 施加到投影 |
 * |---|---|---|---|
 * | 4.1 | `task/created` | 定义字段 + `steps` | 插入（或覆盖）任务行 |
 * | 4.2 | `task/updated` | 定义字段（**整行快照**） | 覆盖定义字段 |
 * | 4.3 | `task/rescheduled` | 三对前后日期 | 覆盖三个日期锚点 |
 * | 4.4 | `task/status-changed` | `to` | 覆盖 `status` |
 * | 4.5 | `task/reordered` | `manualOrder` | 覆盖 `manualOrder` |
 * | 4.6 | `task/occurrence-completed` | 实例键 + 固化锚点 | **不写投影表**——完成态由事件固化 |
 * | 4.7 | `task/occurrence-uncompleted` | 实例键 | **不写投影表** |
 * | 4.8 | `task/deleted` | `taskId`（**不带快照**） | 置 `deletedAt`（软删除，行还在） |
 * | 4.9 | `task/step-added` | `step` | 追加到 `steps` 末尾 |
 * | 4.10 | `task/step-removed` | `stepId` | 从 `steps` 移除 |
 * | 4.11 | `task/step-renamed` | `stepId` + `title` | 改该步骤的标题 |
 * | 4.12 | `task/step-toggled` | 实例键 + `checkedAt` | **不写投影表**——勾选属于某一轮 |
 * | 4.13 | `task/steps-reordered` | `order` | 整体替换 `steps` 的顺序 |
 *
 * ## 五条贯穿本文件的口径
 *
 * 1. **载荷命名一律 `taskId`**（ADR-013 §4）：同一概念两个名字，重放代码迟早写错其中一个。
 *    `target` 一律 `{ kind: 'task', fromPayload: p => p.taskId }`（ADR-010 §2 的派生式）。
 * 2. **每个字段只有一个写入者**（§4.2）：`status` 只由 4.4 写、`steps` 只由 4.1 与 4.9–4.13 写、
 *    三个日期锚点只由 4.3 写、`manualOrder` 只由 4.5 写、`deletedAt` 只由 4.8 写。
 *    **`task/updated` 因此不携带** `status` / `steps` / 三个锚点 / `manualOrder` / `deletedAt`——
 *    若让它顺带清完成态或改锚点，同一份数据就有了两个写入者，**撤销其中一条批次后两者会分叉
 *    且没有判据**。
 * 3. **`updatedAt` 不由载荷携带**：凡改动任务行的事件都把 `updatedAt` 推到 `occurred_at`
 *    （与 `createdAt` 同理，取自事件行）。落库的每一列都能由事件重放得出（ADR-002 §2）。
 * 4. **不写投影表的字段不编造**：完成态与步骤勾选**都不是投影行的一部分**（ADR-007 §4）——
 *    它们由 4.6 / 4.7 / 4.12 的事件固化，从事件折叠得出。这两条事件因此 `apply` 为空操作，
 *    **不是遗漏**。
 * 5. **锚点校验有两道**（§3.3）：载荷侧本文件的 `zod .superRefine`，表侧 `tasks` 的 CHECK
 *    （`server/db/schema.ts` 的 v4）。**两道都要有**——载荷把关挡住正常路径，CHECK 挡住
 *    绕过路由的写入（导入、测试构造）；只留一道时，失去的那一道失效**不会有任何症状**。
 *    ⚠️ **一处如实登记的缝**：`task/updated` 的载荷**不含**三个锚点（§4.2 的不携带清单），
 *    故「给一条已带锚点的任务加规则」这条**跨行**冲突在载荷层判不了——
 *    它由表侧 CHECK + `projection-store` 的写入前守卫兜底，服务层则按 §3.1 读行守卫（`400`）。
 *    三道各管一段，但**载荷那一道在 updated 上确实覆盖不到跨行情况**。
 *
 * ## 规则的合法性不在这里重新定义
 *
 * 结构（类型 / 形状）由本文件的 zod 把关，语义（`count`/`until` 互斥、范围、`freq` 相容）
 * 交回 `@shared/recurrence` 的 `validateRule`——那是唯一一份规则校验（ADR-011 §2）。
 * 两处各写一份的后果很具体：字段一旦不同步，解析器的输出会被载荷 schema 拒绝，
 * 而症状是「预览显示解析成功、提交却 400」——用户看不出原因。
 */

/** `target_kind` 常量（ADR-013 §4：13 类事件的落点一律是任务） */
export const TASK_TARGET_KIND = 'task'

/**
 * 13 类事件共用的标识落点（ADR-010 §2 的 `EventDefinition.target`）。
 *
 * **只此一份**：13 类载荷都带 `taskId`，落点规则就是「取它」。
 * 两列由 `appendEvents` 从载荷派生，调用方无从写错（见 `append.ts` 的 `deriveTarget`）。
 */
const taskTarget = {
  kind: TASK_TARGET_KIND,
  fromPayload: (payload: { taskId: string }): string => payload.taskId,
}

const anchorModeSchema = z.enum(['extend', 'catch_up', 'recompute'])

/**
 * 一个真实存在的日历日。
 *
 * 与表侧的加固 CHECK 是同一条判定的两个落点：`isDayKey` 先看形状（零填充定宽 `YYYY-MM-DD`）、
 * 再逐字段查日历（`2026-02-31` 不是「形状合法」而是**根本不存在**，ADR-009 §7）。
 * 只判形状会让一个永远不存在的日期进入流水，而它会在某次日期算术里变成另一个日子——
 * 错误因此是静默的。
 */
const dayKeySchema = z
  .string()
  .refine(isDayKey, '必须是真实存在的日历日（零填充定宽 YYYY-MM-DD）')

/**
 * 重复规则的结构（ADR-011 §2）。**只描述形状**——
 * `interval ≥ 1` / `count` 与 `until` 互斥 / `by*` 与 `freq` 相容等语义由 `validateRule` 判。
 */
const ruleShape = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number(),
    byDayOfWeek: z.array(z.number()).optional(),
    byMonthDay: z.array(z.number()).optional(),
    count: z.number().optional(),
    until: z.string().optional(),
  })
  .strict()

/**
 * `RecurrenceSpec`（ADR-013 §3）：任务的**可选部分**，`null` = 非重复任务。
 *
 * 类型上用可空对象而非「规则字段各自可空」：后者能表达出「有规则但没有起点」这种不合法组合。
 * 语义校验交回 `@shared/recurrence` 的 `validateRule`——**不在这里重写一份**。
 */
const recurrenceSpecSchema = z
  .object({
    rule: ruleShape,
    nextAnchorMode: anchorModeSchema,
    startsOn: dayKeySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const violation of validateRule(value.rule, value.startsOn)) {
      ctx.addIssue({ code: 'custom', path: violation.path.split('.'), message: violation.message })
    }
  })

/** 步骤的**定义**（ADR-013 §1）：`id` 稳定、`title` 可改，严格单层（不做子任务）。 */
const stepSchema = z.object({ id: z.string().min(1), title: z.string() }).strict()

/**
 * 任务的**定义字段**（ADR-013 §4.1 去掉 `taskId` 与 `steps`）——4.1 与 4.2 共用这一份，
 * **但 4.2 要再摘掉三个日期锚点**（见 `updatedShape`）。
 */
const definitionShape = {
  title: z.string().min(1),
  notes: z.string(),
  importance: z.enum(['low', 'normal', 'high']),
  plannedDate: dayKeySchema.nullable(),
  plannedWeek: dayKeySchema.nullable(),
  dueDate: dayKeySchema.nullable(),
  tags: z.array(z.string()),
  projectId: z.string().min(1).nullable(),
  recurrence: recurrenceSpecSchema.nullable(),
}

/**
 * **4.2 的载荷形状 = 4.1 去掉 `steps` 与三个日期锚点**（ADR-013 §4.2 的「本事件不携带」清单）。
 *
 * ⚠️ §4.2 开头那句「载荷 = 4.1 去掉 `steps`、加上 `taskId` 的**全部定义字段**」是**措辞过宽**：
 * 它紧接着就列出「**本事件不携带**……三个日期锚点（4.3 专管）」，而 ADR-017 §4 把这件事钉死为
 * 「`PATCH` 不携带 `plannedDate` / `plannedWeek` / `dueDate`，**给出来即 `400`**」。
 * **两处合读只有一个自洽解：`task/updated` 的载荷没有这三个字段。**
 * 若照那句宽泛的措辞让它们进来，`task/updated` 就成了日期锚点的**第二个写入者**——
 * 而 ADR-016 §9 行 3 的整条论证正是「**创建之后，日期锚点的唯一写入者是
 * `task/rescheduled`**」，`plannedWeek` 会因此变成唯一一个没有任何事件能改的字段。
 *
 * `.strict()` 让「多给一个锚点」当场变 `400`，而不是**静默忽略**——
 * 静默忽略会让调用方以为自己改成功了（ADR-017 §4 的原话）。
 */
const updatedShape = {
  title: definitionShape.title,
  notes: definitionShape.notes,
  importance: definitionShape.importance,
  tags: definitionShape.tags,
  projectId: definitionShape.projectId,
  recurrence: definitionShape.recurrence,
}

interface AnchorFields {
  plannedDate: string | null
  plannedWeek: string | null
  dueDate: string | null
  recurrence: unknown | null
}

/**
 * 锚点的两道规则里的**载荷那一道**（ADR-013 §3.3 / §3.1、ADR-016 §1）：
 *
 * 1. **`plannedDate` 与 `plannedWeek` 不得同时非空**——一次只排一层；
 * 2. **`plannedWeek` 非空时必须落在周一**（规范化存该周周一）；
 * 3. **重复任务的三个日期锚点一律为 `null`**——重复任务「哪天做」由规则唯一决定，
 *    任务行上再存一个日期**必然与当前轮次分叉**（顺延、跨天、提前完成都会让两者不一致），
 *    而分叉之后没有任何依据判断该信哪个（§3.1）。
 *
 * ⚠️ **这是 `superRefine`，不是三分支联合**（ADR-016 §1 的更正）：非法组合在 TS 类型上
 * **仍然可表达**，只被两道运行期 / 结构约束挡住。要真正做成不可表达，得把 9 个公共字段
 * 在三个分支里各写一遍——**代价与收益不成比例**。两处口径必须一致，否则测试用例都不一样：
 * 「联合」下要断言**构造不出**载荷，「refine」下要断言**返回 400**。
 */
function checkAnchors(value: AnchorFields, ctx: z.RefinementCtx): void {
  if (value.plannedDate !== null && value.plannedWeek !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['plannedWeek'],
      message: '日级锚点与周级锚点不得同时非空：一次只排一层（ADR-016 §1）',
    })
  }
  if (value.plannedWeek !== null && compareDayKey(value.plannedWeek, weekStart(value.plannedWeek)) !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['plannedWeek'],
      message: `周级锚点必须落在周一（规范化存该周周一，ADR-016 §1），实得 '${value.plannedWeek}'`,
    })
  }
  if (value.recurrence !== null) {
    for (const field of ['plannedDate', 'plannedWeek', 'dueDate'] as const) {
      if (value[field] !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message:
            '重复任务的日期锚点恒为 null：任务行上的日期必然与轮次分叉，' +
            '分叉之后没有任何依据判断该信哪个（ADR-013 §3.1）',
        })
      }
    }
  }
}

/** 4.1 `task/created` —— 创建。**只有本事件携带 `steps`**（§4.9）。 */
export const taskCreatedPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    ...definitionShape,
    steps: z.array(stepSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    checkAnchors(value, ctx)
    const seen = new Set<string>()
    for (const [index, step] of value.steps.entries()) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `步骤 id '${step.id}' 在同一条任务里重复：步骤的 id 是它在「3/5」进度里的身份，重复即无从计数`,
        })
      }
      seen.add(step.id)
    }
  })

/**
 * 4.2 `task/updated` —— 定义字段变更（**整行快照，不是差量**）。
 *
 * **本事件不携带**：`status`（4.4 专管）、`steps`（4.9–4.13 专管）、
 * 三个日期锚点（4.3 专管）、`manualOrder`（4.5）、`deletedAt`（4.8）。
 * **每个字段只有一个写入者**——「一个真相」在本层的落法。
 *
 * ⚠️ **载荷层因此只剩一条可判的规则**：`recurrence` 内部的规则合法性。
 * 「给重复任务加上日期锚点」这条**判不了**——锚点根本不在这份载荷里，
 * 而它是不是非法取决于**行上已有的值**（跨行）。那条由表侧 CHECK 兜底
 * （`writeProjection` 在写库前也会先报出是哪条任务的哪个锚点），
 * 服务层则按 §3.1 在写入前读行守卫（违者 `400`）——**三道各管一段，没有一道被省掉**。
 */
export const taskUpdatedPayloadSchema = z
  .object({ taskId: z.string().min(1), ...updatedShape })
  .strict()

/**
 * 4.3 `task/rescheduled` —— 顺延（FR2.7）。
 *
 * **六个日期字段全显式**（三对前后值），重放无需 diff；载荷自带前后值，
 * 使「原定 X → 现 Y」的呈现**不必回溯事件历史**（FR2.7 要求展示它）。
 *
 * **`carryCount` 不在这份载荷里，它是派生量**（ADR-002 §2「派生量一律计算，不落库」）：
 * 它 = 该任务 `task/rescheduled` 事件的**条数**，读取时算出。它同样是可撤销的——
 * 撤销一次顺延批次，计数自然减一；若落库，撤销就得额外维护那个列，
 * 多一个会与事件分叉的地方。
 *
 * ⚠️ 互斥与「周一」两道**只施加在 `to*` 上**：`from*` 描述的是**已经存在的状态**，
 * 它不是这次写入的内容（写入的是 `to*`）。若对 `from*` 施加同样的谓词，
 * 一条「把非周一的周锚点改回周一」的合法顺延会被拒——那正是最需要它工作的一刻。
 * `from*` 仍然必须各自是一个真实日历日（结构），否则事件里会出现一个假的「原来」。
 */
export const taskRescheduledPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    fromPlannedDate: dayKeySchema.nullable(),
    toPlannedDate: dayKeySchema.nullable(),
    fromPlannedWeek: dayKeySchema.nullable(),
    toPlannedWeek: dayKeySchema.nullable(),
    fromDueDate: dayKeySchema.nullable(),
    toDueDate: dayKeySchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.toPlannedDate !== null && value.toPlannedWeek !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['toPlannedWeek'],
        message: '日级锚点与周级锚点不得同时非空：一次只排一层（ADR-016 §1）',
      })
    }
    if (
      value.toPlannedWeek !== null &&
      compareDayKey(value.toPlannedWeek, weekStart(value.toPlannedWeek)) !== 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['toPlannedWeek'],
        message: `周级锚点必须落在周一（规范化存该周周一，ADR-016 §1），实得 '${value.toPlannedWeek}'`,
      })
    }
  })

/**
 * 4.4 `task/status-changed` —— 意图态迁移（§2）。
 *
 * **只带 `to`，不带 `from`**：`to` 已足以决定状态，带上 `from` 就是第二个真相
 * （且会让事件在导入合并后与新状态不一致）。本事件因此**幂等**。
 *
 * 「已完成」**不在**这个状态集里：完成是**实例**的属性，由 4.6 表达。
 * 重复任务的可达状态只有 `未开始`（系列活跃）与 `已放弃`（系列终止）——
 * **这是一条可达性约束，不是第二套状态机**，由服务层在写入前守卫（ADR-013 §2）。
 */
export const taskStatusChangedPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    to: z.enum(['not_started', 'in_progress', 'abandoned']),
  })
  .strict()

/**
 * 4.5 `task/reordered` —— 手动排序。
 *
 * `number` 而非序号：插入两条之间取中值，**避免「插一条要改后面所有行」**。
 * `.finite()` 是刻意加的：`NaN` 经 `JSON.stringify` 变成 `null`，于是**事件里会留下一个
 * 假的 `manualOrder: null`**（读回来与写进去的不是同一个值），而 SQLite 的 REAL 列
 * 绑定 `NaN` 同样落成 NULL。一个「未手动排过」的取值不该由一次静默的数值转换产生。
 */
export const taskReorderedPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    manualOrder: z.number().refine(Number.isFinite, '必须是有限数'),
  })
  .strict()

/**
 * 4.6 `task/occurrence-completed` —— 完成一个实例。
 *
 * **`next: null` 的含义是「没有下一轮」**，它覆盖两种情形：非重复任务（本来就没有下一轮）
 * 与重复规则已终止（达到 `count` 或越过 `until`）。两者在读取方需要知道的**全部信息**上
 * 完全等价，合并成一个取值是准确的。
 *
 * **为什么用嵌套的可空对象，而不是 `nextAnchorDate: null` + 独立 `nextAnchorMode`**：
 * 后者在「没有下一轮」时 `nextAnchorMode` 无处安放——留着，读的人得判断它是不是还有意义；
 * 置 null，就得到一个「有模式没日期 / 有日期没模式」的非法组合空间。嵌套联合让
 * **「没有下一轮」在类型上只有一个表示**——让非法值在类型上不可表达，而不是靠数值守卫。
 *
 * `next !== null` 时仍受 ADR-011 §5 的**锚点不变式**约束（必须严格晚于 `originalPlannedDate`），
 * 由 `AnchorInvariantError` 原样把关——**但把关在读时（`deriveRounds`），不在写时**：
 * 事件层照收（阶段 2 的测试已明文锁定这一点），故本 schema **不**校验该不变式。
 * 一条坏的完成事件会让整个列表在读取时抛错（500），而不是在写入时被拒。
 */
export const taskOccurrenceCompletedPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    originalPlannedDate: dayKeySchema,
    completedDayKey: dayKeySchema,
    next: z
      .object({ date: dayKeySchema, mode: anchorModeSchema })
      .strict()
      .nullable(),
  })
  .strict()

/**
 * 4.7 `task/occurrence-uncompleted` —— 取消完成。
 *
 * 对应 FR2.1「取消完成支持，且**不抹除任何历史记录**」——
 * 它是**追加一条事件**，不是删除 4.6 的那条。
 */
export const taskOccurrenceUncompletedPayloadSchema = z
  .object({ taskId: z.string().min(1), originalPlannedDate: dayKeySchema })
  .strict()

/**
 * 4.8 `task/deleted` —— 软删除（FR2.1 v1.3 新增口径）。
 *
 * **载荷只有标识，不携带快照**——与 ADR-011 §6 的 `template-deleted` **不同**，
 * 差别来自删除方式：
 *
 * | | ADR-011 的模板删除 | 本 ADR 的任务删除 |
 * |---|---|---|
 * | 投影行 | **物理移除** | **保留**，只置 `deleted_at` |
 * | 删除后还读得到定义吗 | 读不到 | **读得到**（行还在） |
 * | 故需要快照吗 | **需要**（否则历史轮次无从渲染） | **不需要**——多存一份就是第二个真相 |
 *
 * **撤销删除 = 撤销该批次**（ADR-006），**不设 `task/restored`**——
 * 恢复已有机制覆盖，多一个事件类型就多一条可以与之冲突的路径。
 */
export const taskDeletedPayloadSchema = z.object({ taskId: z.string().min(1) }).strict()

/** 4.9 `task/step-added` —— 追加到**末尾**（定义层）。 */
export const taskStepAddedPayloadSchema = z
  .object({ taskId: z.string().min(1), step: stepSchema })
  .strict()

/**
 * 4.10 `task/step-removed` —— 只移除**定义**，不删勾选记录。
 *
 * 勾选留在流水里，故撤销删除后它们原样回来（重放时按「该 stepId 是否还在定义里」过滤）。
 * **物理删掉它们等于让一次误删不可撤销**（ADR-006 的撤销语义是追加事件，不是完善删除）。
 */
export const taskStepRemovedPayloadSchema = z
  .object({ taskId: z.string().min(1), stepId: z.string().min(1) })
  .strict()

/** 4.11 `task/step-renamed` —— 改标题（定义层）。 */
export const taskStepRenamedPayloadSchema = z
  .object({ taskId: z.string().min(1), stepId: z.string().min(1), title: z.string() })
  .strict()

/**
 * 4.12 `task/step-toggled` —— 勾选（**实例层**）。
 *
 * **定义属于任务，勾选属于某一轮**（§4.12 的关键设计）：初稿把 `checkedAt` 放在 `Step` 上，
 * 那对重复任务是错的——一个「每日复盘」的重复任务有两步，若勾选属于任务，
 * **昨天的勾选今天还亮着**，`3/5` 这个进度从第二轮起就永远显示 `5/5`。
 * 因此键 = `(taskId, stepId, occurrenceKey)`，`occurrenceKey` 就是 `originalPlannedDate`。
 *
 * **`checkedAt` 而非 `checked: boolean`**：时间戳自带布尔（非 null 即已勾选），
 * 且「什么时候勾的」是阶段 6 需要的量。**非法值在类型上不可表达**（Joplin 哨兵值教训的
 * 正向应用：把 `todo_completed` 存成裸 `INT` 毫秒时间戳，遗留的 `1` 会渲染成
 * 「已完成 + 1970 年」）。
 */
export const taskStepToggledPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    stepId: z.string().min(1),
    originalPlannedDate: dayKeySchema,
    // `null` = 取消勾选；非 null 时必须是**带偏移的 ISO 8601 时刻**——
    // 与 `occurredAt` 用同一个校验器（`append.ts`），因为两者都是「瞬间」而不是「归属日」。
    // 本仓对瞬间的既有口径就是这一条，故这里不新造一种。
    checkedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()

/**
 * 4.13 `task/steps-reordered` —— stepId 的**完整新顺序**。
 *
 * ⚠️ **必须是完整列表**（ADR-013 §5）：`steps` 数组不单独规范化排序，它的顺序
 * 就是 `apply` 维护的数组顺序本身；只给一部分，未列出的步骤位置就**取决于实现者的选择**。
 * 集合相等由路由层把关（ADR-017 §3，`order` 与现存 stepId 集合不相等即 `400`），
 * 事件层在此**确定性兜底**：按 `order` 里给出的顺序排前面，未列出的按原相对顺序接在后面
 * （理由见 `apply`——重放对任何一条合法流水都必须有定义，不能因为一个部分列表就崩）。
 *
 * 「无重复」在此判掉：一个 stepId 出现两次，`order` 就不是一个顺序，而是一个多值映射。
 */
export const taskStepsReorderedPayloadSchema = z
  .object({ taskId: z.string().min(1), order: z.array(z.string().min(1)) })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, stepId] of value.order.entries()) {
      if (seen.has(stepId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['order', index],
          message: `stepId '${stepId}' 在 order 里出现了两次：顺序是一个排列，不是一个多重集`,
        })
      }
      seen.add(stepId)
    }
  })

export type TaskCreatedPayload = z.infer<typeof taskCreatedPayloadSchema>
export type TaskUpdatedPayload = z.infer<typeof taskUpdatedPayloadSchema>
export type TaskRescheduledPayload = z.infer<typeof taskRescheduledPayloadSchema>
export type TaskStatusChangedPayload = z.infer<typeof taskStatusChangedPayloadSchema>
export type TaskReorderedPayload = z.infer<typeof taskReorderedPayloadSchema>
export type TaskOccurrenceCompletedPayload = z.infer<typeof taskOccurrenceCompletedPayloadSchema>
export type TaskOccurrenceUncompletedPayload = z.infer<typeof taskOccurrenceUncompletedPayloadSchema>
export type TaskDeletedPayload = z.infer<typeof taskDeletedPayloadSchema>
export type TaskStepAddedPayload = z.infer<typeof taskStepAddedPayloadSchema>
export type TaskStepRemovedPayload = z.infer<typeof taskStepRemovedPayloadSchema>
export type TaskStepRenamedPayload = z.infer<typeof taskStepRenamedPayloadSchema>
export type TaskStepToggledPayload = z.infer<typeof taskStepToggledPayloadSchema>
export type TaskStepsReorderedPayload = z.infer<typeof taskStepsReorderedPayloadSchema>

/** 投影行的初始状态：新建的任务是「未开始」（ADR-013 §2 的三元素状态集）。 */
const INITIAL_STATUS: Task['status'] = 'not_started'

/**
 * 载荷里的 `RecurrenceSpec` → 投影行字段。**null 保持 null**（非重复任务）。
 *
 * 逐字段构造而不是展开：`recurrence` 与 `rule` 都含有可选成员，
 * 展开会把 zod 的推断形状（`readonly` 与否、可选成员的存在性）原样漏进投影，
 * 而投影行吃的是 `@shared/tasks` 的 `RecurrenceSpec`——**两处必须逐字段相等**，
 * 于是这里写成显式构造，断言交给编译器。
 */
function toProjectedRecurrence(
  recurrence: z.infer<typeof recurrenceSpecSchema> | null,
): RecurrenceSpec | null {
  if (recurrence === null) return null
  return {
    rule: recurrence.rule,
    nextAnchorMode: recurrence.nextAnchorMode as NextAnchorMode,
    startsOn: recurrence.startsOn,
  }
}

/** 定位任务行。**纯函数**（ADR-010 §4：折叠只吃 (projection, event)）。 */
function findTask(projection: Projection, taskId: string): ProjectedTask | undefined {
  return projection.tasks.find((task) => task.id === taskId)
}

/** 覆盖任务的**定义字段**（4.1 / 4.2 共用）——**不含** status / steps / 锚点 / 排序 / 删除。 */
function assignDefinitionFields(
  task: ProjectedTask,
  payload: TaskCreatedPayload | TaskUpdatedPayload,
): void {
  task.title = payload.title
  task.notes = payload.notes
  task.importance = payload.importance
  task.tags = [...payload.tags]
  task.projectId = payload.projectId
  task.recurrence = toProjectedRecurrence(payload.recurrence)
}

export const taskCreatedDefinition: EventDefinition<TaskCreatedPayload> = defineEvent({
  type: 'task/created',
  schema: taskCreatedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const payload = event.payload
    // `indexDate` **不来自载荷，取自本事件自身的 `day_key`**（ADR-013 §1/§2）：
    // 同一事实只应有一个来源（ADR-010 §1）。选它而不是「创建时的 plannedDate」：
    // `plannedDate` 可空（FR2.6 允许无期限任务），而事件的 `day_key` 恒为一个
    // 真实存在的日历日，不需要为「没有计划日的新任务」编造一个键。
    const task: ProjectedTask = {
      id: payload.taskId,
      accountId: event.accountId,
      title: payload.title,
      notes: payload.notes,
      importance: payload.importance,
      plannedDate: payload.plannedDate,
      plannedWeek: payload.plannedWeek,
      dueDate: payload.dueDate,
      tags: [...payload.tags],
      projectId: payload.projectId,
      status: INITIAL_STATUS,
      manualOrder: null,
      recurrence: toProjectedRecurrence(payload.recurrence),
      deletedAt: null,
      indexDate: event.dayKey,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      steps: payload.steps.map((step) => ({ id: step.id, title: step.title })),
    }
    const at = projection.tasks.findIndex((candidate) => candidate.id === task.id)
    if (at >= 0) {
      // 同一任务 id 的第二次 created（合并导入、或「创建—删除—再导入」）：
      // 覆盖而不是抛错——重放对任何一条合法流水都必须有定义，不能因为重复创建就崩。
      projection.tasks[at] = task
    } else {
      projection.tasks.push(task)
    }
  },
})

export const taskUpdatedDefinition: EventDefinition<TaskUpdatedPayload> = defineEvent({
  type: 'task/updated',
  schema: taskUpdatedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    // 无对应行（其创建事件的批次被撤销、或更新先于创建到达）：**无操作**。
    // 不插入半行——那会伪造出一个没有创建事实的任务（它的 `indexDate` 无处可来，
    // 而 `indexDate` 是实例键的一半，凭空造一个等于让历史轮次对不上轮次）。
    if (task === undefined) return
    assignDefinitionFields(task, event.payload)
    task.updatedAt = event.occurredAt
    // 明确不碰：status / steps / 三个日期锚点 / manualOrder / deletedAt / indexDate / createdAt
    // —— 每个字段只有一个写入者（ADR-013 §4.2）。
  },
})

export const taskRescheduledDefinition: EventDefinition<TaskRescheduledPayload> = defineEvent({
  type: 'task/rescheduled',
  schema: taskRescheduledPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    task.plannedDate = event.payload.toPlannedDate
    task.plannedWeek = event.payload.toPlannedWeek
    task.dueDate = event.payload.toDueDate
    task.updatedAt = event.occurredAt
    // `from*` 三列**不入投影**：投影只装当前态，而「原定 X」是事件载荷里的历史，
    // 由流水回答（FR2.7 的呈现因此不必回溯，也不必在投影表里存第二份）。
  },
})

export const taskStatusChangedDefinition: EventDefinition<TaskStatusChangedPayload> = defineEvent({
  type: 'task/status-changed',
  schema: taskStatusChangedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    task.status = event.payload.to
    task.updatedAt = event.occurredAt
    // **不取消任何完成记录**（ADR-013 §2）：放弃与完成态**正交**。
    // 「已放弃的任务 completedAt 必须为空」那句写在 `completedAt` 是**任务级字段**的
    // 原始模型里，而本模型的完成态按实例、由事件固化——那个字段在这里不存在。
    // 它的**目的**（放弃的任务不得被统计当作完成）落在**统计口径**上，不在完成记录上：
    // 若「放弃 = 清空全部完成记录」，一个坚持了 100 天的每日习惯在放弃的那一刻历史归零。
  },
})

export const taskReorderedDefinition: EventDefinition<TaskReorderedPayload> = defineEvent({
  type: 'task/reordered',
  schema: taskReorderedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    task.manualOrder = event.payload.manualOrder
    task.updatedAt = event.occurredAt
  },
})

export const taskOccurrenceCompletedDefinition: EventDefinition<TaskOccurrenceCompletedPayload> =
  defineEvent({
    type: 'task/occurrence-completed',
    schema: taskOccurrenceCompletedPayloadSchema,
    target: taskTarget,
    apply: () => {
      // 空操作：**完成态不落库**（ADR-007 §4 / ADR-013 §2）。
      // 它是 `deriveRounds` 的输入（经 `eventToCompletion`），不是投影的输入——
      // 这样任务被改、被删都不会让已完成的历史轮次漂移。
    },
  })

export const taskOccurrenceUncompletedDefinition: EventDefinition<TaskOccurrenceUncompletedPayload> =
  defineEvent({
    type: 'task/occurrence-uncompleted',
    schema: taskOccurrenceUncompletedPayloadSchema,
    target: taskTarget,
    apply: () => {
      // 空操作：与完成事件同源的理由——它是**追加一条事件**，不是删除上一条（FR2.1）。
      // 重放时「取消完成」的语义由 `eventToCompletion` 的消费者按 id 序折叠得出。
    },
  })

export const taskDeletedDefinition: EventDefinition<TaskDeletedPayload> = defineEvent({
  type: 'task/deleted',
  schema: taskDeletedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    // 软删除：`deletedAt` 置位、任务从所有视图消失，但**行还在**、事件流水保留。
    // FR2.1 已写明「完成 ≠ 删除」，两者不可互相替代。
    task.deletedAt = event.occurredAt
    task.updatedAt = event.occurredAt
  },
})

export const taskStepAddedDefinition: EventDefinition<TaskStepAddedPayload> = defineEvent({
  type: 'task/step-added',
  schema: taskStepAddedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    const step: Step = { id: event.payload.step.id, title: event.payload.step.title }
    // 同 id 的步骤已在定义里：**忽略**（不追加第二条、也不改名）。
    // 「追加」的语义是「它应该在这里」，它已经在这里了——幂等。
    // 改名有专门的事件（4.11），让这条顺带改标题就是给它加了第二个写入者。
    if (task.steps.some((candidate) => candidate.id === step.id)) return
    task.steps.push(step) // 追加到末尾（§4.9）
    task.updatedAt = event.occurredAt
  },
})

export const taskStepRemovedDefinition: EventDefinition<TaskStepRemovedPayload> = defineEvent({
  type: 'task/step-removed',
  schema: taskStepRemovedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    const at = task.steps.findIndex((candidate) => candidate.id === event.payload.stepId)
    // 移除不存在的步骤是无操作（事件流可能被撤销成半截），**不是错误**。
    if (at < 0) return
    task.steps.splice(at, 1)
    task.updatedAt = event.occurredAt
    // 勾选记录不在这里、也不被删（§4.10）：勾选留在流水里，撤销删除后它们原样回来。
  },
})

export const taskStepRenamedDefinition: EventDefinition<TaskStepRenamedPayload> = defineEvent({
  type: 'task/step-renamed',
  schema: taskStepRenamedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    const step = task.steps.find((candidate) => candidate.id === event.payload.stepId)
    if (step === undefined) return
    step.title = event.payload.title
    task.updatedAt = event.occurredAt
  },
})

export const taskStepToggledDefinition: EventDefinition<TaskStepToggledPayload> = defineEvent({
  type: 'task/step-toggled',
  schema: taskStepToggledPayloadSchema,
  target: taskTarget,
  apply: () => {
    // 空操作：**勾选不进投影表**（ADR-013 §4.12 / ADR-007 §4）。
    // 它属于某一轮实例（键 = (taskId, stepId, originalPlannedDate)），由本事件固化、
    // 从事件折叠得出。「已完成的轮次由事件固化而非投影行」这条纪律
    // **不因为对象是步骤就放宽**——没有例外。
  },
})

export const taskStepsReorderedDefinition: EventDefinition<TaskStepsReorderedPayload> = defineEvent({
  type: 'task/steps-reordered',
  schema: taskStepsReorderedPayloadSchema,
  target: taskTarget,
  apply(projection, event) {
    const task = findTask(projection, event.payload.taskId)
    if (task === undefined) return
    const byId = new Map(task.steps.map((step) => [step.id, step]))
    const reordered: Step[] = []
    for (const stepId of event.payload.order) {
      const step = byId.get(stepId)
      if (step === undefined) continue // 不在定义里的 id：**丢弃**（集合相等由路由层把关）
      reordered.push(step)
      byId.delete(stepId)
    }
    // 未在 `order` 里出现的步骤：按**原相对顺序**接在后面。
    // 为什么不抛错、也不丢弃：`project()` 对任何一条合法流水都必须有定义，
    // 一条部分列表若让它抛错，那批事件会让**整个账号的列表打不开**（ADR-017 §2 的 500 形态）。
    // 取「原相对顺序」是唯一与实现者无关的确定性选择——「取决于实现者的选择」
    // 正是 ADR-013 §5 要求完整列表要避免的东西，而在**已经**收到部分列表时，
    // 稳定排序是唯一不需要额外约定的行为。
    for (const step of task.steps) {
      if (byId.has(step.id)) reordered.push(step)
    }
    task.steps = reordered
    task.updatedAt = event.occurredAt
  },
})

/**
 * ⚠️ **本次改名删掉了本文件里原先的 `eventToCompletion`**（它在阶段 2 是
 * `definitions/recurrence.ts` 的一部分）。
 *
 * 原因不是重命名，而是**它的家已经搬到 `shared/tasks/rounds.ts`**：ADR-013 §3 规定
 * 任务层与 `shared/recurrence` 之间**只有两个跨越点**（`toRecurrenceTemplate` 进、
 * `eventToCompletion` 出），两个都落在 `shared/tasks/rounds.ts`——**前端也必须缝合**
 * （任务明细要显示全部轮次历史），放服务端会逼前端再写一份推导，那就是两个真相
 * （ADR-009 §1）。于是这里**只再导出**（见 `server/events/index.ts`），
 * **绝不重新实现一份**：「除这两个以外，任何模块不得自行拼装 `RecurrenceTemplate`
 * 或 `RoundCompletion`」（ADR-013 §3 明文）。
 *
 * 它现在的签名是**结构化的**（吃 `{ eventId, accountId, payload }` 而不是 `Event<P>`），
 * 因为 `shared/` 不得 import `server/`——而这三个值本来就取自**事件行**
 * （`id` 列 / `account_id` 列 / 载荷），收窄的只是签名，行为一字未变。
 */

/** 阶段 4 登记的全部任务事件定义 */
export const taskEventDefinitions: readonly RegisteredDefinition[] = [
  taskCreatedDefinition,
  taskUpdatedDefinition,
  taskRescheduledDefinition,
  taskStatusChangedDefinition,
  taskReorderedDefinition,
  taskOccurrenceCompletedDefinition,
  taskOccurrenceUncompletedDefinition,
  taskDeletedDefinition,
  taskStepAddedDefinition,
  taskStepRemovedDefinition,
  taskStepRenamedDefinition,
  taskStepToggledDefinition,
  taskStepsReorderedDefinition,
]
