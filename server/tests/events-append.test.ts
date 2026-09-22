import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DAY_START_HOUR } from '@shared/time'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { appendEvents, classifyMaintenance, readAccountEvents, rebuildProjection } from '../events/index.js'
import { countProjectedTemplates, readProjection, writeProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { SETTINGS_UPDATED_TYPE } from '../events/definitions/settings.js'
import { REVOKE_TYPE } from '../events/definitions/system.js'
import { loadAccountSettings, serverTimeZone } from '../events/settings.js'
import type { Event, EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'
import { uuidv7 } from '../lib/uuid.js'
import { createOwner, registerWithInvite } from '../domain/accounts.js'
import { issueInvite } from '../domain/accounts.js'
import { testConfig } from './helpers.js'

/**
 * `appendEvents`：写入、事务纪律、幂等、增量投影（ADR-010 §3 / §5）。
 *
 * 每个用例用**全新账号**，互不干扰——共用账号会让断言依赖执行顺序，
 * 而这类测试一旦顺序变了就会以「说不清哪里错」的形式红。
 *
 * 模板标识一律经 `tid(账号, 名字)` 生成，跨账号唯一。**注意那不是因为表要求全局唯一**：
 * ADR-011 §1 的主键是 `(account_id, id)`，两个账号持同一模板 id 是合法的导入形态
 * （见「多账号隔离」组的回归用例）。用可读前缀只是为了让断言里的失败信息指得清是哪个账号。
 */

let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-events-'))
  db = openMigratedDatabase(path.join(dir, 'app.db'))
})

afterAll(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function freshAccount(): string {
  seq += 1
  const id = `u-${seq}`
  insertUser(db, {
    id,
    username: `user${seq}`,
    displayName: `用户${seq}`,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-22T10:00:00+08:00',
  })
  return id
}

function nextId(): string {
  seq += 1
  return `${seq.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`
}

/** 模板标识：全局唯一（模拟真实 UUIDv7），但可读 */
function tid(account: string, name: string): string {
  return `${account}:${name}`
}

function inTx<T>(fn: () => T): T {
  return db.transaction(fn)()
}

/**
 * 铺账号设置：**经由产品代码**追加一条 `settings/updated`（ADR-010 §6/§7）。
 *
 * 这里曾经是一段直接 UPDATE `settings` 的测试后门，理由是「产品代码里没有任何模块写
 * 这张表」。登记 `settings/updated` 之后那个理由消失了：设置的唯一合法来源就是这条事件，
 * 而测试走**同一条路**才谈得上验证它——直接铺行的测试即使全绿，也证明不了
 * 「投影表可由事件重建」。
 *
 * 事件 id 用**真 uuidv7**（而非本文件里可读的测试 id）：真实系统里 id 是写入时
 * 按时间序发的，于是「先改设置、后写事件」天然是尾部追加。若这里用 `nextId()` 的
 * 小号 id，反而会让后面的写入被判成「非尾部追加」而走重建——那仍然正确，
 * 但把这条用例的意图（改设置 → 后续写入按新设置折算）淹没在无关分支里。
 */
function setSettings(accountId: string, timeZone: string, dayStartHour: number): void {
  inTx(() =>
    appendEvents(db, accountId, [
      {
        type: SETTINGS_UPDATED_TYPE,
        id: uuidv7(),
        occurredAt: '2026-09-22T00:00:00+08:00',
        payload: { timeZone, dayStartHour },
      },
    ]),
  )
}

function countEvents(accountId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM events WHERE account_id = ?').get(accountId) as {
    n: number
  }
  return row.n
}

function createdDraft(templateId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/template-created',
    occurredAt: '2026-09-22T10:00:00+08:00',
    targetKind: 'recurrence_template',
    targetId: templateId,
    payload: {
      templateId,
      title,
      rule: { freq: 'daily', interval: 1 },
      nextAnchorMode: 'catch_up',
      startsOn: '2026-09-22',
    },
    ...overrides,
  }
}

function updatedDraft(templateId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/template-updated',
    occurredAt: '2026-09-23T10:00:00+08:00',
    targetKind: 'recurrence_template',
    targetId: templateId,
    payload: {
      templateId,
      title,
      rule: { freq: 'weekly', interval: 2, byDayOfWeek: [0] },
      nextAnchorMode: 'extend',
      startsOn: '2026-09-01',
    },
    ...overrides,
  }
}

function deletedDraft(templateId: string, title: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'recurrence/template-deleted',
    occurredAt: '2026-09-24T10:00:00+08:00',
    targetKind: 'recurrence_template',
    targetId: templateId,
    payload: {
      templateId,
      title,
      rule: { freq: 'daily', interval: 1 },
      nextAnchorMode: 'catch_up',
      startsOn: '2026-09-22',
    },
    ...overrides,
  }
}

function revokeDraft(targetBatchId: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: REVOKE_TYPE,
    occurredAt: '2026-09-22T11:00:00+08:00',
    payload: { targetBatchId },
    ...overrides,
  }
}

/** 该账号当前投影是否等于其全部事件的重放结果（ADR-010 §5 的核心不变式）。 */
function expectProjectionMatchesReplay(accountId: string): void {
  expect(readProjection(db, accountId)).toEqual(project(readAccountEvents(db, accountId)))
}

describe('事件写入前的校验（ADR-010 §2）', () => {
  it('未登记的类型一律拒绝写入，且一个字都不落库', () => {
    const account = freshAccount()
    expect(() =>
      inTx(() =>
        appendEvents(db, account, [
          { type: 'task/created', payload: {}, occurredAt: '2026-09-22T10:00:00+08:00' },
        ]),
      ),
    ).toThrow(/未登记的事件类型/)
    expect(countEvents(account)).toBe(0)
  })

  it('畸形载荷拒绝写入，且**整批**都不落库（不是只拒那一条）', () => {
    const account = freshAccount()
    const good = createdDraft(tid(account, 'good'), '合法的一条')
    const bad: EventDraft = {
      ...createdDraft(tid(account, 'bad'), '非法的一条'),
      payload: { templateId: 'x' },
    }
    expect(() => inTx(() => appendEvents(db, account, [good, bad]))).toThrow(/载荷不合法/)
    expect(countEvents(account)).toBe(0)
    expect(countProjectedTemplates(db, account)).toBe(0)
  })

  it('id 必须是 UUIDv7', () => {
    const account = freshAccount()
    expect(() =>
      inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { id: 'not-a-uuid' })])),
    ).toThrow(/UUIDv7/)
  })

  it('occurredAt 必须是带偏移的 ISO 8601', () => {
    const account = freshAccount()
    expect(() =>
      inTx(() =>
        appendEvents(db, account, [
          createdDraft(tid(account, 't1'), 'A', { occurredAt: '2026-09-22T10:00:00' }),
        ]),
      ),
    ).toThrow(/occurredAt/)
  })

  it('dayKey 与 dayStartHour 必须成对出现', () => {
    const account = freshAccount()
    expect(() =>
      inTx(() =>
        appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { dayKey: '2026-09-01' })]),
      ),
    ).toThrow(/成对/)
  })

  it('未声明 target 的类型：target_kind 与 target_id 必须同时给出或同时为空', () => {
    const account = freshAccount()
    // `settings/updated` 不针对特定对象（ADR-010 §1）：只给 kind 不给 id 是自相矛盾的两列。
    expect(() =>
      inTx(() =>
        appendEvents(db, account, [
          {
            type: SETTINGS_UPDATED_TYPE,
            occurredAt: '2026-09-22T10:00:00+08:00',
            targetKind: 'recurrence_template',
            payload: { timeZone: 'Asia/Shanghai', dayStartHour: 4 },
          },
        ]),
      ),
    ).toThrow(/target_kind/)
  })

  it('声明了 target 的类型：两列由载荷派生，调用方不必给', () => {
    const account = freshAccount()
    const templateId = tid(account, 't1')
    const [event] = inTx(() =>
      appendEvents(db, account, [
        createdDraft(templateId, '不带落点的一稿', { targetKind: undefined, targetId: undefined }),
      ]),
    )
    expect(event!.targetKind).toBe('recurrence_template')
    expect(event!.targetId).toBe(templateId)
  })

  it('未登记 target 的类型写出的两列是 NULL', () => {
    const account = freshAccount()
    const [event] = inTx(() =>
      appendEvents(db, account, [
        {
          type: SETTINGS_UPDATED_TYPE,
          occurredAt: '2026-09-22T10:00:00+08:00',
          payload: { timeZone: 'Asia/Shanghai', dayStartHour: 4 },
        },
      ]),
    )
    expect(event!.targetKind).toBeNull()
    expect(event!.targetId).toBeNull()
  })
})

describe('事务纪律：一批次一事务（ADR-002 §1）', () => {
  it('不在事务内调用 appendEvents 直接抛错（不替你开事务）', () => {
    const account = freshAccount()
    expect(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A')])).toThrow(/事务/)
    expect(countEvents(account)).toBe(0)
  })

  it('投影写入同样必须在事务内', () => {
    const account = freshAccount()
    expect(() => writeProjection(db, account, { templates: [], settings: null })).toThrow(/事务/)
  })

  it('事件与投影同生共死：事务回滚后两者都不存在', () => {
    const account = freshAccount()
    expect(() =>
      inTx(() => {
        appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A')])
        throw new Error('后续步骤失败')
      }),
    ).toThrow('后续步骤失败')
    expect(countEvents(account)).toBe(0)
    expect(countProjectedTemplates(db, account)).toBe(0)
  })
})

describe('dayKey / dayStartHour 在写入时固化（ADR-001 §4）', () => {
  it('按账号设置折算：dayStartHour=4 时本地 03:00 归前一天', () => {
    const account = freshAccount()
    setSettings(account, 'Asia/Shanghai', 4)
    const [event] = inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '凌晨三点', { occurredAt: '2026-09-22T03:00:00+08:00' }),
      ]),
    )
    expect(event!.dayKey).toBe('2026-09-21')
    expect(event!.dayStartHour).toBe(4)
    expect(event!.timezone).toBe('Asia/Shanghai')
  })

  it('导入的事件原样保留 id / batchId / timezone / dayKey（永不重算）', () => {
    const account = freshAccount()
    setSettings(account, 'Asia/Shanghai', 4)
    const importedId = nextId()
    const importedBatch = nextId()
    const [event] = inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '导入的', {
          id: importedId,
          batchId: importedBatch,
          occurredAt: '2020-01-01T10:00:00+09:00',
          timezone: 'Asia/Tokyo',
          dayKey: '2020-01-01',
          dayStartHour: 0,
        }),
      ]),
    )
    expect(event!.id).toBe(importedId)
    expect(event!.batchId).toBe(importedBatch)
    expect(event!.timezone).toBe('Asia/Tokyo')
    expect(event!.dayKey).toBe('2020-01-01')
    expect(event!.dayStartHour).toBe(0)
  })

  it('改设置只影响此后写入的事件，历史事件的固化值不动', () => {
    const account = freshAccount()
    setSettings(account, 'Asia/Shanghai', 4)
    const [before] = inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '改设置前', { occurredAt: '2026-09-22T03:00:00+08:00' }),
      ]),
    )
    setSettings(account, 'Asia/Shanghai', 0)
    const [after] = inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't2'), '改设置后', { occurredAt: '2026-09-22T03:00:00+08:00' }),
      ]),
    )
    expect(before!.dayKey).toBe('2026-09-21')
    expect(after!.dayKey).toBe('2026-09-22')

    const stored = readAccountEvents(db, account).find((event) => event.id === before!.id)!
    expect(stored.dayKey).toBe('2026-09-21')
    expect(stored.dayStartHour).toBe(4)
  })
})

describe('合并幂等：同一 id 在同一账号内只出现一次（ADR-010 §1）', () => {
  it('同一份导入文件再次追加 = 0 新增（文件带 id 与 batchId；appended_at 不同也算同一条）', () => {
    const account = freshAccount()
    const id = nextId()
    const batchId = nextId()
    const draft = createdDraft(tid(account, 't1'), '导入一次', { id, batchId })
    expect(inTx(() => appendEvents(db, account, [draft]))).toHaveLength(1)

    // 文件里的每个字段都原样带回来，唯独 appended_at 是本机写入时刻，必然不同
    expect(inTx(() => appendEvents(db, account, [draft]))).toHaveLength(0)
    expect(countEvents(account)).toBe(1)
    expectProjectionMatchesReplay(account)
  })

  it('同 id 但内容不同 → 拒绝写入（标识全局唯一，冲突即数据被改写）', () => {
    const account = freshAccount()
    const id = nextId()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), '原标题', { id })]))
    expect(() =>
      inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), '被改写过的标题', { id })])),
    ).toThrow(/内容不同/)
  })

  it('同 id 但批次不同 → 也拒绝：一条事件不可能同属两个批次（撤销以批次为单位）', () => {
    const account = freshAccount()
    const id = nextId()
    inTx(() =>
      appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { id, batchId: nextId() })]),
    )
    expect(() =>
      inTx(() =>
        appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { id, batchId: nextId() })]),
      ),
    ).toThrow(/内容不同/)
  })

  it('草稿不带 batchId 时每次追加新开一个批次，因此「同一草稿追加两次」不是幂等场景', () => {
    const account = freshAccount()
    const id = nextId()
    const [first] = inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { id })]))
    // 这条不是在给「幂等」打折扣，而是把边界钉死：批次标识属于**写入动作**，
    // 只有携带原始 batchId 的导入文件才谈得上「同一份文件导入两次」。
    expect(() =>
      inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { id })])),
    ).toThrow(/内容不同/)
    expect(first!.batchId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('返回值只含本次真正新增的事件', () => {
    const account = freshAccount()
    const first = nextId()
    const second = nextId()
    const firstBatch = nextId()
    const repeated = createdDraft(tid(account, 't1'), 'A', { id: first, batchId: firstBatch })
    inTx(() => appendEvents(db, account, [repeated]))
    const inserted = inTx(() =>
      appendEvents(db, account, [repeated, createdDraft(tid(account, 't2'), 'B', { id: second })]),
    )
    expect(inserted.map((event) => event.id)).toEqual([second])
  })
})

describe('增量投影路径（ADR-010 §5）', () => {
  it('尾部追加走增量，且增量结果等于全量重放结果', () => {
    const account = freshAccount()
    const first = nextId()
    const second = nextId()
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), 'A', { id: first })]))
    const inserted = inTx(() =>
      appendEvents(db, account, [createdDraft(tid(account, 't2'), 'B', { id: second })]),
    )
    expect(classifyMaintenance(db, account, inserted, first)).toBe('incremental')
    expectProjectionMatchesReplay(account)
    expect(readProjection(db, account).templates.map((t) => t.title)).toEqual(['A', 'B'])
  })

  it('撤销事件触发全量重建：被撤销批次的模板从投影里消失', () => {
    const account = freshAccount()
    const createdBatch = inTx(() =>
      appendEvents(db, account, [createdDraft(tid(account, 't1'), '将被撤销')]),
    )[0]!
    const kept = inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't2'), '保留')]))[0]!
    expect(readProjection(db, account).templates).toHaveLength(2)

    const revokeEvents = inTx(() => appendEvents(db, account, [revokeDraft(createdBatch.batchId)]))
    expect(classifyMaintenance(db, account, revokeEvents, kept.id)).toBe('rebuild')
    expect(readProjection(db, account).templates.map((t) => t.title)).toEqual(['保留'])
    expectProjectionMatchesReplay(account)
  })

  it('不是尾部追加（导入更早的事件）时退化为重建，且折叠顺序仍按 id', () => {
    const account = freshAccount()
    // 先把 id 值分配出来（nextId 单调递增），再打乱**写入顺序**
    const earlierId = nextId()
    const laterId = nextId()
    // 先写「晚 id」的创建，再补一条「早 id」的同模板创建：
    // 若增量路径把后者接在末尾，胜出的会是「早 id」的标题——与重放结果相反。
    inTx(() => appendEvents(db, account, [createdDraft(tid(account, 't1'), '晚 id 的标题', { id: laterId })]))
    const late = inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '早 id 的标题', { id: earlierId, batchId: nextId() }),
      ]),
    )
    expect(classifyMaintenance(db, account, late, laterId)).toBe('rebuild')
    expect(readProjection(db, account).templates.map((t) => t.title)).toEqual(['晚 id 的标题'])
    expectProjectionMatchesReplay(account)
  })

  it('被撤销批次的事件后到时也走重建（增量无从知道「这条不该折叠」）', () => {
    const account = freshAccount()
    const orphanBatch = nextId()
    const revokeEvent = inTx(() => appendEvents(db, account, [revokeDraft(orphanBatch)]))[0]!
    const late = inTx(() =>
      appendEvents(db, account, [createdDraft(tid(account, 't1'), '迟到的', { batchId: orphanBatch })]),
    )
    expect(classifyMaintenance(db, account, late, revokeEvent.id)).toBe('rebuild')
    expect(readProjection(db, account).templates).toHaveLength(0)
    expectProjectionMatchesReplay(account)
  })

  it('把增量路径逐步走一遍，最后与全量重建逐字段一致', () => {
    const account = freshAccount()
    inTx(() =>
      appendEvents(db, account, [
        createdDraft(tid(account, 't1'), '喝水'),
        createdDraft(tid(account, 't2'), '复盘'),
      ]),
    )
    inTx(() => appendEvents(db, account, [updatedDraft(tid(account, 't1'), '喝水（改）')]))
    inTx(() => appendEvents(db, account, [deletedDraft(tid(account, 't2'), '复盘')]))
    expect(readProjection(db, account).templates.map((t) => t.title)).toEqual(['喝水（改）'])
    expectProjectionMatchesReplay(account)

    const incremental = readProjection(db, account)
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
  })
})

describe('多账号隔离（ADR-010 §1 的复合主键）', () => {
  it('同一个事件 id 在两个账号下各有一份副本（导入不因账号不一致而拒绝）', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    const sharedEventId = nextId()
    // 用不写投影表的事件类型，使本用例只检验事件层的复合主键承诺
    const draft: EventDraft = {
      type: 'recurrence/round-completed',
      occurredAt: '2026-09-22T10:00:00+08:00',
      // 文件里的事件自带 id 与 batchId；不带的话每次追加都会新开批次，
      // 「导入两次 = 0 新增」就无从谈起（见上一组用例）。
      batchId: nextId(),
      targetKind: 'recurrence_template',
      targetId: tid(alice, 't1'),
      payload: {
        templateId: tid(alice, 't1'),
        originalPlannedDate: '2026-09-22',
        completedDayKey: '2026-09-22',
        nextAnchorDate: '2026-09-23',
        nextAnchorMode: 'catch_up',
      },
    }

    const shared = { ...draft, id: sharedEventId } as EventDraft
    inTx(() => appendEvents(db, alice, [shared]))
    // B 导入 A 导出过的同一份文件：ADR-005 明确允许，ADR-010 §1 要求它成立
    expect(inTx(() => appendEvents(db, bob, [shared]))).toHaveLength(1)
    expect(countEvents(alice)).toBe(1)
    expect(countEvents(bob)).toBe(1)

    // 再导入一次：账号范围内幂等（「同一文件导入两次 = 0 新增」）
    expect(inTx(() => appendEvents(db, bob, [shared]))).toHaveLength(0)
    expect(countEvents(bob)).toBe(1)
  })

  /**
   * **回归防线**（ADR-011 §1 的复合主键）。
   *
   * 这条用例曾是**红的**：`recurrence_templates` 当时按 ADR-011 §1 原文写成
   * `id TEXT PRIMARY KEY`（全局唯一），B 导入 A 导出的同一份模板时直接炸出
   * `SqliteError: UNIQUE constraint failed: recurrence_templates.id`
   * （`writeProjection` → `maintainProjection` → `appendEvents`）。
   * ADR-011 §1 已改为 `PRIMARY KEY (account_id, id)`——与 ADR-010 §1 给 `events`
   * 写下的理由逐字相同：导入是**账号范围内**的幂等，「同一份文件」在两个账号下
   * 各有一份副本是合法形态（ADR-005、FR3 的换机迁移）。
   *
   * 它现在必须**通过**；谁把主键改回全局唯一，这里第一个红。
   */
  it('同一个模板 id 在两个账号下各有一份副本（模板表主键是 (account_id, id)）', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    // 同一份导出文件：同一个模板 id、同一条事件 id、同一个批次
    const sharedTemplateId = 'aaaaaaaa-0000-7000-8000-000000000001'
    const sharedEventId = nextId()
    const sharedBatchId = nextId()
    const imported: EventDraft = createdDraft(sharedTemplateId, '导入的模板', {
      id: sharedEventId,
      batchId: sharedBatchId,
    })

    inTx(() => appendEvents(db, alice, [imported]))
    expect(inTx(() => appendEvents(db, bob, [imported]))).toHaveLength(1)

    // 两份投影行各自落在自己的账号下，内容相同、互不覆盖
    expect(readProjection(db, alice).templates.map((t) => [t.accountId, t.id, t.title])).toEqual([
      [alice, sharedTemplateId, '导入的模板'],
    ])
    expect(readProjection(db, bob).templates.map((t) => [t.accountId, t.id, t.title])).toEqual([
      [bob, sharedTemplateId, '导入的模板'],
    ])
    expect(countProjectedTemplates(db, alice)).toBe(1)
    expect(countProjectedTemplates(db, bob)).toBe(1)

    // 两侧都仍满足「表 = 重放」（重建会各写一遍同 id 的行，不能互相踩）
    expectProjectionMatchesReplay(alice)
    expectProjectionMatchesReplay(bob)
    rebuildProjection(db, alice)
    rebuildProjection(db, bob)
    expectProjectionMatchesReplay(alice)
    expectProjectionMatchesReplay(bob)
  })

  it('一个账号的投影不会被另一个账号的写入改动', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    inTx(() => appendEvents(db, alice, [createdDraft(tid(alice, 't1'), 'A 的')]))
    expect(readProjection(db, bob).templates).toHaveLength(0)

    inTx(() => appendEvents(db, bob, [createdDraft(tid(bob, 't1'), 'B 的')]))
    expect(readProjection(db, alice).templates.map((t) => t.title)).toEqual(['A 的'])
    expect(readProjection(db, bob).templates.map((t) => t.title)).toEqual(['B 的'])
  })

  it('读事件按账号过滤', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    inTx(() => appendEvents(db, alice, [createdDraft(tid(alice, 't1'), 'A 的')]))
    expect(readAccountEvents(db, bob).filter((event: Event) => event.accountId === alice)).toHaveLength(0)
  })
})

describe('账号设置：settings/updated 是 settings 表的唯一来源（ADR-010 §6/§7）', () => {
  it('设置的每一列都可由事件重放得出（含 updatedAt），且表内容等于重放结果', () => {
    const account = freshAccount()
    const occurredAt = '2026-09-22T10:00:00+08:00'
    const [event] = inTx(() =>
      appendEvents(db, account, [
        {
          type: SETTINGS_UPDATED_TYPE,
          occurredAt,
          payload: { timeZone: 'Asia/Shanghai', dayStartHour: 2 },
        },
      ]),
    )

    const settings = readProjection(db, account).settings
    expect(settings).toEqual({
      accountId: account,
      timeZone: 'Asia/Shanghai',
      dayStartHour: 2,
      // updatedAt 不放进载荷：事件表已有 occurred_at，两处各存一份就是两个真相
      updatedAt: occurredAt,
    })
    expect(readProjection(db, account)).toEqual(project(readAccountEvents(db, account)))

    // 读取路径拿到的就是这一行（而不是回落默认值：回落的 updatedAt 是空串）
    expect(loadAccountSettings(db, account)).toEqual(settings)
    expect(loadAccountSettings(db, account).updatedAt).not.toBe('')
    expect(event!.targetId).toBeNull()
  })

  it('多条设置事件：按 id 序折叠，最后一条整行胜出（不是差量叠加）', () => {
    const account = freshAccount()
    const first = nextId()
    const second = nextId()
    inTx(() =>
      appendEvents(db, account, [
        {
          type: SETTINGS_UPDATED_TYPE,
          id: first,
          occurredAt: '2026-09-22T10:00:00+08:00',
          payload: { timeZone: 'Asia/Shanghai', dayStartHour: 4 },
        },
      ]),
    )
    inTx(() =>
      appendEvents(db, account, [
        {
          type: SETTINGS_UPDATED_TYPE,
          id: second,
          occurredAt: '2026-09-23T10:00:00+08:00',
          // 只改时区，dayStartHour 显式再给一次——载荷是整行，不是差量
          payload: { timeZone: 'America/New_York', dayStartHour: 4 },
        },
      ]),
    )
    expect(readProjection(db, account).settings).toEqual({
      accountId: account,
      timeZone: 'America/New_York',
      dayStartHour: 4,
      updatedAt: '2026-09-23T10:00:00+08:00',
    })
    expectProjectionMatchesReplay(account)
  })

  it('非法时区与越界 dayStartHour 都被拒绝，且一个字都不落库', () => {
    const account = freshAccount()
    const draft = (payload: unknown): EventDraft => ({
      type: SETTINGS_UPDATED_TYPE,
      occurredAt: '2026-09-22T10:00:00+08:00',
      payload,
    })
    // 时区写进流水就永久生效：放进去一个解析不了的，此后每次写入都会抛 RangeError
    expect(() =>
      inTx(() => appendEvents(db, account, [draft({ timeZone: 'Not/AZone', dayStartHour: 4 })])),
    ).toThrow(/载荷不合法/)
    expect(() =>
      inTx(() => appendEvents(db, account, [draft({ timeZone: 'Asia/Shanghai', dayStartHour: 24 })])),
    ).toThrow(/载荷不合法/)
    expect(countEvents(account)).toBe(0)
    expect(readProjection(db, account).settings).toBeNull()
  })

  it('设置可丢弃、可重建：清空投影表后 rebuild 能把设置从事件建回来', () => {
    const account = freshAccount()
    setSettings(account, 'Asia/Tokyo', 1)
    const before = readProjection(db, account).settings
    expect(before).not.toBeNull()

    // 绕过 rebuild，直接把两张投影表都清空（模拟「投影被丢弃」）
    inTx(() => writeProjection(db, account, { templates: [], settings: null }))
    expect(readProjection(db, account).settings).toBeNull()

    rebuildProjection(db, account)
    expect(readProjection(db, account).settings).toEqual(before)
  })
})

/**
 * 账号创建路径必须产生初始化设置事件（ADR-010 §6/§7）——
 * 「首次创建账号时取服务端本地时区」这句话的落点。
 *
 * 用**独立的库**：`createOwner` 只在「库里没有 owner」时可用，
 * 与文件里其它用例共库会让结果依赖执行顺序。
 */
describe('账号创建路径产生初始化设置事件（ADR-010 §6）', () => {
  let dir2: string
  let db2: Db

  beforeAll(() => {
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-events-owner-'))
    db2 = openMigratedDatabase(path.join(dir2, 'app.db'))
  })

  afterAll(() => {
    db2.close()
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  /** 设置行 → `loadAccountSettings` 的读数（缺行时它回落默认值，也就是 updatedAt=''） */
  function expectSettingsRow(accountId: string): void {
    const events = readAccountEvents(db2, accountId)
    const settingsEvent = events.find((event) => event.type === SETTINGS_UPDATED_TYPE)
    expect(settingsEvent).toBeDefined()
    expect(settingsEvent!.payload).toEqual({
      timeZone: serverTimeZone(),
      dayStartHour: DEFAULT_DAY_START_HOUR,
    })
    expect(readProjection(db2, accountId).settings).toEqual({
      accountId,
      timeZone: serverTimeZone(),
      dayStartHour: DEFAULT_DAY_START_HOUR,
      updatedAt: settingsEvent!.occurredAt,
    })
  }

  it('POST /api/setup/owner 的域逻辑：用户与设置事件在同一事务里', async () => {
    const config = testConfig(path.join(dir2, 'app.db'))
    const result = await createOwner(db2, config, {
      username: 'owner1',
      password: 'owner-password-1',
      displayName: '所有者',
    })
    expectSettingsRow(result.user.id)
    // 失败时不能留下「有账号、没设置」的中间态：这条事件与 insertUser 同事务（ADR-002 §1）。
    // 回滚由「同事务」的构造本身保证，这里断言的是「确实写在了一起」——
    // 若事件写在事务外，上面的事务回滚用例会先红。
    expect(readAccountEvents(db2, result.user.id)).toHaveLength(1)
  })

  it('POST /api/auth/register 的域逻辑同样产生初始化设置事件', async () => {
    const config = testConfig(path.join(dir2, 'app.db'))
    const ownerId = uuidv7()
    insertUser(db2, {
      id: ownerId,
      username: 'owner2',
      displayName: '另一个所有者',
      role: 'owner',
      passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
      createdAt: '2026-09-22T10:00:00+08:00',
    })
    const invite = issueInvite(db2, config, ownerId)
    const result = await registerWithInvite(db2, config, {
      username: 'member1',
      password: 'member-password-1',
      displayName: '成员',
      inviteCode: invite.code,
    })
    expectSettingsRow(result.user.id)
  })
})
