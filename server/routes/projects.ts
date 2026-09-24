import { Router, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { isDayKey } from '@shared/time'
import { projectCreatedPayloadSchema, projectUpdatedPayloadSchema } from '../events/index.js'
import type { Db } from '../db/connection.js'
import { invalidInput } from '../lib/errors.js'
import { isUuidV7 } from '../lib/uuid.js'
import { assertNoBody, parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'
import {
  activateProject,
  clearCurrentProject,
  createProject,
  deleteProject,
  listProjects,
  reorderProjects,
  setProjectArchived,
  updateProject,
  type ProjectPatch,
} from '../projects/service.js'

/**
 * 项目路由（ADR-017 §1.3；语义见 ADR-016）。
 *
 * | 方法 | 路径 |
 * |---|---|
 * | GET | `/api/projects` |
 * | POST | `/api/projects` |
 * | PATCH | `/api/projects/:id` |
 * | DELETE | `/api/projects/:id` |
 * | POST | `/api/projects/:id/activate` |
 * | DELETE | `/api/projects/current` |
 *
 * ⚠️ **`DELETE /current` 必须注册在 `DELETE /:id` 之前**：Express 按注册顺序试匹配，
 * 反过来写的话 `DELETE /api/projects/current` 会命中 `:id`（把字符串 `current`
 * 当成项目标识），于是「取消当前项目」这条路由**永远不会被走到**，
 * 而症状是一个 404「项目不存在（current）」——看起来像用户用错了接口。
 * 这是本文件唯一一处**顺序即语义**的地方，故显式写在这里。
 *
 * 请求体一律 `.strict()`（ADR-008 §8：多给字段即 400），**`accountId` 不在任何载荷里**
 * （ADR-017 §5：它只能取自鉴权上下文）。
 */

const dayKeySchema = z
  .string()
  .refine(isDayKey, '必须是真实存在的日历日（零填充定宽 YYYY-MM-DD）')

/**
 * 新建载荷（ADR-017 §1.3）。
 *
 * 形状复用 `project/created` 载荷 schema 的成员（与 `routes/tasks.ts` 同一手法：
 * 形状只有一份，路由只加上限与默认值）。`makeCurrent` 是**路由层**的便利开关，
 * 它**不进事件载荷**——「新建并设为当前」是同一批次的两条事件（ADR-016 §5.5），
 * `isCurrent` 的唯一来源是 `project/current-changed`。
 */
const createProjectSchema = z
  .object({
    projectId: projectCreatedPayloadSchema.shape.projectId.refine(
      isUuidV7,
      '必须是 UUIDv7 形式的标识（客户端生成，ADR-016 §5.1）',
    ),
    name: projectCreatedPayloadSchema.shape.name,
    startsOn: projectCreatedPayloadSchema.shape.startsOn,
    endsOn: projectCreatedPayloadSchema.shape.endsOn,
    makeCurrent: z.boolean().optional(),
  })
  .strict()

/**
 * `PATCH` 的载荷：`{ name?, startsOn?, endsOn? }`（ADR-017 §1.3）。
 *
 * **`isCurrent` 不在其中**——它有专属入口（`…/activate` 与 `DELETE /current`）。
 * 「每个字段只有一个写入者」（ADR-013 §4.2）在这里的落法就是：当前项目只能被
 * `project/current-changed` 改，`PATCH` 给出来即 400（`.strict()`）。
 */
const updateProjectSchema = z
  .object({
    name: projectUpdatedPayloadSchema.shape.name.optional(),
    startsOn: projectUpdatedPayloadSchema.shape.startsOn.optional(),
    endsOn: projectUpdatedPayloadSchema.shape.endsOn.optional(),
  })
  .strict()

const projectOrderSchema = z.object({
  projectIds: z.array(z.string().refine(isUuidV7, 'projectId 必须是 UUIDv7')),
}).strict()

const archiveProjectSchema = z.object({ archived: z.boolean() }).strict()

function pathParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidInput(`路径参数 ${name} 不能为空`)
  }
  return value
}

export function projectRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/', (req, res) => {
    const accountId = getAuth(req).user.id
    res.json(listProjects(db, accountId, new Date()))
  })

  router.put('/order', (req, res) => {
    const accountId = getAuth(req).user.id
    const { projectIds } = parseInput(projectOrderSchema, req.body ?? {})
    res.json(db.transaction(() => reorderProjects(db, accountId, new Date(), projectIds))())
  })

  router.post('/', (req, res) => {
    const accountId = getAuth(req).user.id
    const input = parseInput(createProjectSchema, req.body ?? {})
    const result = db.transaction(() =>
      createProject(db, accountId, new Date(), {
        projectId: input.projectId,
        name: input.name,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        makeCurrent: input.makeCurrent ?? false,
      }),
    )()
    res.status(200).json(result)
  })

  // ⚠️ 顺序即语义：`/current` 在 `/:id` 之前（见文件头）。
  router.delete('/current', (req, res) => {
    const accountId = getAuth(req).user.id
    assertNoBody(req.body)
    const result = db.transaction(() => clearCurrentProject(db, accountId, new Date()))()
    res.status(200).json(result)
  })

  router.post('/:id/activate', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    assertNoBody(req.body)
    const result = db.transaction(() => activateProject(db, accountId, new Date(), id))()
    res.status(200).json(result)
  })

  router.patch('/:id/archive', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const { archived } = parseInput(archiveProjectSchema, req.body ?? {})
    res.json(db.transaction(() => setProjectArchived(db, accountId, new Date(), id, archived))())
  })

  router.patch('/:id', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    const patch: ProjectPatch = parseInput(updateProjectSchema, req.body ?? {})
    const result = db.transaction(() => updateProject(db, accountId, new Date(), id, patch))()
    res.status(200).json(result)
  })

  router.delete('/:id', (req, res) => {
    const accountId = getAuth(req).user.id
    const id = pathParam(req, 'id')
    assertNoBody(req.body)
    const result = db.transaction(() => deleteProject(db, accountId, new Date(), id))()
    res.status(200).json(result)
  })

  return router
}
