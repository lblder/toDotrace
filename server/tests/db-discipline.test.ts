import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, openMigratedDatabase, type Db } from '../db/index.js'
import { getSchemaVersion, migrate, SCHEMA_VERSION, allDdl } from '../db/schema.js'
import { insertSession, countSessionsForUser } from '../repo/sessions.js'
import { insertInvite, findInviteByCodeHash } from '../repo/invites.js'
import { insertUser } from '../repo/users.js'

/**
 * 数据库纪律测试（开发文档 §5「数据库纪律测试」）：
 * 连接即开外键、WAL、级联删除行为——架构文档 §11 教训 3 的直接对策。
 */

let dir: string
let dbPath: string
let db: Db

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-dbtest-'))
  dbPath = path.join(dir, 'app.db')
  db = openMigratedDatabase(dbPath)
})

afterAll(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function seedUser(id: string, username: string): void {
  insertUser(db, {
    id,
    username,
    displayName: username,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-21T14:00:00+08:00',
  })
}

describe('连接纪律', () => {
  it('journal_mode = WAL，foreign_keys = ON', () => {
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1)
  })

  it('每个新连接都自带外键开关（不是只对第一个连接生效）', () => {
    const other = openDatabase(dbPath)
    try {
      expect(Number(other.pragma('foreign_keys', { simple: true }))).toBe(1)
      expect(String(other.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    } finally {
      other.close()
    }
  })

  it('模式版本用 PRAGMA user_version 记录', () => {
    // 有意义的断言是「库里的实际版本 == 代码常量」；原先另有一条 `SCHEMA_VERSION === 1`
    // 的硬编码断言，它每升一次版本就要改一次、却检查不出任何真实问题，
    // 且与上一行重复（阶段 2 升 v2 时它挡下了全仓验证），故删除。
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('库版本高于程序支持版本时拒绝启动', () => {
    const newer = openDatabase(path.join(dir, 'newer.db'))
    try {
      newer.pragma('user_version = 99')
      expect(() => migrate(newer)).toThrow(/模式版本/)
    } finally {
      newer.close()
    }
  })
})

describe('级联删除（外键真的生效）', () => {
  it('删除用户 → 其会话行一并消失', () => {
    seedUser('u-cascade-1', 'cascade1')
    insertSession(db, {
      id: 's-cascade-1',
      userId: 'u-cascade-1',
      tokenHash: 'hash-cascade-1',
      createdAt: '2026-09-21T14:00:00+08:00',
      expiresAt: '2026-10-21T14:00:00+08:00',
    })
    expect(countSessionsForUser(db, 'u-cascade-1')).toBe(1)

    db.prepare('DELETE FROM users WHERE id = ?').run('u-cascade-1')
    expect(countSessionsForUser(db, 'u-cascade-1')).toBe(0)
  })

  it('删除签发人 → 其签发的邀请码一并消失', () => {
    seedUser('u-cascade-2', 'cascade2')
    insertInvite(db, {
      id: 'i-cascade-1',
      codeHash: 'hash-invite-cascade-1',
      issuedBy: 'u-cascade-2',
      createdAt: '2026-09-21T14:00:00+08:00',
      expiresAt: '2026-09-28T14:00:00+08:00',
    })
    db.prepare('DELETE FROM users WHERE id = ?').run('u-cascade-2')
    expect(findInviteByCodeHash(db, 'hash-invite-cascade-1')).toBeUndefined()
  })

  it('删除被邀请人 → 邀请码保留，used_by 置空（ON DELETE SET NULL）', () => {
    seedUser('u-owner-x', 'ownerx')
    seedUser('u-invitee-x', 'inviteex')
    insertInvite(db, {
      id: 'i-cascade-2',
      codeHash: 'hash-invite-cascade-2',
      issuedBy: 'u-owner-x',
      createdAt: '2026-09-21T14:00:00+08:00',
      expiresAt: '2026-09-28T14:00:00+08:00',
    })
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?').run(
      'u-invitee-x',
      '2026-09-21T15:00:00+08:00',
      'i-cascade-2',
    )
    db.prepare('DELETE FROM users WHERE id = ?').run('u-invitee-x')

    const invite = findInviteByCodeHash(db, 'hash-invite-cascade-2')
    expect(invite).toBeDefined()
    expect(invite?.used_by).toBeNull()
  })

  it('插入指向不存在用户的会话会被外键拒绝', () => {
    expect(() =>
      insertSession(db, {
        id: 's-orphan',
        userId: 'no-such-user',
        tokenHash: 'hash-orphan',
        createdAt: '2026-09-21T14:00:00+08:00',
        expiresAt: '2026-10-21T14:00:00+08:00',
      }),
    ).toThrow(/FOREIGN KEY/i)
  })
})


it('v4 数据库升级保留原打卡，并初始化空暂离记录', () => {
  const legacy = openDatabase(path.join(dir, 'legacy-v4.db'))
  try {
    for (const ddl of allDdl().slice(0, 4)) legacy.exec(ddl)
    legacy.pragma('user_version = 4')
    insertUser(legacy, { id: 'legacy', username: 'legacy', displayName: 'legacy', role: 'member', passwordHash: 'hash', createdAt: '2026-09-22T09:00:00+08:00' })
    legacy.prepare('INSERT INTO days (account_id, day_key, arrived_at, left_at) VALUES (?, ?, ?, ?)').run('legacy', '2026-09-22', '2026-09-22T09:00:00+08:00', null)
    migrate(legacy)
    expect(legacy.prepare('SELECT arrived_at, left_at, breaks_json FROM days').get()).toEqual({ arrived_at: '2026-09-22T09:00:00+08:00', left_at: null, breaks_json: '[]' })
    expect(migrate(legacy)).toBe(SCHEMA_VERSION)
  } finally { legacy.close() }
})
