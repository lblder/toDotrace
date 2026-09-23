import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { Db } from '../db/connection.js'
import { undoBatch } from '../events/undo.js'
import { parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'

/**
 * 撤销入口（ADR-017 §1.6 / §8）。
 *
 * | 方法 | 路径 | 请求 | 响应 |
 * |---|---|---|---|
 * | POST | `/api/undo` | `{ batchId }` | `{ batchId, revoked: true }` |
 *
 * `batchId` 由产生它的那个动作给出（`DELETE /api/tasks/:id` 与
 * `DELETE /api/projects/:id` 的响应里都有它；首次实现时也只有这两条路由会回带）。
 *
 * **服务端不设 30 秒窗口**（FR3：那是界面提示时长，不是能力边界）；
 * **不新增撤销机制**：阶段 5 的导入撤销同样走这个入口（届时 `batchId` 就是导入批次）。
 */

const undoSchema = z.object({ batchId: z.string().min(1, 'batchId 不能为空') }).strict()

export function undoRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)

  router.post('/', (req, res) => {
    const accountId = getAuth(req).user.id
    const input = parseInput(undoSchema, req.body ?? {})
    // 一次撤销 = 一个批次 = 一个事务（ADR-006 §1 / ADR-012 §4）。它自身也产生一个批次
    // （那条 `system/revoke` 事件），而那个批次**不可再被撤销**（ADR-006 的约束）。
    const result = db.transaction(() => undoBatch(db, accountId, new Date(), input.batchId))()
    res.status(200).json(result)
  })

  return router
}
