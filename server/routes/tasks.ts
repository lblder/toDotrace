import { Router, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { compareDayKey, isDayKey } from '@shared/time'
import { taskCreatedPayloadSchema, taskUpdatedPayloadSchema } from '../events/index.js'
import type { Db } from '../db/connection.js'
import { invalidInput } from '../lib/errors.js'
import { isUuidV7 } from '../lib/uuid.js'
import { assertNoBody, parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'
import {
  addStep,
  changeTaskStatus,
  completeOccurrence,
  createTask,
  deleteTask,
  getTaskDetail,
  listTasks,
  removeStep,
  renameStep,
  reorderSteps,
  reorderTask,
  rescheduleTasks,
  toggleStep,
  uncompleteOccurrence,
  updateTaskDefinition,
  type CreateTaskInput,
  type TaskDefinitionPatch,
  type TaskListQuery,
} from '../tasks/service.js'

/**
 * 任务路由（ADR-017 §1.1 / §1.2 / §3 / §4 / §9）。
 *
 * | 方法 | 路径 |
 * |---|---|
 * | GET | `/api/tasks?scope=today\|week\|range\|project\|all` |
 * | GET | `/api/tasks/:id` |
 * | POST | `/api/tasks` |
 * | PATCH | `/api/tasks/:id` |
 * | POST | `/api/tasks/:id/status` |
 * | POST | `/api/tasks/reschedule` |
 * | POST | `/api/tasks/:id/order` |
 * | DELETE | `/api/tasks/:id` |
 * | POST | `/api/tasks/:id/occurrences/:key/complete` · `/uncomplete` |
 * | POST | `/api/tasks/:id/steps` · PATCH/DELETE `/api/tasks/:id/steps/:stepId` · POST `…/toggle` · PUT `…/order` |
 *
 * ## 本文件只管入口契约
 *
 * 字段上限、`.strict()`、scope 解析、`accountId` 的来源——域判定全在 `tasks/service.ts`。
 * 这条分界与 `routes/checkin.ts` / `checkin/service.ts` 一致。
 *
 * ## `accountId` 取自鉴权上下文，**绝不来自请求体**（ADR-017 §5，本阶段最高优先级的约束）
 *
 * 每个处理器都写 `getAuth(req).user.id`。请求体里的 `accountId` / `account_id`
 * 由 `.strict()` **拒成 400**，不是被忽略：阶段 2 遗留的已知缺口是
 * 「`RoundCompletion.accountId` 漏填会抛错（响亮）、**填错则静默采纳**」，
 * 故「被拒」与「碰巧没事」的差别就是契约与侥幸的差别。
 *
 * ## 转写模型的一条不变量
 *
 * 请求体一律经 zod 解析后才进服务层；**跨行规则**（例如「已有日期锚点的任务不得加重复规则」）
 * 载荷层判不出来，由服务层读当前行再判——ADR-013 §3.1 的第 2 道，职责明确归服务层。
 */

/** 真实存在的日历日（`shared/time` 的 `isDayKey`，按**真实日历**判定，不是正则匹配） */
const dayKeySchema = z
  .string()
  .refine(isDayKey, '必须是真实存在的日历日（零填充定宽 YYYY-MM-DD）')

/** 实体主标识：ADR-001 §1「所有实体主标识是 UUIDv7」——客户端生成，服务端校验形态 */
const uuidV7Schema = z.string().refine(isUuidV7, '必须是 UUIDv7 形式的标识')

/**
 * 标签数组（ADR-017 §3）。
 *
 * **规范化在服务端做一次**：去首尾空白、丢弃空串、**按首次出现顺序去重**；
 * 大小写**不折叠**（中文场景无意义，且折叠会让用户输入的 `PCR` 显示成 `pcr`）。
 *
 * **上限施加在规范化之后**：「20 个标签」说的是这条任务最终带几个标签，
 * 去重前重复 20 次不是 20 个标签。
 *
 * 形状（`string[]`）复用 `task/updated` 载荷里的那一个，不另写一份——
 * 两处各写一份的后果是「路由收了、事件层拒了」，而 400 的文案会指着一个用户没写过的字段。
 */
const tagsSchema = taskUpdatedPayloadSchema.shape.tags
  .transform((tags) => normalizeTags(tags))
  .superRefine((tags, ctx) => {
    if (tags.length > TAG_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        message: `标签最多 ${TAG_LIMIT} 个（去重后实得 ${tags.length} 个）：超出说明在把标签当分类体系用（ADR-017 §3）`,
      })
    }
    for (const [index, tag] of tags.entries()) {
      if (tag.length > TAG_LENGTH_LIMIT) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `单个标签最多 ${TAG_LENGTH_LIMIT} 个字符（实得 ${tag.length} 个）：标签是便于界面呈现的短标记（ADR-017 §3）`,
        })
      }
    }
  })

export const TAG_LIMIT = 20
export const TAG_LENGTH_LIMIT = 50
export const TITLE_LENGTH_LIMIT = 500
export const NOTES_LENGTH_LIMIT = 20000
export const STEP_LIMIT = 100
export const RESCHEDULE_ITEM_LIMIT = 200

/** 步骤定义：`id` 由客户端生成（导入要保留原 id，ADR-017 §5.2） */
const stepInputSchema = z
  .object({ id: uuidV7Schema, title: z.string().min(1, '步骤标题不能为空') })
  .strict()

/**
 * 新建载荷（ADR-017 §3）。
 *
 * 字段形状**逐个复用 `task/created` 载荷 schema 的成员**（`taskCreatedPayloadSchema.shape`）：
 * 两处各写一份 `RecurrenceSpec` 的后果很具体——字段一旦不同步，解析器的输出会被服务端
 * 载荷 schema 拒绝，而症状是「预览显示解析成功、提交却 400」，用户看不出原因
 * （ADR-013 §3 的原话）。这里把那个风险**结构性地**去掉：形状只有一份，
 * 路由加的是**上限**（ADR-017 §3 的表格），事件层管的是**结构**。
 */
const createTaskSchema = z
  .object({
    taskId: taskCreatedPayloadSchema.shape.taskId.refine(isUuidV7, '必须是 UUIDv7 形式的标识'),
    title: taskCreatedPayloadSchema.shape.title.max(
      TITLE_LENGTH_LIMIT,
      `标题最多 ${TITLE_LENGTH_LIMIT} 个字符：长于一句标题的输入是误粘贴（ADR-017 §3）`,
    ),
    notes: taskCreatedPayloadSchema.shape.notes
      .max(NOTES_LENGTH_LIMIT, `备注最多 ${NOTES_LENGTH_LIMIT} 个字符：约 10 页文本，个人备注不会更长（ADR-017 §3）`)
      .optional(),
    importance: taskCreatedPayloadSchema.shape.importance.optional(),
    plannedDate: taskCreatedPayloadSchema.shape.plannedDate.optional(),
    plannedWeek: taskCreatedPayloadSchema.shape.plannedWeek.optional(),
    dueDate: taskCreatedPayloadSchema.shape.dueDate.optional(),
    tags: tagsSchema.optional(),
    projectId: taskCreatedPayloadSchema.shape.projectId.optional(),
    recurrence: taskCreatedPayloadSchema.shape.recurrence.optional(),
    steps: z
      .array(stepInputSchema)
      .max(STEP_LIMIT, `步骤最多 ${STEP_LIMIT} 条：单层步骤超过 100 条已不是清单（ADR-017 §3）`)
      .optional(),
  })
  .strict()

/**
 * `PATCH` 的载荷（ADR-017 §4）：**只有这六个字段**，且**给就要给全**（整行快照）。
 *
 * 不在这里的字段各有专属路由（`status` / `steps` / 三个日期锚点 / `manualOrder` / 删除），
 * **给出来即 400**——`.strict()` 就是那条「不静默忽略」的落点：
 * 静默忽略会让调用方以为自己改成功了。
 *
 * ⚠️ **`plannedWeek` 必须在排除清单里**（ADR-017 §4 的警告）：若让它进来，
 * `task/updated` 的载荷就会带上日期锚点，**直接否定 ADR-016 §9 行 3 的整条论证**
 * （「创建之后，日期锚点的唯一写入者是 `task/rescheduled`」）。
 */
const updateTaskSchema = z
  .object({
    title: taskUpdatedPayloadSchema.shape.title
      .max(TITLE_LENGTH_LIMIT, `标题最多 ${TITLE_LENGTH_LIMIT} 个字符（ADR-017 §3）`)
      .optional(),
    notes: taskUpdatedPayloadSchema.shape.notes
      .max(NOTES_LENGTH_LIMIT, `备注最多 ${NOTES_LENGTH_LIMIT} 个字符（ADR-017 §3）`)
      .optional(),
    importance: taskUpdatedPayloadSchema.shape.importance.optional(),
    tags: tagsSchema.optional(),
    projectId: taskUpdatedPayloadSchema.shape.projectId.optional(),
    recurrence: taskUpdatedPayloadSchema.shape.recurrence.optional(),
  })
  .strict()

/**
 * 批量顺延（ADR-017 §9）。**`plannedWeek` 必须在这个请求体里**——漏掉它的后果是
 * `plannedWeek` 在创建之后**永远无法修改**（`task/updated` 不带日期锚点，
 * 而 `task/rescheduled` 是创建之后日期锚点的唯一写入者，ADR-016 §9 行 3）。
 *
 * 三个日期字段**可省略**：省略 = 保持当前值，`null` = 清空（取舍见 `service.rescheduleTasks`）。
 */
const rescheduleSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            taskId: uuidV7Schema,
            plannedDate: dayKeySchema.nullable().optional(),
            plannedWeek: dayKeySchema.nullable().optional(),
            dueDate: dayKeySchema.nullable().optional(),
          })
          .strict(),
      )
      .min(1, 'items 不能为空：单条顺延即 items.length === 1（ADR-017 §9）')
      .max(RESCHEDULE_ITEM_LIMIT, `一次批量顺延最多 ${RESCHEDULE_ITEM_LIMIT} 条（ADR-017 §9）`),
  })
  .strict()

const statusSchema = z
  .object({ to: z.enum(['not_started', 'in_progress', 'abandoned']) })
  .strict()

const orderSchema = z
  .object({ manualOrder: z.number().refine(Number.isFinite, '必须是有限数') })
  .strict()

/**
 * 勾选载荷（ADR-017 §1.2）。**`originalPlannedDate` 不是可选参数**——
 * 省略即 `400`，**不回落成「任务的 `indexDate`」**：那个回落对单轮任务看起来正常，
 * 对重复任务则每次都在勾第一轮，症状是「勾了没反应」。
 */
const toggleStepSchema = z
  .object({ originalPlannedDate: dayKeySchema, checked: z.boolean() })
  .strict()

const stepTitleSchema = z.object({ title: z.string().min(1, '步骤标题不能为空') }).strict()

const stepsOrderSchema = z.object({ order: z.array(z.string().min(1)) }).strict()

/**
 * 列表参数（ADR-017 §1.1）。**排序与筛选不在服务端参数里**（§1.1 的理由），
 * 故 `?sort=` / `?status=` 这类参数在这里就被 `.strict()` 拒成 400。
 */
const listQuerySchema = z
  .object({
    scope: z.enum(['today', 'week', 'range', 'project', 'all']),
    from: dayKeySchema.optional(),
    to: dayKeySchema.optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict()

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const value = raw.trim()
    if (value === '') continue // 丢弃空串（含纯空白）
    if (seen.has(value)) continue // 按**首次出现顺序**去重；大小写不折叠
    seen.add(value)
    result.push(value)
  }
  return result
}

/** 路径参数（Express 的 `params` 是索引签名，`noUncheckedIndexedAccess` 下可能缺席） */
function pathParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidInput(`路径参数 ${name} 不能为空`)
  }
  return value
}

/** 路径里的 dayKey（`:key` / `:dayKey`）——非法即 400，**不透传给域层**（ADR-009 §7） */
function dayKeyParam(req: Request, name: string): string {
  const value = pathParam(req, name)
  if (!isDayKey(value)) {
    throw invalidInput(`${name} 必须是真实存在的日历日（零填充定宽 YYYY-MM-DD），实得 '${value}'`)
  }
  return value
}

/**
 * scope 解析（ADR-017 §1.1）。两条「多给字段」的拒绝都写在这里：
 *
 * - `range` 必须同时给 `from` 与 `to`，且 `from ≤ to`（`from > to` **不返回空数组**——
 *   静默返回空会让调用方以为「那段时间没有任务」，与 ADR-012 §3 对 `/days` 的处置同源）；
 * - 其余四个 scope 给出 `from` / `to` / `projectId` 即 400（静默忽略会让人以为它生效了）。
 */
export function parseTaskListQuery(query: unknown): TaskListQuery {
  const input = parseInput(listQuerySchema, query)
  switch (input.scope) {
    case 'range': {
      if (input.from === undefined || input.to === undefined) {
        throw invalidInput('scope=range 需要同时给出 from 与 to（闭区间，两端都含）')
      }
      if (compareDayKey(input.from, input.to) > 0) {
        throw invalidInput(`from（${input.from}）不能晚于 to（${input.to}）：闭区间为空`)
      }
      if (input.projectId !== undefined) {
        throw invalidInput('scope=range 不接受 projectId')
      }
      return { scope: 'range', from: input.from, to: input.to }
    }
    case 'project': {
      if (input.projectId === undefined) {
        throw invalidInput('scope=project 需要给出 projectId')
      }
      if (input.from !== undefined || input.to !== undefined) {
        throw invalidInput('scope=project 不接受 from / to：项目视图是**归属**判定，不是区间判定（ADR-015 §5）')
      }
      return { scope: 'project', projectId: input.projectId }
    }
    default: {
      if (input.from !== undefined || input.to !== undefined || input.projectId !== undefined) {
        throw invalidInput(`scope=${input.scope} 不接受 from / to / projectId`)
      }
      return { scope: input.scope }
    }
  }
}

export function taskRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/', (req, res) => {
    const accountId = getAuth(req).user.id
    const query = parseTaskListQuery(req.query)
    res.json(listTasks(db, accountId, new Date(), query))
  })

  router.get('/:id', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    res.json(getTaskDetail(db, accountId, new Date(), id))
  })

  router.post('/', (req, res) => {
    const accountId = getAuth(req).user.id
    const input = parseInput(createTaskSchema, req.body ?? {})
    const result = db.transaction(() =>
      createTask(db, accountId, new Date(), toCreateInput(input)),
    )()
    res.status(200).json(result)
  })

  router.patch('/:id', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const patch: TaskDefinitionPatch = parseInput(updateTaskSchema, req.body ?? {})
    const result = db.transaction(() =>
      updateTaskDefinition(db, accountId, new Date(), id, patch),
    )()
    res.status(200).json(result)
  })

  router.post('/:id/status', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const input = parseInput(statusSchema, req.body ?? {})
    const result = db.transaction(() =>
      changeTaskStatus(db, accountId, new Date(), id, input.to),
    )()
    res.status(200).json(result)
  })

  // 注册在 `/:id/...` 之前：`reschedule` 是固定段，写在后面会让 Express 先试 `:id`
  // （本路由族里没有 `POST /:id`，今天撞不上；把它放在前面是为了**将来**加 `POST /:id`
  // 时不必回头检查顺序）。
  router.post('/reschedule', (req, res) => {
    const accountId = getAuth(req).user.id
    const input = parseInput(rescheduleSchema, req.body ?? {})
    const result = db.transaction(() =>
      rescheduleTasks(db, accountId, new Date(), input.items),
    )()
    res.status(200).json(result)
  })

  router.post('/:id/order', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const input = parseInput(orderSchema, req.body ?? {})
    const result = db.transaction(() =>
      reorderTask(db, accountId, new Date(), id, input.manualOrder),
    )()
    res.status(200).json(result)
  })

  router.delete('/:id', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    assertNoBody(req.body)
    const result = db.transaction(() => deleteTask(db, accountId, new Date(), id))()
    res.status(200).json(result)
  })

  router.post('/:id/occurrences/:key/complete', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const key = dayKeyParam(req, 'key')
    assertNoBody(req.body)
    const result = db.transaction(() =>
      completeOccurrence(db, accountId, new Date(), id, key),
    )()
    res.status(200).json(result)
  })

  router.post('/:id/occurrences/:key/uncomplete', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const key = dayKeyParam(req, 'key')
    assertNoBody(req.body)
    const result = db.transaction(() =>
      uncompleteOccurrence(db, accountId, new Date(), id, key),
    )()
    res.status(200).json(result)
  })

  router.post('/:id/steps', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const input = parseInput(stepTitleSchema, req.body ?? {})
    const result = db.transaction(() => addStep(db, accountId, new Date(), id, input.title))()
    res.status(200).json(result)
  })

  // `PUT …/steps/order` 与 `PATCH …/steps/:stepId` 方法不同，不会互撞；
  // 仍然把它写在前面，理由同 `/reschedule`。
  router.put('/:id/steps/order', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const input = parseInput(stepsOrderSchema, req.body ?? {})
    const result = db.transaction(() => reorderSteps(db, accountId, new Date(), id, input.order))()
    res.status(200).json(result)
  })

  router.patch('/:id/steps/:stepId', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const stepId = pathParam(req, 'stepId')
    const input = parseInput(stepTitleSchema, req.body ?? {})
    const result = db.transaction(() =>
      renameStep(db, accountId, new Date(), id, stepId, input.title),
    )()
    res.status(200).json(result)
  })

  router.delete('/:id/steps/:stepId', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const stepId = pathParam(req, 'stepId')
    const result = db.transaction(() => removeStep(db, accountId, new Date(), id, stepId))()
    res.status(200).json(result)
  })

  router.post('/:id/steps/:stepId/toggle', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const stepId = pathParam(req, 'stepId')
    const input = parseInput(toggleStepSchema, req.body ?? {})
    const result = db.transaction(() =>
      toggleStep(db, accountId, new Date(), id, stepId, input.originalPlannedDate, input.checked),
    )()
    res.status(200).json(result)
  })

  return router
}

/** zod 的输出 → 服务层入参（默认值只在这里填一次，服务层不必再判 undefined） */
function toCreateInput(input: z.infer<typeof createTaskSchema>): CreateTaskInput {
  return {
    taskId: input.taskId,
    title: input.title,
    notes: input.notes ?? '',
    importance: input.importance ?? 'normal',
    plannedDate: input.plannedDate ?? null,
    plannedWeek: input.plannedWeek ?? null,
    dueDate: input.dueDate ?? null,
    tags: input.tags ?? [],
    projectId: input.projectId ?? null,
    recurrence: input.recurrence ?? null,
    steps: input.steps ?? [],
  }
}
