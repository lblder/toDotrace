import type { Db } from './connection.js'

/**
 * 模式初始化。版本用 `PRAGMA user_version` 记录，不建迁移表（ADR-008 §3）。
 *
 * DDL 逐字符对应 ADR-008 §3 的三张表与索引——表结构是冻结契约的一部分，
 * 改动必须先改 ADR。
 */

export const SCHEMA_VERSION = 1

const DDL_V1 = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                 -- UUIDv7
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','member')),
  password_hash TEXT NOT NULL,                    -- scrypt，格式见 ADR-008 §4
  created_at    TEXT NOT NULL,                    -- ISO 8601 带时区
  last_seen_at  TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                  -- UUIDv7
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,              -- SHA-256，见 ADR-008 §4
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_user_id    ON sessions(user_id);

CREATE TABLE invites (
  id         TEXT PRIMARY KEY,                    -- UUIDv7
  code_hash  TEXT NOT NULL UNIQUE,                -- SHA-256，见 ADR-008 §4
  issued_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);
CREATE INDEX idx_invites_code_hash ON invites(code_hash);
`

/** 读取当前模式版本。 */
export function getSchemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }))
}

/**
 * 建表并落版本号。
 * - 库版本高于本程序支持的版本 → 拒绝启动（不猜测未来模式）；
 * - 库版本低于当前 → 逐版本升级（阶段 1 只有 v1）。
 */
export function migrate(db: Db): number {
  const current = getSchemaVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库模式版本（${current}）高于本程序支持的版本（${SCHEMA_VERSION}）：` +
        '请升级程序或改用备份文件，不要用旧程序写新库。',
    )
  }
  if (current === SCHEMA_VERSION) return current

  const upgrade = db.transaction(() => {
    if (current < 1) {
      db.exec(DDL_V1)
      // user_version 的写入同样在事务内，与建表同生共死。
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }
  })
  upgrade()
  return getSchemaVersion(db)
}
