import { Router, type RequestHandler } from 'express'
import type { Db } from '../db/index.js'
import { listUsers } from '../repo/users.js'

/**
 * 成员列表（ADR-008 §2，**owner 专属**）
 *   GET /api/members → { members: [{ id, username, displayName, role, createdAt, lastSeenAt }] }
 *
 * 只给身份与活跃时间，**不含任何成员的数据内容**——隔离原则高于角色（架构文档 §3.3）。
 */
export function memberRoutes(db: Db, requireAuth: RequestHandler, requireOwner: RequestHandler): Router {
  const router = Router()

  router.use(requireAuth, requireOwner)

  router.get('/', (_req, res) => {
    const members = listUsers(db).map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }))
    res.json({ members })
  })

  return router
}
