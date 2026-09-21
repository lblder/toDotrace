import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { forbidden, internalError, invalidToken, missingToken } from '../lib/errors.js'
import { isExpired, isoAfterMs, nowIso } from '../lib/time.js'
import { hashSecret, parseBearerToken } from '../lib/token.js'
import { deleteSessionById, findSessionWithUser, renewSession } from '../repo/sessions.js'
import { touchLastSeen } from '../repo/users.js'
import type { AuthContext } from '../types.js'

/**
 * 统一鉴权关口（架构文档 §3.2 / §9 必做 3）。
 *
 * - 认证方式：`Authorization: Bearer <token>`，不使用 Cookie（故无 CSRF 面）；
 * - 无令牌 / 令牌无效 / 令牌过期 → 401；
 * - 通过后把账号身份挂到 req.auth，后续所有路由据此做所有权与角色判断；
 * - 30 天滑动续期：每次成功鉴权更新 last_used_at 与 expires_at（ADR-008 §5）。
 */
export function createRequireAuth(db: Db, config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = parseBearerToken(req.header('authorization'))
    if (token === null) {
      next(missingToken())
      return
    }

    const found = findSessionWithUser(db, hashSecret(token))
    if (!found) {
      next(invalidToken())
      return
    }
    if (isExpired(found.session.expires_at)) {
      // 过期即清理该会话行，避免失效令牌长期留存。
      deleteSessionById(db, found.session.id)
      next(invalidToken())
      return
    }

    const now = nowIso()
    const expiresAt = isoAfterMs(config.sessionTtlMs)
    const touch = db.transaction(() => {
      renewSession(db, found.session.id, { lastUsedAt: now, expiresAt })
      touchLastSeen(db, found.user.id, now)
    })
    touch()

    const auth: AuthContext = {
      user: found.user,
      session: { ...found.session, last_used_at: now, expires_at: expiresAt },
    }
    req.auth = auth
    next()
  }
}

/** 取当前身份；未经 requireAuth 的路径上取到 null（属编程错误）。 */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw internalError()
  return req.auth
}

/**
 * owner 角色闸（ADR-008 §2 的 /api/invites 与 /api/members）。
 * **已认证但角色不足返回 403**——与「跨账号访问返回 404」是两回事：
 * 403 在这里不泄露任何他人数据，只说明调用者自己的角色不够。
 */
export const requireOwner: RequestHandler = (req, _res, next) => {
  const auth = getAuth(req)
  if (auth.user.role !== 'owner') {
    next(forbidden())
    return
  }
  next()
}
