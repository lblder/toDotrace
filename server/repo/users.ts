import type { Db } from '../db/index.js'

export type Role = 'owner' | 'member'

export interface UserRow {
  id: string
  username: string
  display_name: string
  role: Role
  password_hash: string
  created_at: string
  last_seen_at: string | null
}

/** 接口响应里的 user 对象形态（ADR-008 §2）：只给前端真正需要的字段。 */
export interface PublicUser {
  id: string
  username: string
  displayName: string
  role: Role
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
  }
}

export function countUsers(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
}

/** 是否已存在 owner——首启引导的闸门（ADR-008 §2）。 */
export function ownerExists(db: Db): boolean {
  const row = db.prepare("SELECT 1 AS x FROM users WHERE role = 'owner' LIMIT 1").get()
  return row !== undefined
}

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
}

export function insertUser(
  db: Db,
  input: {
    id: string
    username: string
    displayName: string
    role: Role
    passwordHash: string
    createdAt: string
  },
): void {
  db.prepare(
    `INSERT INTO users (id, username, display_name, role, password_hash, created_at, last_seen_at)
     VALUES (@id, @username, @displayName, @role, @passwordHash, @createdAt, NULL)`,
  ).run(input)
}

/** 成员列表：owner 可见的字段（用户名、显示名、角色、注册时间、最近活跃）。 */
export function listUsers(db: Db): UserRow[] {
  return db
    .prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC')
    .all() as UserRow[]
}

export function touchLastSeen(db: Db, userId: string, at: string): void {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, userId)
}
