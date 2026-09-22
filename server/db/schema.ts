import type { Db } from './connection.js'

/**
 * 模式初始化。版本用 `PRAGMA user_version` 记录，不建迁移表（ADR-008 §3）。
 *
 * DDL 逐字符对应 ADR 的正文——表结构是冻结契约的一部分，改动必须先改 ADR：
 *   - v1：ADR-008 §3 的三张表与索引；
 *   - v2：ADR-010 §1（events）、§6（settings）、ADR-011 §1（recurrence_templates）；
 *   - v3：ADR-012 §2（days）。
 */

export const SCHEMA_VERSION = 3

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

/**
 * v2：事件流水 + 阶段 2 的两张投影表（ADR-010 §1 / §6、ADR-011 §1）。
 *
 * `events` 的主键是**复合的**（`account_id, id`），**不是 id 全局唯一**——理由见 ADR-010 §1：
 * 同一个 id 在两个账号下各有一份副本，「同一文件导入两次 = 0 新增」的幂等性在**账号范围内**成立。
 *
 * 本地写入序用 SQLite 内建的 `rowid`，**不额外建列**，且**不参与重放排序**
 * （本条取代 ADR-001 §1 的 `seq` 列条款）。
 */
const DDL_V2 = `
CREATE TABLE events (
  id             TEXT NOT NULL,                   -- UUIDv7。重放排序键就是它（ADR-001 §2）
  account_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,                   -- 动作类别，单表判别字段（ADR-001 §3）
  occurred_at    TEXT NOT NULL,                   -- ISO 8601 带偏移
  timezone       TEXT NOT NULL,                   -- IANA
  day_key        TEXT NOT NULL,                   -- 写入时按当时的 day_start_hour 固化，永不重算
  day_start_hour INTEGER NOT NULL,                -- 折算所用设置，使「这天为什么归到这天」可解释
  target_kind    TEXT,                            -- 关联对象类别；为 NULL 表示不针对特定对象
  target_id      TEXT,                            -- 关联对象标识
  batch_id       TEXT NOT NULL,                   -- 一次用户动作 = 一个批次（ADR-006 §1）
  payload        TEXT NOT NULL,                   -- JSON，写入时按 type 的 schema 校验
  appended_at    TEXT NOT NULL,                   -- 服务端接收时刻（离线导入时与 occurred_at 不同）
  PRIMARY KEY (account_id, id)
);

CREATE INDEX idx_events_batch  ON events(batch_id);
CREATE INDEX idx_events_target ON events(account_id, target_kind, target_id);

CREATE TABLE recurrence_templates (
  id               TEXT NOT NULL,                 -- UUIDv7
  account_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  rule_json        TEXT NOT NULL,                 -- RecurrenceRule，见 ADR-011 §2
  next_anchor_mode TEXT NOT NULL
                     CHECK (next_anchor_mode IN ('extend','catch_up','recompute')),
  starts_on        TEXT NOT NULL,                 -- 首轮的「原计划日期」起点（dayKey）
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- 复合主键，不是 id 全局唯一：B 导入 A 导出的同一份文件（ADR-005 明确允许、
  -- FR3 的换机迁移）时，两个账号各持一份同 id 的模板副本。ADR-010 §1 为 events
  -- 写下的理由逐字适用于本表——早先的全局主键在实测中直接炸出
  -- UNIQUE constraint failed: recurrence_templates.id（ADR-011 §1 已修正）。
  PRIMARY KEY (account_id, id)
);
CREATE INDEX idx_templates_account ON recurrence_templates(account_id);

CREATE TABLE settings (
  account_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  time_zone      TEXT NOT NULL,                   -- IANA 名；首次创建账号时取服务端本地时区
  day_start_hour INTEGER NOT NULL,                -- 0–23
  updated_at     TEXT NOT NULL
);
`

/**
 * v3：打卡日投影（ADR-012 §2）。
 *
 * **`arrived_at NOT NULL` 是这一版的关键约束**：`checkin/left` 必须配对到一次
 * 未闭合的到达（§5），且它对没有行的日子**不建行**（见 `definitions/checkin.ts`），
 * 因此每一行都必有到达。于是「**无行 ⇔ 无到达**」恒成立——
 * FR1 的「无到达记录 = 休息日」由「无行」直接判定，
 * ADR-002 §3 的「打卡天数 = COUNT(*)」原样成立（不需要 `WHERE arrival IS NOT NULL`）。
 *
 * ADR-012 §2 把这叫作「用结构保证不变式，而不是靠约定」：初稿允许的两条能产出
 * 「无到达的行」的路径（每日备注、未约束的 left）分别被**删去**与**约束**堵死。
 *
 * 主键 `(account_id, day_key)`：与 events / recurrence_templates 同一形态
 * （ADR-010 §1：标识的作用域是账号）。它同时是 `day_key` 范围查询的索引。
 */
const DDL_V3 = `
CREATE TABLE days (
  account_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key     TEXT NOT NULL,        -- 归属日，写入时固化（ADR-001 §4 / ADR-012 §5）
  arrived_at  TEXT NOT NULL,        -- ISO 8601 带偏移。**非空**，见上
  left_at     TEXT,                 -- 可空：无离开记录 = 时长未知（FR1）
  PRIMARY KEY (account_id, day_key)
);
`

/** 读取当前模式版本。 */
export function getSchemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }))
}

/**
 * 建表并落版本号。
 * - 库版本高于本程序支持的版本 → 拒绝启动（不猜测未来模式）；
 * - 库版本低于当前 → 逐版本升级（v0 → v1 → v2 → v3）。
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
    }
    if (current < 2) {
      // v2 的 DDL 引用 users(id)，故必须在 v1 之后建。
      db.exec(DDL_V2)
    }
    if (current < 3) {
      // v3 同样引用 users(id)；它不依赖 v2 的表，只依赖 v1 的 users。
      db.exec(DDL_V3)
    }
    // user_version 的写入同样在事务内，与建表同生共死。
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })
  upgrade()
  return getSchemaVersion(db)
}
