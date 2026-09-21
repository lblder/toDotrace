import { Router, type RequestHandler } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { login, logout, registerWithInvite } from '../domain/accounts.js'
import type { LoginThrottle } from '../domain/login-throttle.js'
import { asyncHandler } from '../lib/http.js'
import { parseBearerToken } from '../lib/token.js'
import { toPublicUser } from '../repo/users.js'
import { getAuth } from '../middleware/auth.js'
import { loginSchema, parseInput, registerSchema } from '../lib/validate.js'

/**
 * 会话（ADR-008 §2）
 *   POST /api/auth/login    → { user, token }
 *   POST /api/auth/logout   → 204（需要令牌）
 *   GET  /api/auth/me       → { user }（需要令牌）
 *   POST /api/auth/register → { user, token }（凭邀请码）
 */
export function authRoutes(
  db: Db,
  config: Config,
  throttle: LoginThrottle,
  requireAuth: RequestHandler,
): Router {
  const router = Router()

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const input = parseInput(loginSchema, req.body ?? {})
      const result = await login(db, config, throttle, input)
      res.status(200).json(result)
    }),
  )

  router.post('/logout', requireAuth, (req, res) => {
    const token = parseBearerToken(req.header('authorization'))
    if (token !== null) logout(db, token)
    res.status(204).end()
  })

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: toPublicUser(getAuth(req).user) })
  })

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const input = parseInput(registerSchema, req.body ?? {})
      const result = await registerWithInvite(db, config, input)
      res.status(200).json(result)
    }),
  )

  return router
}
