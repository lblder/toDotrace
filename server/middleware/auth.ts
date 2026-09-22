import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { forbidden, internalError, invalidToken, missingToken } from '../lib/errors.js'
import { isExpired, isoAfterMsUtc, nowIsoUtc } from '../lib/time.js'
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
export interface RequireAuthOptions {
  /**
   * 只读校验：**不续期、不 touch `last_seen_at`、也不清理过期会话行**。
   *
   * 供 OPTIONS 关口使用（ADR-008 §8 补遗 10）：那里只需要回答「令牌是否有效」，
   * 走完整鉴权会让一个 404 产生写副作用，且任何人拿有效令牌发一次 OPTIONS
   * 就能把该账号的「最近活跃」顶到当前时间——它实际上什么都没做。
   */
  readOnly?: boolean
}

export function createRequireAuth(
  db: Db,
  config: Config,
  options: RequireAuthOptions = {},
): RequestHandler {
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
      // 只读模式下不写库：清理交给下一次真实请求做。
      if (!options.readOnly) deleteSessionById(db, found.session.id)
      next(invalidToken())
      return
    }

    if (options.readOnly) {
      req.auth = { user: found.user, session: found.session }
      next()
      return
    }

    // 续期写的是 `sessions` / `users` 的时间列——**账号域**，一律 UTC 口径（ADR-010 §1）：
    // 这些列只表达绝对时刻，没有归属日。事件行的口径与这里无关（事件走事件层）。
    const now = nowIsoUtc()
    const expiresAt = isoAfterMsUtc(config.sessionTtlMs)
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
