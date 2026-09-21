import type { Db } from '../db/index.js'

export interface InviteRow {
  id: string
  code_hash: string
  issued_by: string
  created_at: string
  expires_at: string
  used_by: string | null
  used_at: string | null
}

export function insertInvite(
  db: Db,
  input: {
    id: string
    codeHash: string
    issuedBy: string
    createdAt: string
    expiresAt: string
  },
): void {
  db.prepare(
    `INSERT INTO invites (id, code_hash, issued_by, created_at, expires_at, used_by, used_at)
     VALUES (@id, @codeHash, @issuedBy, @createdAt, @expiresAt, NULL, NULL)`,
  ).run(input)
}

export function findInviteByCodeHash(db: Db, codeHash: string): InviteRow | undefined {
  return db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(codeHash) as InviteRow | undefined
}

/** owner 可见的邀请码元信息**不含 code**（ADR-008 §2：码只在签发响应出现一次）。 */
export function listInvitesByIssuer(db: Db, issuerId: string): InviteRow[] {
  return db
    .prepare('SELECT * FROM invites WHERE issued_by = ? ORDER BY created_at DESC, id DESC')
    .all(issuerId) as InviteRow[]
}

/**
 * 标记邀请码已使用。`used_by IS NULL` 同时写在 WHERE 里，
 * 使「同一码被并发使用两次」在数据库层面被拒（changes === 0 → 调用方回 409）。
 */
export function markInviteUsed(db: Db, inviteId: string, userId: string, at: string): boolean {
  const result = db
    .prepare('UPDATE invites SET used_by = @userId, used_at = @at WHERE id = @id AND used_by IS NULL')
    .run({ id: inviteId, userId, at })
  return result.changes === 1
}
