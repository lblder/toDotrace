import { Router, type RequestHandler } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { issueInvite } from '../domain/accounts.js'
import { asyncHandler } from '../lib/http.js'
import { createInviteSchema, parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'
import { listInvitesByIssuer } from '../repo/invites.js'

/**
 * 邀请码（ADR-008 §2，**owner 专属**）
 *   POST /api/invites → { invite: { id, code, expiresAt } }   code 仅此一次
 *   GET  /api/invites → { invites: [{ id, createdAt, expiresAt, usedBy, usedAt }] }  不含 code
 *
 * 邀请码撤销、修改有效期等不在阶段 1 范围内（ADR-008「明确不做」）。
 */
export function inviteRoutes(
  db: Db,
  config: Config,
  requireAuth: RequestHandler,
  requireOwner: RequestHandler,
): Router {
  const router = Router()

  router.use(requireAuth, requireOwner)

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseInput(createInviteSchema, req.body ?? {})
      const owner = getAuth(req).user
      const invite = issueInvite(db, config, owner.id, input.expiresInDays)
      res.status(200).json({ invite })
    }),
  )

  router.get('/', (req, res) => {
    const owner = getAuth(req).user
    const invites = listInvitesByIssuer(db, owner.id).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedBy: row.used_by,
      usedAt: row.used_at,
    }))
    res.json({ invites })
  })

  return router
}
