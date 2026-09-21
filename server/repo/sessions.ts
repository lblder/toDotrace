import type { Db } from '../db/index.js'
import type { UserRow } from './users.js'

export interface SessionRow {
  id: string
  user_id: string
  token_hash: string
  created_at: string
  expires_at: string
  last_used_at: string
}

export interface SessionWithUser {
  session: SessionRow
  user: UserRow
}

export function insertSession(
  db: Db,
  input: {
    id: string
    userId: string
    tokenHash: string
    createdAt: string
    expiresAt: string
  },
): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
     VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt, @createdAt)`,
  ).run(input)
}

/** 鉴权热点路径：按令牌哈希取会话并一并取出账号（一次查询，避免 N+1 式往返）。 */
export function findSessionWithUser(db: Db, tokenHash: string): SessionWithUser | undefined {
  const row = db
    .prepare(
      `SELECT
         s.id            AS s_id,
         s.user_id       AS s_user_id,
         s.token_hash    AS s_token_hash,
         s.created_at    AS s_created_at,
         s.expires_at    AS s_expires_at,
         s.last_used_at  AS s_last_used_at,
         u.id            AS u_id,
         u.username      AS u_username,
         u.display_name  AS u_display_name,
         u.role          AS u_role,
         u.password_hash AS u_password_hash,
         u.created_at    AS u_created_at,
         u.last_seen_at  AS u_last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as
    | {
        s_id: string
        s_user_id: string
        s_token_hash: string
        s_created_at: string
        s_expires_at: string
        s_last_used_at: string
        u_id: string
        u_username: string
        u_display_name: string
        u_role: UserRow['role']
        u_password_hash: string
        u_created_at: string
        u_last_seen_at: string | null
      }
    | undefined

  if (!row) return undefined
  return {
    session: {
      id: row.s_id,
      user_id: row.s_user_id,
      token_hash: row.s_token_hash,
      created_at: row.s_created_at,
      expires_at: row.s_expires_at,
      last_used_at: row.s_last_used_at,
    },
    user: {
      id: row.u_id,
      username: row.u_username,
      display_name: row.u_display_name,
      role: row.u_role,
      password_hash: row.u_password_hash,
      created_at: row.u_created_at,
      last_seen_at: row.u_last_seen_at,
    },
  }
}

/** 30 天滑动续期：每次成功鉴权更新 last_used_at 与 expires_at（ADR-008 §5）。 */
export function renewSession(
  db: Db,
  sessionId: string,
  input: { lastUsedAt: string; expiresAt: string },
): void {
  db.prepare('UPDATE sessions SET last_used_at = @lastUsedAt, expires_at = @expiresAt WHERE id = @id').run(
    { id: sessionId, lastUsedAt: input.lastUsedAt, expiresAt: input.expiresAt },
  )
}

/** 登出：立即删除该会话行（ADR-008 §5，不保留失效标记）。 */
export function deleteSessionByTokenHash(db: Db, tokenHash: string): number {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes
}

export function deleteSessionById(db: Db, sessionId: string): number {
  return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes
}

export function countSessionsForUser(db: Db, userId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId) as { n: number }
  ).n
}
