import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { Db } from '../db/connection.js'
import { parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'
import { patchSettings, readSettings } from '../settings/service.js'

/**
 * 设置路由（ADR-017 §1.5 / §7）。
 *
 * | 方法 | 路径 | 请求 |
 * |---|---|---|
 * | GET | `/api/settings` | — → `{ timeZone, dayStartHour, updatedAt, affectsFrom }` |
 * | PATCH | `/api/settings` | `{ timeZone?, dayStartHour? }` |
 *
 * `.strict()` 让 `accountId`（ADR-017 §5 的最高优先级约束）以及任何不认识的字段
 * 一律 400：设置是**账号级**的，它的归属由鉴权上下文唯一决定，
 * 请求体里根本不该出现「这是谁的设置」这个问题。
 *
 * `PATCH` 的字段都可选，故 `{}` 是合法载荷——它写入一条与原值相同的
 * `settings/updated`（`updatedAt` 因此前移）。这里**不另立「至少要给一个字段」的规则**：
 * 那是 ADR 里没有的约束，而它带来的保护只是省下一条冗余事件。
 */

const settingsPatchSchema = z
  .object({
    // 时区是否**可解析**的判定不在 schema 里，而在服务层（`isIanaTimeZone`）：
    // 它是与事件层同一份判据，两处各写一份会分叉（ADR-009 §9 的口径很细）。
    timeZone: z.string().min(1, '时区名不能为空').optional(),
    dayStartHour: z.number().int('dayStartHour 必须是整数').min(0).max(23, 'dayStartHour 取值 0–23').optional(),
  })
  .strict()

export function settingsRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/', (req, res) => {
    const accountId = getAuth(req).user.id
    res.json(readSettings(db, accountId, new Date()))
  })

  router.patch('/', (req, res) => {
    const accountId = getAuth(req).user.id
    const patch = parseInput(settingsPatchSchema, req.body ?? {})
    const result = db.transaction(() => patchSettings(db, accountId, new Date(), patch))()
    res.status(200).json(result)
  })

  return router
}
