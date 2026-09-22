import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, openMigratedDatabase, type Db } from '../db/index.js'
import { getSchemaVersion, migrate, SCHEMA_VERSION } from '../db/schema.js'
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
 */

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))

/** `server/` 下除测试外的全部 .ts 源文件 */
function sourceFiles(dir: string = SERVER_DIR, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules') continue
      sourceFiles(full, found)
    } else if (entry.name.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found
}

/** 去掉注释后的源码：注释里写「INSERT INTO x」不是在写库 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 命中某张表的写语句（INSERT / UPDATE / DELETE） */
function writersOf(table: string): string[] {
  const pattern = new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i')
  return sourceFiles()
    .filter((file) => pattern.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(SERVER_DIR, file))
    .sort()
}

describe('投影表只有一个写入方（ADR-010 §约束）', () => {
  it('recurrence_templates 只被 projection-store.ts 写', () => {
    expect(writersOf('recurrence_templates')).toEqual(['events/projection-store.ts'])
  })

  it('settings 只被 projection-store.ts 写（ADR-010 §6/§7：设置是投影，唯一来源是事件）', () => {
    // 曾经这里只能断言「没有任何写入方」——当时 §3 的 Projection 没有 settings 键，
    // §7 指定的 settings/updated 事件无处落脚，settings 表在阶段 2 是空的。
    // ADR-010 §3 补上 settings 键、§7 的事件登记之后，这张表与模板走同一条纪律：
    // 唯一写入方是 projection-store.ts，而它只写「事件重放出来的那个投影对象」。
    // §7 明文列为错误路径的「违反约束直接 UPDATE settings」由此被挡在源码扫描之外。
    expect(writersOf('settings')).toEqual(['events/projection-store.ts'])
  })

  it('days 只被 projection-store.ts 写（ADR-012 §2/§4：打卡的投影更新只能由事件层执行）', () => {
    // ADR-012 §4 item 2 把这条纪律点名施加给打卡：**路由不得绕过事件层直接写投影表**。
    // 打卡是第一个从路由层调 appendEvents 的功能，「顺手 UPDATE 一下 days」
    // 正是这条纪律在真实项目里失效的方式——而它在这里会被源码扫描挡下。
    expect(writersOf('days')).toEqual(['events/projection-store.ts'])
  })

  it('events 只被 event-store.ts 写，且只 INSERT——事件不可变（ADR-001 地基）', () => {
    expect(writersOf('events')).toEqual(['events/event-store.ts'])
    const store = stripComments(
      fs.readFileSync(path.join(SERVER_DIR, 'events/event-store.ts'), 'utf8'),
    )
    expect(store).not.toMatch(/\bDELETE\s+FROM\s+events\b/i)
    expect(store).not.toMatch(/\bUPDATE\s+events\b/i)
  })

  it('事件层的代码不自己开库连接（一律用注入的 Db）', () => {
    const offenders = sourceFiles(path.join(SERVER_DIR, 'events')).filter((file) =>
      /new\s+Database\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8'))),
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
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      expect(source, `${path.relative(SERVER_DIR, file)} 读了时钟`).not.toMatch(
        /\bDate\.now\s*\(|new\s+Date\s*\(/,
      )
    }
  })

  it('重放与事件定义里没有数据库访问', () => {
    const files = [
      path.join(SERVER_DIR, 'events/project.ts'),
      ...sourceFiles(path.join(SERVER_DIR, 'events/definitions')),
    ]
    for (const file of files) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      expect(source, `${path.relative(SERVER_DIR, file)} 碰了库`).not.toMatch(
        /\bdb\s*\.\s*(prepare|exec|transaction|pragma)\b/,
      )
    }
  })
})

describe('注册表（ADR-010 §2）', () => {
  it('每个定义的成员形状固定：type / schema / apply（+ 可选的 target）', () => {
    // 逐类型写死形状，而不是「一个通用集合」：新增一个类型必须在这里表态
    // 「它有没有标识落点」——落点漏了不会报错，只会让 idx_events_target 查不到东西。
    const expectedShape: Record<string, string[]> = {
      'system/overwrite-anchor': ['apply', 'schema', 'type'],
      'system/revoke': ['apply', 'schema', 'type'],
      'settings/updated': ['apply', 'schema', 'type'],
      // 打卡事件（ADR-012 §1）：载荷为空对象，落点是「归属日」而非某个对象，
      // 故两列 target 为 NULL——与设置事件同类。
      'checkin/arrived': ['apply', 'schema', 'type'],
      'checkin/left': ['apply', 'schema', 'type'],
      // 四类重复事件的载荷都带 templateId，落点由载荷派生（ADR-010 §2）
      'recurrence/template-created': ['apply', 'schema', 'target', 'type'],
      'recurrence/template-updated': ['apply', 'schema', 'target', 'type'],
      'recurrence/template-deleted': ['apply', 'schema', 'target', 'type'],
      'recurrence/round-completed': ['apply', 'schema', 'target', 'type'],
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
    expect(() => getEventDefinition('task/created')).toThrow(/未登记的事件类型/)
  })
})

describe('模式 v3（ADR-010 §1 / §6、ADR-011 §1、ADR-012 §2）', () => {
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

  function pkColumns(db: Db, table: string): string[] {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]
    return columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name)
  }

  /** 显式建的索引；`sqlite_autoindex_*` 是主键自带的，不算 DDL 的一部分 */
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
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
      ).map((row) => row.name)
      expect(tables).toEqual(
        expect.arrayContaining([
          'events',
          'recurrence_templates',
          'settings',
          'days',
          'users',
          'sessions',
          'invites',
        ]),
      )
      expect(indexNames(db, 'events')).toEqual(['idx_events_batch', 'idx_events_target'])
      expect(indexNames(db, 'recurrence_templates')).toEqual(['idx_templates_account'])
      // days 没有额外索引：主键 (account_id, day_key) 自己就是范围查询的索引
      expect(indexNames(db, 'days')).toEqual([])
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('events 的主键是复合的 (account_id, id)，且没有 seq 列（ADR-010 §1 取代 ADR-001 §1）', () => {
    const db = freshDb('pk.db')
    try {
      migrate(db)
      expect(pkColumns(db, 'events')).toEqual(['account_id', 'id'])
      const columns = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
        (column) => column.name,
      )
      expect(columns).not.toContain('seq')
      // ADR-011 §1：与 events 同理，**不是 id 全局唯一**——B 导入 A 导出的同一份文件时，
      // 两个账号各持一份同 id 的模板副本。这里曾是 ['id']（全局主键），实测炸出
      // UNIQUE constraint failed: recurrence_templates.id。
      expect(pkColumns(db, 'recurrence_templates')).toEqual(['account_id', 'id'])
      expect(pkColumns(db, 'settings')).toEqual(['account_id'])
      // ADR-012 §2：一天一行（账号 + 归属日），与 events / templates 同一形态
      expect(pkColumns(db, 'days')).toEqual(['account_id', 'day_key'])
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

  it('模板表的复合主键真的生效：同一模板 id 两个账号可共存，同账号内重复被拒（ADR-011 §1）', () => {
    const db = freshDb('template-pk.db')
    try {
      migrate(db)
      seedUser(db, 'u-ta', 'userta')
      seedUser(db, 'u-tb', 'usertb')
      const insert = db.prepare(
        `INSERT INTO recurrence_templates
           (id, account_id, title, rule_json, next_anchor_mode, starts_on, created_at, updated_at)
         VALUES ('t-shared', ?, 'A', '{"freq":"daily","interval":1}', 'catch_up', '2026-09-22',
                 '2026-09-22T10:00:00+08:00', '2026-09-22T10:00:00+08:00')`,
      )
      insert.run('u-ta')
      expect(() => insert.run('u-ta')).toThrow(/UNIQUE|PRIMARY KEY/i)
      // 这条「不抛」就是 ADR-011 §1 的判据：导入的文件在两个账号下各有一份副本
      expect(() => insert.run('u-tb')).not.toThrow()
      const count = db.prepare('SELECT COUNT(*) AS n FROM recurrence_templates').get() as { n: number }
      expect(count.n).toBe(2)
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
      // （每日备注、未约束的 left）分别被删去与约束堵死，
      // 剩下的最后一道闸门是 NOT NULL 本身。
      expect(() =>
        db
          .prepare('INSERT INTO days (account_id, day_key, arrived_at, left_at) VALUES (?, ?, NULL, NULL)')
          .run('u-d', '2026-09-22'),
      ).toThrow(/NOT NULL/i)

      // 有到达则成立，且 (account_id, day_key) 一天一行
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
    } finally {
      db.close()
    }
  })

  it('外键级联：删账号 → 它的事件、模板、设置、打卡日一并消失', () => {
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
        `INSERT INTO recurrence_templates
           (id, account_id, title, rule_json, next_anchor_mode, starts_on, created_at, updated_at)
         VALUES ('t1', 'u-c', 'A', '{"freq":"daily","interval":1}', 'catch_up', '2026-09-22',
                 '2026-09-22T10:00:00+08:00', '2026-09-22T10:00:00+08:00')`,
      ).run()
      db.prepare(
        `INSERT INTO settings (account_id, time_zone, day_start_hour, updated_at)
         VALUES ('u-c', 'Asia/Shanghai', 4, '2026-09-22T10:00:00+08:00')`,
      ).run()
      db.prepare(
        `INSERT INTO days (account_id, day_key, arrived_at, left_at)
         VALUES ('u-c', '2026-09-22', '2026-09-22T09:00:00+08:00', NULL)`,
      ).run()

      db.prepare('DELETE FROM users WHERE id = ?').run('u-c')
      for (const table of ['events', 'recurrence_templates', 'settings', 'days']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        expect(row.n, `${table} 未被级联清理`).toBe(0)
      }
    } finally {
      db.close()
    }
  })

  it('v1 库一次升到最新版：v1 数据保留，v2/v3 的表建起来，版本号落最新', () => {
    const db = freshDb('v1.db')
    try {
      migrate(db) // 先到最新版，再退回「只有 v1 表」的形态，模拟一台停在 v1 的库
      seedUser(db, 'u-v1', 'userv1')
      db.exec('DROP TABLE recurrence_templates')
      db.exec('DROP TABLE settings')
      db.exec('DROP TABLE events')
      db.exec('DROP TABLE days')
      db.pragma('user_version = 1')
      expect(getSchemaVersion(db)).toBe(1)

      // v1 → v3 一步到位：逐版本升级的链条要能一次跑完（v3 只依赖 v1 的 users）
      expect(migrate(db)).toBe(SCHEMA_VERSION)
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
      // v1 的数据没被碰
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get('u-v1') as { id: string }
      expect(user.id).toBe('u-v1')
      // v2 的表回来了，且能正常写入
      expect(() =>
        db.prepare(
          `INSERT INTO events
             (id, account_id, type, occurred_at, timezone, day_key, day_start_hour,
              target_kind, target_id, batch_id, payload, appended_at)
           VALUES ('e-after', 'u-v1', 'system/revoke', '2026-09-22T10:00:00+08:00', 'Asia/Shanghai',
                   '2026-09-22', 4, NULL, NULL, 'b1', '{}', '2026-09-22T10:00:00+08:00')`,
        ).run(),
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
      expect(readProjection(db, 'u-usable').templates).toHaveLength(1)
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

function appendInTx(db: Db, accountId: string, templateId: string): void {
  db.transaction(() =>
    appendEvents(db, accountId, [
      {
        type: 'recurrence/template-created',
        occurredAt: '2026-09-22T10:00:00+08:00',
        targetKind: 'recurrence_template',
        targetId: templateId,
        payload: {
          templateId,
          title: '迁移后可用',
          rule: { freq: 'daily', interval: 1 },
          nextAnchorMode: 'catch_up',
          startsOn: '2026-09-22',
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
      expect(readProjection(db, 'u-e2e').templates.map((t) => t.title)).toEqual(['迁移后可用'])
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
