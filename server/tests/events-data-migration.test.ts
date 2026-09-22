import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DAY_START_HOUR } from '@shared/time'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { backfillAccountSettings } from '../events/data-migration.js'
import { rebuildProjection } from '../events/rebuild.js'
import { SETTINGS_UPDATED_TYPE } from '../events/definitions/settings.js'
import { serverTimeZone } from '../events/settings.js'
import { appendEvents } from '../events/append.js'
import { insertUser } from '../repo/users.js'

/**
 * 启动时的数据迁移（ADR-010 §7）——「模式迁移是纯 DDL，数据迁移归事件层」。
 *
 * 这组用例的存在理由是一处**真机证伪**：上一版实现里，存量账号（v2 之前就存在）没有
 * `settings/updated` 事件，读取路径每次回落默认值——于是同一个账号的时区随**服务端
 * 运行时区**漂移，且库里查无实据。ADR-010 §7 明文禁止「读时」与「漂移」两件事。
 *
 * 断言分三层：
 * 1. **补写**：缺设置事实的账号在迁移后有一条 `settings/updated`，值 = 迁移时的服务端时区；
 * 2. **幂等**：重复跑不产生第二条（重复启动是常态，不是异常）；
 * 3. **不越界**：已有设置事实的账号、以及正常创建的账号都不受影响。
 */

let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-datamig-'))
  db = openMigratedDatabase(path.join(dir, 'app.db'))
})

afterAll(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function freshAccount(): string {
  seq += 1
  const id = `legacy-${seq}`
  insertUser(db, {
    id,
    username: `legacy${seq}`,
    displayName: `存量用户${seq}`,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-22T10:00:00+08:00',
  })
  return id
}

function settingsEvents(accountId: string): { id: string; payload: unknown; occurredAt: string }[] {
  return readAccountEvents(db, accountId)
    .filter((event) => event.type === SETTINGS_UPDATED_TYPE)
    .map((event) => ({ id: event.id, payload: event.payload, occurredAt: event.occurredAt }))
}

const MIGRATION_TIME = new Date('2026-09-22T10:00:00+08:00')

describe('存量账号补写 settings/updated（ADR-010 §7）', () => {
  it('没有设置事件的账号 → 补一条，时区取**迁移时**的服务端本地时区', () => {
    const account = freshAccount()
    expect(settingsEvents(account)).toHaveLength(0)

    const backfilled = backfillAccountSettings(db, MIGRATION_TIME)

    expect(backfilled).toContain(account)
    const events = settingsEvents(account)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toEqual({
      timeZone: serverTimeZone(),
      dayStartHour: DEFAULT_DAY_START_HOUR,
    })
    // 时刻是**迁移执行时**那一刻，不是读时、也不是进程启动的任意其它时刻
    expect(events[0]!.occurredAt).toBe('2026-09-22T10:00:00+08:00')
  })

  it('投影随之可查：settings 行由这条事件得出（值不再依赖读取瞬间）', () => {
    const account = freshAccount()
    backfillAccountSettings(db, MIGRATION_TIME)

    const settings = readProjection(db, account).settings
    expect(settings).not.toBeNull()
    expect(settings!.timeZone).toBe(serverTimeZone())
    expect(settings!.dayStartHour).toBe(DEFAULT_DAY_START_HOUR)
    expect(settings!.updatedAt).toBe('2026-09-22T10:00:00+08:00')
  })

  it('幂等：重复启动不产生第二条（判据是事件存在性，不是投影行）', () => {
    const account = freshAccount()
    expect(backfillAccountSettings(db, MIGRATION_TIME)).toContain(account)
    expect(settingsEvents(account)).toHaveLength(1)

    // 第二次、第三次启动
    expect(backfillAccountSettings(db, new Date('2026-09-23T10:00:00+08:00'))).toEqual([])
    expect(backfillAccountSettings(db, new Date('2026-10-01T10:00:00+08:00'))).toEqual([])
    expect(settingsEvents(account)).toHaveLength(1)
    // 值也没被后来的迁移时刻改写
    expect(settingsEvents(account)[0]!.occurredAt).toBe('2026-09-22T10:00:00+08:00')
  })

  it('已有设置事实的账号不被补写，其设置值不被迁移改写', () => {
    const account = freshAccount()
    db.transaction(() =>
      appendEvents(db, account, [
        {
          type: SETTINGS_UPDATED_TYPE,
          occurredAt: '2026-09-20T09:00:00+08:00',
          payload: { timeZone: 'Asia/Tokyo', dayStartHour: 1 },
        },
      ]),
    )()

    expect(backfillAccountSettings(db, MIGRATION_TIME)).not.toContain(account)
    expect(settingsEvents(account)).toHaveLength(1)
    expect(readProjection(db, account).settings).toMatchObject({
      timeZone: 'Asia/Tokyo',
      dayStartHour: 1,
    })
  })

  it('一次迁移补齐所有缺设置的账号，且不动已有事件的账号', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-datamig-many-'))
    const db2 = openMigratedDatabase(path.join(dir2, 'app.db'))
    try {
      const ids = ['m-1', 'm-2', 'm-3'].map((id) => {
        insertUser(db2, {
          id,
          username: `m${id}`,
          displayName: id,
          role: 'member',
          passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
          createdAt: '2026-09-22T10:00:00+08:00',
        })
        return id
      })
      expect(backfillAccountSettings(db2, MIGRATION_TIME).sort()).toEqual(ids)
      for (const id of ids) {
        const count = db2
          .prepare('SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND type = ?')
          .get(id, SETTINGS_UPDATED_TYPE) as { n: number }
        expect(count.n).toBe(1)
      }
    } finally {
      db2.close()
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('库里没有账号时是空操作（不抛错、不写任何东西）', () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-datamig-empty-'))
    const db3 = openMigratedDatabase(path.join(dir3, 'app.db'))
    try {
      expect(backfillAccountSettings(db3, MIGRATION_TIME)).toEqual([])
      const count = db3.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
      expect(count.n).toBe(0)
    } finally {
      db3.close()
      fs.rmSync(dir3, { recursive: true, force: true })
    }
  })

  it('补写的事件是普通事件：追加后仍满足「表 = 重放」（可重建）', () => {
    const account = freshAccount()
    backfillAccountSettings(db, MIGRATION_TIME)
    const before = readProjection(db, account).settings
    expect(before).not.toBeNull()
    // 补出来的设置事实同样能重放：删掉投影行再重建，值一模一样
    db.prepare('DELETE FROM settings WHERE account_id = ?').run(account)
    expect(readProjection(db, account).settings).toBeNull()
    rebuildProjection(db, account)
    expect(readProjection(db, account).settings).toEqual(before)
  })
})
