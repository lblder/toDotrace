import { Router } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { createOwner } from '../domain/accounts.js'
import { asyncHandler } from '../lib/http.js'
import { parseInput, setupOwnerSchema } from '../lib/validate.js'
import { ownerExists } from '../repo/users.js'

/**
 * 首启引导（ADR-008 §2）
 *   GET  /api/setup/status → { needsOwner }
 *   POST /api/setup/owner  → { user, token }（仅当无 owner 时可用，否则 409）
 */
export function setupRoutes(db: Db, config: Config): Router {
  const router = Router()

  router.get('/status', (_req, res) => {
    res.json({ needsOwner: !ownerExists(db) })
  })

  router.post(
    '/owner',
    asyncHandler(async (req, res) => {
      const input = parseInput(setupOwnerSchema, req.body ?? {})
      const result = await createOwner(db, config, input)
      res.status(200).json(result)
    }),
  )

  return router
}
