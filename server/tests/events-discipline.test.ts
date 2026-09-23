import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, openMigratedDatabase, type Db } from '../db/index.js'
import { allDdl, getSchemaVersion, migrate, SCHEMA_VERSION } from '../db/schema.js'
import { EVENT_DEFINITIONS } from '../events/definitions/index.js'
import { buildRegistry, getEventDefinition, isRegisteredType, listRegisteredTypes } from '../events/registry.js'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { insertUser } from '../repo/users.js'

/**
 * 事件层的**纪律测试**：把 ADR-010 §约束 里那几条「不许」变成可执行的检查。
 *
 * 三条不许（原文）：
 *   1. 任何模块**不得**直接写投影表——只能经由事件追加（`rebuild` 除外）；
 *   2. 任何模块**不得**自行解析 `payload` 后绕过 `EventDefinition.apply` 改投影；
 *   3. `project()` 不得读写数据库、不得读时钟、不得读全局状态。
 *
 * 前两条靠**扫源码**（不是靠读代码时的人眼），第三条靠**扫 `project()` 及其定义文件的源码**
 * 加上 `events-project.test.ts` 的行为断言。源码扫描会被文本技巧骗过（注释、字符串拼接），
 * 它拦不住蓄意绕过的开发者——它拦的是「顺手写一行 UPDATE」这类无心之失，
 * 而那正是这类约束在真实项目里失效的方式。
 *
 * ## 阶段 4 修掉了扫描的三处结构性窟窿（ADR-013 §6 的复核清单）
 *
 * | 窟窿 | 修法 |
 * |---|---|
 * | 表名是**硬编码清单**（`writersOf(table)` 逐处调用）——新增 `tasks` / `projects` / `day_notes` 时**一个都不会被扫到** | 表名**从 DDL 自动发现**（`schemaTables()`），并断言「发现的表 == 声明了写入方的表」 |
 * | 正则漏 `INSERT OR REPLACE INTO` 与带引号的 `INSERT INTO "tasks"` ——两者都**没被抓到**（前者是顺手会写的惯用法，不是蓄意绕过） | 正则改为覆盖三种 INSERT 写法与引号形式 |
 * | 扫描根在 `server/`，结构上到不了 `shared/` | 根扩到 `shared/` / `server/` / `src/` 各一次 |
 *
 * ⚠️ **这三条是「它真的被强制了吗」的修复，不是新功能**：ADR-014 §8 曾声称
 * `shared/quickadd/**` 的导入白名单靠这套扫描实现「静态纪律」——照当时的扫描范围，
 * 那句话等于什么都没做（`shared/` 根本不在扫描范围内）。现在它在范围内了。
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SERVER_DIR = path.join(REPO_ROOT, 'server')

/**
 * 扫描根：`shared/` / `server/` / `src/` 各一次（仓库根的 `tests/` 是 playwright 用例，不在内）。
 * 路径一律相对**仓库根**输出——三个根共用一个基准，断言才写得清。
 */
const SCAN_ROOTS = ['shared', 'server', 'src'].map((dir) => path.join(REPO_ROOT, dir))

/** 各扫描根下除测试外的全部 .ts / .tsx 源文件 */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, found)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(full)
    }
  }
  return found
}

function allSources(): string[] {
  return SCAN_ROOTS.flatMap((root) => (fs.existsSync(root) ? sourceFiles(root) : []))
}

function readSource(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file)
}

/** 去掉注释后的源码：注释里写「INSERT INTO x」不是在写库 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 一条写语句的三个部分（ADR-013 §6 给的正则，逐字）。
 *
 * 覆盖 `INSERT INTO` / `INSERT OR REPLACE INTO` / `INSERT OR IGNORE INTO` /
 * `REPLACE INTO` / `UPDATE` / `DELETE FROM`，并允许表名带双引号
 * （`INSERT INTO "tasks"` 也是顺手会写的形态）。
 */
const WRITE_PATTERN =
  /\b(INSERT(\s+OR\s+(REPLACE|IGNORE))?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/gi

/** 源码里被写的全部表名（去重、升序） */
function writeTargets(source: string): string[] {
  const targets = new Set<string>()
  for (const match of stripComments(source).matchAll(WRITE_PATTERN)) {
    targets.add(match[4]!.toLowerCase())
  }
  return [...targets].sort()
}

/**
 * 迁移脚本自身（`db/schema.ts`）**排除在「谁写投影表」的扫描之外**——
 * 它的 v4 迁移要把旧表的数据拷进 `tasks` 一次（ADR-013 §5 明文给出的
 * `INSERT INTO tasks … SELECT … FROM recurrence_templates` + `DROP TABLE`）。
 * **它不是投影的写入方**：既不经过事件层，也只在建表那一刻执行一次。
 *
 * 「排除」不能变成窟窿，故下面有一条**正面断言**钉住它到底写了什么
 * （`schema.ts 只写一次 tasks`）——排除的是文件，不是「谁写都行」。
 */
const MIGRATION_FILE = path.join(SERVER_DIR, 'db/schema.ts')

/** 命中某张表的写语句（INSERT / UPDATE / DELETE） */
function writersOf(table: string): string[] {
  const pattern = new RegExp(
    `\\b(INSERT(\\s+OR\\s+(REPLACE|IGNORE))?\\s+INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"?${table}"?\\b`,
    'i',
  )
  return allSources()
    .filter((file) => file !== MIGRATION_FILE)
    .filter((file) => pattern.test(stripComments(readSource(file))))
    .map(relative)
    .sort()
}

/**
 * **表名从 DDL 自动发现**（ADR-013 §6 的第一条修法）。
 *
 * 判据是「当前模式版本的形状」：从全部版本的 DDL 里取 `CREATE TABLE`，
 * 再减去被 `DROP TABLE` 掉的（`recurrence_templates` 由 v4 删）。
 * 于是新增一张表时**必须有写入方声明**——`discovered == Object.keys(EXPECTED_WRITERS)`
 * 那条断言会红，而不是「新表悄悄不被扫描」。
 */
function schemaTables(): string[] {
  const ddl = allDdl().join('\n')
  const created = [...ddl.matchAll(/CREATE TABLE\s+"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase())
  const dropped = new Set(
    [...ddl.matchAll(/DROP TABLE\s+"?(\w+)"?/gi)].map((match) => match[1]!.toLowerCase()),
  )
  return [...new Set(created)].filter((table) => !dropped.has(table)).sort()
}

/**
 * 每张表的**期望写入方**。表名由 DDL 自动发现，这张表只回答「谁可以写它」——
 * 新增一张表却忘了在这里表态时，「发现的表 == 声明的表」那条断言会红。
 *
 * 五张**投影表**的唯一写入方都是 `projection-store.ts`（ADR-010 §约束）；
 * `events` 只增不改（事件不可变）；三张账号域的表各有自己的仓储。
 */
const EXPECTED_WRITERS: Record<string, readonly string[]> = {
  // 认证域：各自的仓储（不是投影表——它们不由事件重放得出）
  users: ['server/repo/users.ts'],
  sessions: ['server/repo/sessions.ts'],
  invites: ['server/repo/invites.ts'],
  // 事件流水：只 INSERT，不 UPDATE / DELETE（事件不可变，ADR-001 地基）
  events: ['server/events/event-store.ts'],
  // 投影表（ADR-010 §约束：只由 projection-store.ts 写）
  settings: ['server/events/projection-store.ts'],
  days: ['server/events/projection-store.ts'],
  // 阶段 4 新增的三张（ADR-013 §5 / ADR-016 §6 / ADR-017 §6）
  tasks: ['server/events/projection-store.ts'],
  projects: ['server/events/projection-store.ts'],
  day_notes: ['server/events/projection-store.ts'],
}

describe('投影表只有一个写入方（ADR-010 §约束）', () => {
  it('扫描目标与声明一致：DDL 里发现的每张表都在这里有写入方声明', () => {
    expect(schemaTables()).toEqual(Object.keys(EXPECTED_WRITERS).sort())
    // `recurrence_templates` 已由 v4 删除，故它不该出现在发现结果里
    expect(schemaTables()).not.toContain('recurrence_templates')
  })

  for (const [table, writers] of Object.entries(EXPECTED_WRITERS)) {
    it(`${table} 只被 ${writers.join(' / ')} 写`, () => {
      expect(writersOf(table)).toEqual(writers)
    })
  }

  it('events 只 INSERT——事件不可变（ADR-001 地基）', () => {
    const store = stripComments(readSource(path.join(SERVER_DIR, 'events/event-store.ts')))
    expect(store).not.toMatch(/\bDELETE\s+FROM\s+events\b/i)
    expect(store).not.toMatch(/\bUPDATE\s+events\b/i)
  })

  /**
   * 被排除在扫描之外的**只有迁移脚本**，且它写了什么必须写清楚：
   * 建表那一刻把旧表数据拷进 `tasks` 一次（ADR-013 §5 的迁移 SQL）。
   * 若哪天有人在 `schema.ts` 里加一条别的写入，这里先红。
   */
  it('db/schema.ts 只写一次 tasks（v4 迁移的建表拷贝），不碰任何其它表', () => {
    const source = stripComments(readSource(MIGRATION_FILE))
    expect(writeTargets(source)).toEqual(['tasks'])
    expect(source).toMatch(/INSERT\s+INTO\s+tasks[\s\S]*?FROM\s+recurrence_templates/i)
    expect(source).toMatch(/DROP\s+TABLE\s+recurrence_templates/i)
  })

  it('扫描真的覆盖到了 shared/ 与 src/（否则「静态纪律」是一句空话）', () => {
    const scanned = allSources().map(relative)
    expect(scanned.some((file) => file.startsWith('shared/'))).toBe(true)
    expect(scanned.some((file) => file.startsWith('src/'))).toBe(true)
    expect(scanned.some((file) => file.startsWith('server/'))).toBe(true)
    // 测试自身不在扫描范围内（否则断言里写一句 INSERT 就会被自己抓到）
    expect(scanned.some((file) => file.includes('/tests/'))).toBe(false)
  })

  it('三种 INSERT 写法与带引号的表名都能被抓到（正则的三处窟窿的回归）', () => {
    for (const sample of [
      'INSERT INTO tasks (id) VALUES (1)',
      'INSERT OR REPLACE INTO tasks (id) VALUES (1)',
      'INSERT OR IGNORE INTO tasks (id) VALUES (1)',
      'REPLACE INTO tasks (id) VALUES (1)',
      'INSERT INTO "tasks" (id) VALUES (1)',
      'UPDATE tasks SET title = 1',
      'DELETE FROM tasks',
    ]) {
      expect(writeTargets(sample), sample).toEqual(['tasks'])
    }
  })

  it('事件层的代码不自己开库连接（一律用注入的 Db）', () => {
    const offenders = sourceFiles(path.join(SERVER_DIR, 'events')).filter((file) =>
      /new\s+Database\s*\(/.test(stripComments(readSource(file))),
    )
    expect(offenders).toEqual([])
  })
})

describe('project() 的纯函数性（ADR-010 §4）', () => {
  it('重放与事件定义里没有时钟读取', () => {
    const files = [
      path.join(SERVER_DIR, 'events/project.ts'),
      ...sourceFiles(path.join(SERVER_DIR, 'events/definitions')),
    ]
    for (const file of files) {
      const source = stripComments(readSource(file))
      expect(source, `${relative(file)} 读了时钟`).not.toMatch(/\bDate\.now\s*\(|new\s+Date\s*\(/)
    }
  })

  it('重放与事件定义里没有数据库访问', () => {
    const files = [
      path.join(SERVER_DIR, 'events/project.ts'),
      ...sourceFiles(path.join(SERVER_DIR, 'events/definitions')),
    ]
    for (const file of files) {
      const source = stripComments(readSource(file))
      expect(source, `${relative(file)} 碰了库`).not.toMatch(
        /\bdb\s*\.\s*(prepare|exec|transaction|pragma)\b/,
      )
    }
  })
})

describe('注册表（ADR-010 §2）', () => {
  it('每个定义的成员形状固定：type / schema / apply（+ 可选的 target）', () => {
    // 逐类型写死形状，而不是「一个通用集合」：新增一个类型必须在这里表态
    // 「它有没有标识落点」——落点漏了不会报错，只会让 idx_events_target 查不到东西。
    const withoutTarget = ['apply', 'schema', 'type']
    const withTarget = ['apply', 'schema', 'target', 'type']
    const expectedShape: Record<string, string[]> = {
      'system/overwrite-anchor': withoutTarget,
      'system/revoke': withoutTarget,
      'settings/updated': withoutTarget,
      // 打卡事件（ADR-012 §1）：载荷为空对象，落点是「归属日」而非某个对象，
      // 故两列 target 为 NULL——与设置事件同类。
      'checkin/arrived': withoutTarget,
      'checkin/left': withoutTarget,
      // 每日备注（ADR-017 §6）同理：`dayKey` 是日期值，不是某个实体的标识
      'note/updated': withoutTarget,
      // 13 类任务事件的载荷都带 taskId，落点由载荷派生（ADR-013 §4）
      'task/created': withTarget,
      'task/updated': withTarget,
      'task/rescheduled': withTarget,
      'task/status-changed': withTarget,
      'task/reordered': withTarget,
      'task/occurrence-completed': withTarget,
      'task/occurrence-uncompleted': withTarget,
      'task/deleted': withTarget,
      'task/step-added': withTarget,
      'task/step-removed': withTarget,
      'task/step-renamed': withTarget,
      'task/step-toggled': withTarget,
      'task/steps-reordered': withTarget,
      // 项目事件（ADR-016 §5）：前三类的载荷带 projectId
      'project/created': withTarget,
      'project/updated': withTarget,
      'project/deleted': withTarget,
      // ⚠️ **`project/current-changed` 不声明 target**（ADR-016 §5.4 的明文例外）：
      // 载荷允许 `projectId: null`（一个真实状态），而 `fromPayload` 必须返回**非空字符串**——
      // 声明它会让这一类合法事件根本写不进去。
      'project/current-changed': withoutTarget,
    }
    expect(Object.keys(expectedShape).sort()).toEqual(
      EVENT_DEFINITIONS.map((definition) => definition.type).sort(),
    )
    for (const definition of EVENT_DEFINITIONS) {
      expect(Object.keys(definition).sort(), definition.type).toEqual(expectedShape[definition.type])
      expect(typeof definition.type).toBe('string')
      expect(typeof definition.apply).toBe('function')
      expect(typeof definition.schema.safeParse).toBe('function')
    }
  })

  it('声明了 target 的定义：kind 非空、fromPayload 是函数并能取到标识', () => {
    for (const definition of EVENT_DEFINITIONS) {
      if (definition.target === undefined) continue
      expect(typeof definition.target.kind).toBe('string')
      expect(definition.target.kind.length).toBeGreaterThan(0)
      expect(typeof definition.target.fromPayload).toBe('function')
    }
  })

  it('清单是冻结的，且类型名不重复', () => {
    expect(Object.isFrozen(EVENT_DEFINITIONS)).toBe(true)
    const types = EVENT_DEFINITIONS.map((definition) => definition.type)
    expect(new Set(types).size).toBe(types.length)
  })

  it('清单里的每个类型都能查到，且就是清单里那一个', () => {
    for (const definition of EVENT_DEFINITIONS) {
      expect(getEventDefinition(definition.type)).toBe(definition)
      expect(isRegisteredType(definition.type)).toBe(true)
    }
    expect([...listRegisteredTypes()].sort()).toEqual(
      EVENT_DEFINITIONS.map((definition) => definition.type).sort(),
    )
  })

  it('重复登记当场抛错（同一个 type 两个定义 = 重放结果取决于查表顺序）', () => {
    const duplicated = [EVENT_DEFINITIONS[0]!, EVENT_DEFINITIONS[0]!]
    expect(() => buildRegistry(duplicated)).toThrow(/重复登记/)
  })

  it('未登记的类型取定义即抛错，且错误信息说清「为什么」', () => {
    expect(() => getEventDefinition('task/archived')).toThrow(/未登记的事件类型/)
  })

  it('阶段 2 的四类 recurrence/* 已移除：未登记即拒写（ADR-013 §4 的取代）', () => {
    // 它们的事件一旦留在库里，`project()` 会抛错 ⇒ 该账号的全部写操作开始失败
    // （这正是 v4 迁移带一道事件层前置检查的理由，见下面的「模式 v4」组）。
    for (const type of [
      'recurrence/template-created',
      'recurrence/template-updated',
      'recurrence/template-deleted',
      'recurrence/round-completed',
    ]) {
      expect(isRegisteredType(type)).toBe(false)
      expect(() => getEventDefinition(type)).toThrow(/未登记的事件类型/)
    }
  })
})

/** 造一个停在 v3 的库：把 v1–v3 的 DDL 直接执行一遍（不经 `migrate`），再落版本号。 */
function openV3Database(dbPath: string): Db {
  const db = openDatabase(dbPath)
  const [v1, v2, v3] = allDdl()
  db.exec(v1!)
  db.exec(v2!)
  db.exec(v3!)
  db.pragma('user_version = 3')
  return db
}

describe('模式 v4（ADR-013 §5 / ADR-016 §6 / ADR-017 §6）', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-schema-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function freshDb(name: string): Db {
    return openDatabase(path.join(dir, name))
  }

  function tableNames(db: Db): string[] {
    return (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort()
  }

  function pkColumns(db: Db, table: string): string[] {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]
    return columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name)
  }

  /** 显式建的索引；`sqlite_autoindex_*` 是主键 / UNIQUE 自带的，不算 DDL 的一部分 */
  function indexNames(db: Db, table: string): string[] {
    return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_autoindex_'))
      .sort()
  }

  it('全新库一次迁到最新版，各版的表与索引都在', () => {
    const db = freshDb('v0.db')
    try {
      expect(getSchemaVersion(db)).toBe(0)
      expect(migrate(db)).toBe(SCHEMA_VERSION)
      expect(tableNames(db)).toEqual(
        expect.arrayContaining([
          'events',
          'settings',
          'days',
          'users',
          'sessions',
          'invites',
          // 阶段 4 的三张
          'tasks',
          'projects',
          'day_notes',
        ]),
      )
      // `recurrence_templates` **已被 DROP**——留着它会让表名与模式版本对不上，
      // 而扫描清单里也会多一个已废弃的表（ADR-013 §5）
      expect(tableNames(db)).not.toContain('recurrence_templates')
      expect(tableNames(db)).toEqual(schemaTables())

      expect(indexNames(db, 'events')).toEqual(['idx_events_batch', 'idx_events_target'])
      // days 没有额外索引：主键 (account_id, day_key) 自己就是范围查询的索引
      expect(indexNames(db, 'days')).toEqual([])
      expect(indexNames(db, 'tasks')).toEqual([
        'idx_tasks_account',
        'idx_tasks_planned',
        'idx_tasks_project',
        'idx_tasks_week',
      ])
      expect(indexNames(db, 'projects')).toEqual([
        'idx_projects_account',
        'idx_projects_current',
        'idx_projects_range',
      ])
      expect(indexNames(db, 'day_notes')).toEqual([])
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('events / tasks / projects 的主键是复合的 (account_id, id)，且没有 seq / carry_count 列', () => {
    const db = freshDb('pk.db')
    try {
      migrate(db)
      expect(pkColumns(db, 'events')).toEqual(['account_id', 'id'])
      const eventColumns = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
        (column) => column.name,
      )
      expect(eventColumns).not.toContain('seq')
      // 与 events 同理，**不是 id 全局唯一**——B 导入 A 导出的同一份文件时，
      // 两个账号各持一份同 id 的副本（ADR-013 §5）。
      expect(pkColumns(db, 'tasks')).toEqual(['account_id', 'id'])
      expect(pkColumns(db, 'projects')).toEqual(['account_id', 'id'])
      expect(pkColumns(db, 'settings')).toEqual(['account_id'])
      expect(pkColumns(db, 'days')).toEqual(['account_id', 'day_key'])
      expect(pkColumns(db, 'day_notes')).toEqual(['account_id', 'day_key'])
      // `carry_count` 不是列：顺延次数是派生量（ADR-013 §4.3）
      const taskColumns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
        (column) => column.name,
      )
      expect(taskColumns).not.toContain('carry_count')
    } finally {
      db.close()
    }
  })

  it('复合主键真的生效：同一 id 两个账号可共存，同账号内重复被拒', () => {
    const db = freshDb('composite.db')
    try {
      migrate(db)
      seedUser(db, 'u-a', 'usera')
      seedUser(db, 'u-b', 'userb')
      const insert = db.prepare(
        `INSERT INTO events
           (id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
            target_kind, target_id, batch_id, payload, appended_at)
         VALUES (?, ?, 'system/revoke', '2026-09-22T10:00:00+08:00', 'Asia/Shanghai',
                 '2026-09-22', 4, NULL, NULL, 'b1', '{}', '2026-09-22T10:00:00+08:00')`,
      )
      insert.run('same-id', 'u-a')
      expect(() => insert.run('same-id', 'u-a')).toThrow(/UNIQUE|PRIMARY KEY/i)
      expect(() => insert.run('same-id', 'u-b')).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('任务表的复合主键真的生效：同一任务 id 两个账号可共存（ADR-013 §5）', () => {
    const db = freshDb('task-pk.db')
    try {
      migrate(db)
      seedUser(db, 'u-ta', 'userta')
      seedUser(db, 'u-tb', 'usertb')
      const insert = db.prepare(
        `INSERT INTO tasks
           (id, account_id, title, notes, importance, planned_date, planned_week, due_date,
            tags_json, project_id, status, manual_order, steps_json, index_date,
            recurrence_json, next_anchor_mode, starts_on, deleted_at, created_at, updated_at)
         VALUES ('t-shared', ?, 'A', '', 'normal', NULL, NULL, NULL,
                 '[]', NULL, 'not_started', NULL, '[]', '2026-09-22',
                 NULL, NULL, NULL, NULL,
                 '2026-09-22T10:00:00+08:00', '2026-09-22T10:00:00+08:00')`,
      )
      insert.run('u-ta')
      expect(() => insert.run('u-ta')).toThrow(/UNIQUE|PRIMARY KEY/i)
      // 这条「不抛」就是复合主键的判据：导入的文件在两个账号下各有一份副本
      expect(() => insert.run('u-tb')).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('「至多一个当前项目」由**部分唯一索引**保证（ADR-016 §4）', () => {
    const db = freshDb('current.db')
    try {
      migrate(db)
      seedUser(db, 'u-p', 'userp')
      seedUser(db, 'u-q', 'userq')
      const insert = db.prepare(
        `INSERT INTO projects (id, account_id, name, starts_on, ends_on, is_current, deleted_at, created_at, updated_at)
         VALUES (?, ?, 'P', '2026-09-01', '2026-09-30', ?, NULL, '2026-09-01T10:00:00+08:00', '2026-09-01T10:00:00+08:00')`,
      )
      insert.run('p1', 'u-p', 1)
      // 同一个账号的第二个当前项目：被部分唯一索引拒绝
      expect(() => insert.run('p2', 'u-p', 1)).toThrow(/UNIQUE/i)
      // 不同账号各自有一个当前项目：互不影响
      expect(() => insert.run('p2', 'u-q', 1)).not.toThrow()
      // 非当前项目可以有任意多个
      expect(() => insert.run('p3', 'u-p', 0)).not.toThrow()
      // 「已删除的项目是当前项目」在结构上不可表达
      expect(() =>
        db
          .prepare(
            `INSERT INTO projects (id, account_id, name, starts_on, ends_on, is_current, deleted_at, created_at, updated_at)
             VALUES ('p4', 'u-p', 'P', '2026-09-01', '2026-09-30', 1, '2026-09-10T10:00:00+08:00', '2026-09-01T10:00:00+08:00', '2026-09-01T10:00:00+08:00')`,
          )
          .run(),
      ).toThrow(/CHECK/i)
      // 起晚于止不可表达
      expect(() =>
        db
          .prepare(
            `INSERT INTO projects (id, account_id, name, starts_on, ends_on, is_current, deleted_at, created_at, updated_at)
             VALUES ('p5', 'u-p', 'P', '2026-09-30', '2026-09-01', 0, NULL, '2026-09-01T10:00:00+08:00', '2026-09-01T10:00:00+08:00')`,
          )
          .run(),
      ).toThrow(/CHECK/i)
    } finally {
      db.close()
    }
  })

  it('days 的「每行必有到达」是**结构**保证的：没有 arrived_at 的行插不进去（ADR-012 §2）', () => {
    const db = freshDb('days-not-null.db')
    try {
      migrate(db)
      seedUser(db, 'u-d', 'userd')
      // ADR-012 §2 的原文是「用结构保证不变式，而不是靠约定」——
      // 这一条就是那句话的可执行形态：初稿允许的两条能产出「无到达的行」的路径
      //（每日备注、未约束的 left）分别被删去与约束堵死，
      // 剩下的最后一道闸门是 NOT NULL 本身。
      // 阶段 4 的**每日备注走独立表** `day_notes`（ADR-017 §6），故这条不变式不受影响。
      expect(() =>
        db
          .prepare('INSERT INTO days (account_id, day_key, arrived_at, left_at) VALUES (?, ?, NULL, NULL)')
          .run('u-d', '2026-09-22'),
      ).toThrow(/NOT NULL/i)

      const insert = db.prepare(
        'INSERT INTO days (account_id, day_key, arrived_at, left_at) VALUES (?, ?, ?, NULL)',
      )
      insert.run('u-d', '2026-09-22', '2026-09-22T09:00:00+08:00')
      expect(() => insert.run('u-d', '2026-09-22', '2026-09-22T10:00:00+08:00')).toThrow(
        /UNIQUE|PRIMARY KEY/i,
      )
      const row = db.prepare('SELECT left_at FROM days WHERE account_id = ?').get('u-d') as {
        left_at: string | null
      }
      expect(row.left_at).toBeNull() // 无离开记录 = 时长未知（FR1）

      // 备注可以独立于到达存在，但它**不建 days 行**（两条不变式各自成立）
      db.prepare('INSERT INTO day_notes (account_id, day_key, text, updated_at) VALUES (?, ?, ?, ?)').run(
        'u-d',
        '2026-09-23',
        '发烧在家',
        '2026-09-23T09:00:00+08:00',
      )
      const days = db.prepare('SELECT COUNT(*) AS n FROM days WHERE account_id = ?').get('u-d') as {
        n: number
      }
      expect(days.n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('外键级联：删账号 → 它的事件、设置、打卡日、任务、项目、备注一并消失', () => {
    const db = freshDb('cascade.db')
    try {
      migrate(db)
      seedUser(db, 'u-c', 'userc')
      db.prepare(
        `INSERT INTO events
           (id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
            target_kind, target_id, batch_id, payload, appended_at)
         VALUES ('e1', 'u-c', 'system/revoke', '2026-09-22T10:00:00+08:00', 'Asia/Shanghai',
                 '2026-09-22', 4, NULL, NULL, 'b1', '{}', '2026-09-22T10:00:00+08:00')`,
      ).run()
      db.prepare(
        `INSERT INTO tasks
           (id, account_id, title, notes, importance, planned_date, planned_week, due_date,
            tags_json, project_id, status, manual_order, steps_json, index_date,
            recurrence_json, next_anchor_mode, starts_on, deleted_at, created_at, updated_at)
         VALUES ('t1', 'u-c', 'A', '', 'normal', NULL, NULL, NULL, '[]', NULL, 'not_started', NULL,
                 '[]', '2026-09-22', NULL, NULL, NULL, NULL,
                 '2026-09-22T10:00:00+08:00', '2026-09-22T10:00:00+08:00')`,
      ).run()
      db.prepare(
        `INSERT INTO projects (id, account_id, name, starts_on, ends_on, is_current, deleted_at, created_at, updated_at)
         VALUES ('p1', 'u-c', 'P', '2026-09-01', '2026-09-30', 0, NULL, '2026-09-01T10:00:00+08:00', '2026-09-01T10:00:00+08:00')`,
      ).run()
      db.prepare(
        `INSERT INTO settings (account_id, time_zone, day_start_hour, updated_at)
         VALUES ('u-c', 'Asia/Shanghai', 4, '2026-09-22T10:00:00+08:00')`,
      ).run()
      db.prepare(
        `INSERT INTO days (account_id, day_key, arrived_at, left_at)
         VALUES ('u-c', '2026-09-22', '2026-09-22T09:00:00+08:00', NULL)`,
      ).run()
      db.prepare(
        `INSERT INTO day_notes (account_id, day_key, text, updated_at)
         VALUES ('u-c', '2026-09-22', '备注', '2026-09-22T09:00:00+08:00')`,
      ).run()

      db.prepare('DELETE FROM users WHERE id = ?').run('u-c')
      for (const table of ['events', 'tasks', 'projects', 'settings', 'days', 'day_notes']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        expect(row.n, `${table} 未被级联清理`).toBe(0)
      }
    } finally {
      db.close()
    }
  })

  it('v1 库一次升到最新版：v1 数据保留，后续各版的表建起来，版本号落最新', () => {
    const db = freshDb('v1.db')
    try {
      migrate(db) // 先到最新版，再退回「只有 v1 表」的形态，模拟一台停在 v1 的库
      seedUser(db, 'u-v1', 'userv1')
      db.exec('DROP TABLE tasks')
      db.exec('DROP TABLE projects')
      db.exec('DROP TABLE day_notes')
      db.exec('DROP TABLE settings')
      db.exec('DROP TABLE events')
      db.exec('DROP TABLE days')
      db.pragma('user_version = 1')
      expect(getSchemaVersion(db)).toBe(1)

      // v1 → v4 一步到位：逐版本升级的链条要能一次跑完
      expect(migrate(db)).toBe(SCHEMA_VERSION)
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
      // v1 的数据没被碰
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get('u-v1') as { id: string }
      expect(user.id).toBe('u-v1')
      // v2 的表回来了，且能正常写入
      expect(() =>
        db
          .prepare(
            `INSERT INTO events
               (id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
                target_kind, target_id, batch_id, payload, appended_at)
             VALUES ('e-after', 'u-v1', 'system/revoke', '2026-09-22T10:00:00+08:00', 'Asia/Shanghai',
                     '2026-09-22', 4, NULL, NULL, 'b1', '{}', '2026-09-22T10:00:00+08:00')`,
          )
          .run(),
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('已在最新版的库再迁一次是空操作（幂等，不重复建表）', () => {
    const db = freshDb('again.db')
    try {
      migrate(db)
      seedUser(db, 'u-again', 'useragain')
      appendInTx(db, 'u-again', 'first')
      expect(migrate(db)).toBe(SCHEMA_VERSION)
      expect(readAccountEvents(db, 'u-again')).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('事件写入后投影表内容与重放结果一致（迁移出来的库立刻可用）', () => {
    const db = freshDb('usable.db')
    try {
      migrate(db)
      seedUser(db, 'u-usable', 'userusable')
      appendInTx(db, 'u-usable', 'usable')
      expect(readProjection(db, 'u-usable').tasks).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

/**
 * **v3 → v4 的数据迁移**（ADR-013 §5 / §5.1）。
 *
 * 两个分支都必须测：只测通过分支的话，**那道前置检查失效不会被发现**——
 * 而它失效的后果是「升级后账号静默写不进东西」（见下方用例的说明）。
 */
describe('v3 → v4 迁移（ADR-013 §5）', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-v4-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('旧模板的标题 / 规则 / 锚点 / 起点**逐字保留**，且旧表已 DROP', () => {
    const db = openV3Database(path.join(dir, 'migrate.db'))
    try {
      seedUser(db, 'u-m', 'userm')
      db.prepare(
        `INSERT INTO recurrence_templates
           (id, account_id, title, rule_json, next_anchor_mode, starts_on, created_at, updated_at)
         VALUES ('t-old', 'u-m', '每天喝水', '{"freq":"daily","interval":1}', 'catch_up', '2026-09-22',
                 '2026-09-22T10:00:00+08:00', '2026-09-23T10:00:00+08:00')`,
      ).run()

      expect(migrate(db)).toBe(4)
      const task = readProjection(db, 'u-m').tasks[0]!
      expect(task).toMatchObject({
        id: 't-old',
        title: '每天喝水',
        // 规则住在 `recurrence` 里（可空对象），不再是任务行上的三个平铺列
        recurrence: {
          rule: { freq: 'daily', interval: 1 },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
        },
        // 旧模板的 `starts_on` **同时**成为 `indexDate`（ADR-013 §5）：
        // 于是老数据迁移后的实例键恰好等于其第一轮的「原计划日期」——
        // 若该模板已有一轮完成记录，迁移后那一轮仍显示为已完成。
        indexDate: '2026-09-22',
        status: 'not_started',
        notes: '',
        importance: 'normal',
        tags: [],
        steps: [],
        plannedDate: null,
        plannedWeek: null,
        dueDate: null,
        manualOrder: null,
        deletedAt: null,
        createdAt: '2026-09-22T10:00:00+08:00',
        updatedAt: '2026-09-23T10:00:00+08:00',
      })
      // 旧表已 DROP（留着它会让表名与模式版本对不上）
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
      ).map((row) => row.name)
      expect(tables).not.toContain('recurrence_templates')
    } finally {
      db.close()
    }
  })

  it('前置检查：库里**没有** recurrence/* 事件 → 迁移正常完成', () => {
    const db = openV3Database(path.join(dir, 'clean.db'))
    try {
      seedUser(db, 'u-clean', 'userclean')
      expect(migrate(db)).toBe(4)
      expect(getSchemaVersion(db)).toBe(4)
    } finally {
      db.close()
    }
  })

  /**
   * **库里有一条 `recurrence/template-created` → 迁移中止**（ADR-013 §5.1）。
   *
   * 为什么必须拒绝而不是自动改写：改写需要把 `templateId → taskId`、
   * `nextAnchorDate` + `nextAnchorMode → next: { date, mode }` 逐个转换，
   * 而**本仓的库里一条这样的数据都没有**——**写一个没有任何真实样本可测的转换器，
   * 是把一个可测的失败换成一个不可测的成功**。拒绝是可测的。
   */
  it('前置检查：库里**有** recurrence/* 事件 → 中止，报出条数与类型，且一个字节都没迁', () => {
    const db = openV3Database(path.join(dir, 'dirty.db'))
    try {
      seedUser(db, 'u-dirty', 'userdirty')
      db.prepare(
        `INSERT INTO events
           (id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
            target_kind, target_id, batch_id, payload, appended_at)
         VALUES ('e-legacy', 'u-dirty', 'recurrence/template-created',
                 '2026-09-22T10:00:00+08:00', 'Asia/Shanghai', '2026-09-22', 4,
                 'recurrence_template', 't-old', 'b1', '{}', '2026-09-22T10:00:00+08:00')`,
      ).run()

      expect(() => migrate(db)).toThrow(/recurrence\/template-created/)
      expect(() => migrate(db)).toThrow(/1 条/)
      // 版本号没动、表也还在：整个迁移是一个事务，回滚后库停在 v3 原样
      expect(getSchemaVersion(db)).toBe(3)
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
      ).map((row) => row.name)
      expect(tables).toContain('recurrence_templates')
      expect(tables).not.toContain('tasks')
    } finally {
      db.close()
    }
  })
})

function seedUser(db: Db, id: string, username: string): void {
  insertUser(db, {
    id,
    username,
    displayName: username,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-22T10:00:00+08:00',
  })
}

function appendInTx(db: Db, accountId: string, taskId: string): void {
  db.transaction(() =>
    appendEvents(db, accountId, [
      {
        type: 'task/created',
        occurredAt: '2026-09-22T10:00:00+08:00',
        targetKind: 'task',
        targetId: taskId,
        payload: {
          taskId,
          title: '迁移后可用',
          notes: '',
          importance: 'normal',
          plannedDate: null,
          plannedWeek: null,
          dueDate: null,
          tags: [],
          projectId: null,
          recurrence: null,
          steps: [],
        },
      },
    ]),
  )()
}

describe('迁移后的库与事件层配套可用（端到端最小闭环）', () => {
  it('openMigratedDatabase 出来的库直接能追加事件并露出投影', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-e2e-'))
    const db = openMigratedDatabase(path.join(dir, 'app.db'))
    try {
      seedUser(db, 'u-e2e', 'usere2e')
      appendInTx(db, 'u-e2e', 't-e2e')
      expect(readProjection(db, 'u-e2e').tasks.map((task) => task.title)).toEqual(['迁移后可用'])
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
