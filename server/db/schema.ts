import type { Db } from './connection.js'

/**
 * 模式初始化。版本用 `PRAGMA user_version` 记录，不建迁移表（ADR-008 §3）。
 *
 * DDL 逐字符对应 ADR 的正文——表结构是冻结契约的一部分，改动必须先改 ADR：
 *   - v1：ADR-008 §3 的三张表与索引；
 *   - v2：ADR-010 §1（events）、§6（settings）、ADR-011 §1（recurrence_templates）；
 *   - v3：ADR-012 §2（days）；
 *   - v4：ADR-013 §5（tasks，取代 recurrence_templates）、ADR-016 §6（projects）、
 *         ADR-017 §6（day_notes）——**同一次迁移的三半**，不是先后三次改动。
 */

export const SCHEMA_VERSION = 5

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

/**
 * v4：任务实体、项目周期、每日备注（ADR-013 §5、ADR-016 §6、ADR-017 §6）。
 *
 * **三张表属于同一次迁移**：`tasks` 是 `recurrence_templates` 的取代（任务 = 定义 + 可选的重复规则），
 * `projects` 是任务的项目归属锚点，`day_notes` 是 ADR-012 §1 推迟到阶段 4 的每日备注。
 * 六条口径逐条落在下面的 DDL 里（每条都在 SQL 注释里写了理由，不在此重述）：
 *
 * 1. **`recurrence_templates` 只在 v2 存在**：本版把它的数据搬进 `tasks` 后**DROP**——
 *    留着它会让「表名与模式版本对不上」，而事件层的扫描清单里也会多一个已废弃的表。
 *    迁移照常写全量拷贝：实测该表交付时为 0 行，但「这次是空的」不是可以省略数据的理由；
 * 2. **`tasks` 没有 `carry_count` 列**：顺延次数是派生量（`task/rescheduled` 事件的条数），
 *    由 ADR-002 §2「派生量一律计算，不落库」定，见 ADR-013 §4.3；
 * 3. **三个日期锚点的 CHECK 一律用加固写法** `date(x) IS NOT NULL AND date(x) = x`：
 *    只写 `date(x) = x` 时，`date('garbage')` 返回 NULL、`NULL = 'garbage'` 求值为 NULL，
 *    而 SQLite 的 CHECK **只在求值为 false 时拒绝** ⇒ 畸形串全部放行（ADR-013 §5 已实测）；
 * 4. **周锚点的 CHECK 必须同时要求 `date(planned_week) IS NOT NULL`**：`strftime` 解析不了
 *    同样返回 NULL，`NULL = '1'` 也放行（同上，ADR-016 §1 已实测）；
 * 5. **「重复任务不得带日期锚点」与「三列同生共死」由 CHECK 兜底**（ADR-013 §3.1 的升级）：
 *    载荷侧还有一道 `zod .superRefine`，**两道都要有**——载荷把关挡正常路径，
 *    CHECK 挡绕过路由的写入（导入、测试构造）；只留一道时，失去的那一道失效不会有任何症状；
 * 6. **`projects` 不加外键**（ADR-016 §6 实测过的三条理由）：复合外键上的 `ON DELETE SET NULL`
 *    会把 `account_id` 一并置空（NOT NULL）⇒ 删除项目直接写不进去；且项目是软删除、
 *    行永不 `DELETE`，任何 `ON DELETE` 动作永不触发——声明的约束与实际生效的约束不一致，
 *    比不声明更危险（02 §11 教训 3 的形状）。
 */
const DDL_V4 = `
CREATE TABLE tasks (
  id               TEXT NOT NULL,                       -- UUIDv7
  account_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  notes            TEXT NOT NULL DEFAULT '',
  importance       TEXT NOT NULL CHECK (importance IN ('low','normal','high')),
  planned_date     TEXT,                                -- dayKey，可空（日级锚点）
  planned_week     TEXT,                                -- dayKey，可空（周级锚点）；非空时必须为周一
  due_date         TEXT,                                -- dayKey，可空
  tags_json        TEXT NOT NULL,                       -- string[]
  project_id       TEXT,                                -- 可空；见 ADR-016
  status           TEXT NOT NULL
                     CHECK (status IN ('not_started','in_progress','abandoned')),
  -- 没有 carry_count 列：顺延次数是派生量，由 task/rescheduled 事件条数算出
  manual_order     REAL,                                -- 可空 = 未手动排过
  steps_json       TEXT NOT NULL,                       -- Step[]，**仅步骤定义**；勾选由事件固化，不进表
  index_date       TEXT NOT NULL,                       -- 实例键；**取自 task/created 的 day_key**（ADR-013 §2）
  recurrence_json  TEXT,                                -- RecurrenceRule；NULL = 不重复
  next_anchor_mode TEXT
                     CHECK (next_anchor_mode IN ('extend','catch_up','recompute')),
  starts_on        TEXT,
  deleted_at       TEXT,                                -- 软删除时刻；NULL = 未删除
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- 三列同生共死：有规则必有锚点模式与起点，没有则三者皆空。
  -- 把「不合法组合不可表达」做成结构约束，而不是靠写入方自觉。
  CHECK ((recurrence_json IS NULL) = (next_anchor_mode IS NULL)),
  CHECK ((recurrence_json IS NULL) = (starts_on IS NULL)),
  -- 每个 dayKey 列都必须是**规范形态的真实日历日**（加固写法，理由见上方第 3 条）
  CHECK (planned_date IS NULL OR (date(planned_date) IS NOT NULL AND date(planned_date) = planned_date)),
  CHECK (due_date     IS NULL OR (date(due_date)     IS NOT NULL AND date(due_date)     = due_date)),
  CHECK (date(index_date) IS NOT NULL AND date(index_date) = index_date),
  CHECK (starts_on    IS NULL OR (date(starts_on)    IS NOT NULL AND date(starts_on)    = starts_on)),
  -- 三层锚点互斥：日级与周级不得同时非空（ADR-016 §1）
  CHECK (planned_date IS NULL OR planned_week IS NULL),
  -- 周级锚点必须落在周一。strftime 的 %w 以 0=周日，故周一为 '1'（加固写法，理由见上方第 4 条）
  CHECK (planned_week IS NULL
         OR (date(planned_week) IS NOT NULL
             AND date(planned_week) = planned_week
             AND strftime('%w', planned_week) = '1')),
  -- 重复任务不得带任何日期锚点（ADR-013 §3.1；CHECK 兜底，理由见上方第 5 条）
  CHECK (recurrence_json IS NULL
         OR (planned_date IS NULL AND planned_week IS NULL AND due_date IS NULL)),
  PRIMARY KEY (account_id, id)
);
CREATE INDEX idx_tasks_account  ON tasks(account_id);
CREATE INDEX idx_tasks_planned  ON tasks(account_id, planned_date);
CREATE INDEX idx_tasks_week     ON tasks(account_id, planned_week);
CREATE INDEX idx_tasks_project  ON tasks(account_id, project_id);

-- 迁移方式：建新表 + 拷数据 + 删旧表（SQLite 不能经 ALTER 去掉 NOT NULL）。
-- 旧模板的 index_date 取 starts_on：ADR-011 §1 明言 startsOn 是「首轮的原计划日期起点」，
-- 且重复模板恰好没有别的日期可用。于是老数据迁移后的实例键恰好等于其第一轮的
-- originalPlannedDate——若该模板已有一轮完成记录，迁移后那一轮仍显示为已完成。
INSERT INTO tasks (id, account_id, title, notes, importance, planned_date, planned_week,
                   due_date, tags_json, project_id, status, manual_order,
                   steps_json, index_date, recurrence_json, next_anchor_mode, starts_on,
                   deleted_at, created_at, updated_at)
SELECT id, account_id, title, '', 'normal', NULL, NULL, NULL,
       '[]', NULL, 'not_started', NULL,
       '[]',
       starts_on,
       rule_json, next_anchor_mode, starts_on, NULL,
       created_at, updated_at
  FROM recurrence_templates;
-- 列数 20 / 值数 20（carry_count 已按 ADR-002 §2 去掉，它由事件派生）

DROP TABLE recurrence_templates;

CREATE TABLE projects (
  id          TEXT NOT NULL,                    -- UUIDv7
  account_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  starts_on   TEXT NOT NULL,                    -- dayKey，**含**
  ends_on     TEXT NOT NULL,                    -- dayKey，**含**
  is_current  INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  deleted_at  TEXT,                             -- 软删除时刻；NULL = 未删除
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, id),
  -- 起晚于止不可表达。DayKey 是零填充定宽 'YYYY-MM-DD'，TEXT 序即时间序
  CHECK (ends_on >= starts_on),
  -- 已删除的项目不能是当前项目（ADR-016 §4）
  CHECK (NOT (is_current = 1 AND deleted_at IS NOT NULL))
);
CREATE INDEX idx_projects_account ON projects(account_id);
CREATE INDEX idx_projects_range   ON projects(account_id, starts_on, ends_on);
-- 「至多一个当前项目」由结构保证，不靠写入方自觉
CREATE UNIQUE INDEX idx_projects_current ON projects(account_id) WHERE is_current = 1;

CREATE TABLE day_notes (
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key    TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, day_key)
);
`

/** 暂离区间属于可重建的打卡投影，旧记录以空数组兼容。 */
const DDL_V5 = `ALTER TABLE days ADD COLUMN breaks_json TEXT NOT NULL DEFAULT '[]';`

/** 全部版本的 DDL 文本，按版本升序。 */
export function allDdl(): readonly string[] {
  return [DDL_V1, DDL_V2, DDL_V3, DDL_V4, DDL_V5]
}

/** 读取当前模式版本。 */
export function getSchemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }))
}

/**
 * v4 的**事件层前置检查**（ADR-013 §5.1）——不通过就拒绝升级，且**不迁移一个字节**。
 *
 * 迁移只搬 `recurrence_templates` 的**投影**，而 v4 同时删掉了四个 `recurrence/*` 事件类型定义；
 * `registry.ts` 规定「未登记的类型一律拒绝重放」⇒ **任何一条存量的 `recurrence/template-created`
 * / `-updated` / `-deleted` / `round-completed` 在 v4 之后都会让 `project()` 抛错**，
 * 而 `rebuildProjection` 在撤销与覆盖导入时会被调用 → **该账号的全部写操作开始失败，
 * 且用户看不到原因**。
 *
 * **为什么选择「拒绝」而不是「自动改写这些事件」**：改写需要把 `templateId → taskId`、
 * `nextAnchorDate` + `nextAnchorMode → next: { date, mode }` 逐个转换，而本仓的库里
 * **一条这样的数据都没有**（交付前实测）——**写一个没有任何真实样本可测的转换器，
 * 是把一个可测的失败换成一个不可测的成功**。拒绝是可测的：确定的输入、确定的输出。
 *
 * **代价如实记**：如果将来真有人的库里有这类事件，他必须手工处理。
 * 这比让他「升级后账号静默写不进东西」要好——前者可见，后者不可见。
 */
function assertNoLegacyRecurrenceEvents(db: Db): void {
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM events
        WHERE type LIKE 'recurrence/%'
        GROUP BY type ORDER BY type`,
    )
    .all() as { type: string; n: number }[]
  if (rows.length === 0) return

  const total = rows.reduce((sum, row) => sum + row.n, 0)
  const detail = rows.map((row) => `${row.type} (${row.n} 条)`).join('、')
  throw new Error(
    `数据库升级中止：事件流水里有 ${total} 条属于阶段 2 旧模型（recurrence/*）的事件——${detail}。` +
      '本版本已把重复规则并入 tasks，这四类事件没有对应的类型定义，重放时会抛错' +
      '（「投影 = 重放结果」这条不变式会被破坏，账号将无法写入）。' +
      '请先导出备份并联系升级路径，不要用本程序写这个库。',
  )
}

/**
 * 建表并落版本号。
 * - 库版本高于本程序支持的版本 → 拒绝启动（不猜测未来模式）；
 * - 库版本低于当前 → 逐版本升级（v0 → v1 → v2 → v3 → v4）。
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
    if (current < 4) {
      // 前置检查必须**先于**任何 DDL：不通过时整个事务回滚，库停留在 v3 原样。
      // 它读的 `events` 表由 DDL_V2 建（v0/v1 的库刚建出来，必然是空的）。
      assertNoLegacyRecurrenceEvents(db)
      db.exec(DDL_V4)
    }
    // user_version 的写入同样在事务内，与建表同生共死。
    if (current < 5) db.exec(DDL_V5)

    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })
  upgrade()
  return getSchemaVersion(db)
}
