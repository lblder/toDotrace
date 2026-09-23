import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { appendEvents, listRegisteredTypes, readAccountEvents, rebuildProjection } from '../events/index.js'
import { countProjectedDayNotes, countProjectedProjects, readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { NOTE_UPDATED_TYPE } from '../events/definitions/notes.js'
import { PROJECT_TARGET_KIND } from '../events/definitions/projects.js'
import type { Event, EventDraft } from '../events/types.js'
import { insertUser } from '../repo/users.js'

/**
 * 四类项目事件（ADR-016 §5）与 `note/updated`（ADR-017 §6）——阶段 4 的登记项。
 *
 * 三条贯穿：
 *
 * 1. **每个字段只有一个写入者**：`isCurrent` 只由 `project/current-changed` 写、
 *    `deletedAt` 只由 `project/deleted` 写，`project/updated` 因此不携带这两个字段；
 * 2. **软删除**：项目行**永不被物理删除**——这是「删项目后其下任务的 `projectId`
 *    仍可解析」不需要任何额外机制的原因（ADR-016 §6）；
 * 3. **每日备注独立于到达**：它不进 `days`（那会建出「有备注、无到达」的行，
 *    推翻 ADR-012 §2 的「无行 ⇔ 无到达」不变式），而是自己一张表。
 */

let dir: string
let db: Db
let seq = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-projects-'))
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

function pid(account: string, name: string): string {
  return `${account}:${name}`
}

function inTx<T>(fn: () => T): T {
  return db.transaction(fn)()
}

function append(account: string, drafts: EventDraft[]): Event[] {
  return inTx(() => appendEvents(db, account, drafts))
}

function createdProject(projectId: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'project/created',
    occurredAt: '2026-09-01T10:00:00+08:00',
    targetKind: PROJECT_TARGET_KIND,
    targetId: projectId,
    batchId: nextId(),
    payload: { projectId, name: '毕业课题', startsOn: '2026-09-01', endsOn: '2026-09-30' },
    ...overrides,
  }
}

function updatedProject(projectId: string, payload: Record<string, unknown>, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'project/updated',
    occurredAt: '2026-09-10T10:00:00+08:00',
    targetKind: PROJECT_TARGET_KIND,
    targetId: projectId,
    batchId: nextId(),
    payload: { projectId, name: '毕业课题', startsOn: '2026-09-01', endsOn: '2026-09-30', ...payload },
    ...overrides,
  }
}

function currentChanged(projectId: string | null, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: 'project/current-changed',
    occurredAt: '2026-09-02T10:00:00+08:00',
    batchId: nextId(),
    payload: { projectId },
    ...overrides,
  }
}

function noteUpdated(dayKey: string, text: string, overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    type: NOTE_UPDATED_TYPE,
    occurredAt: '2026-09-22T10:00:00+08:00',
    batchId: nextId(),
    payload: { dayKey, text },
    ...overrides,
  }
}

function expectProjectionMatchesReplay(accountId: string): void {
  expect(readProjection(db, accountId)).toEqual(project(readAccountEvents(db, accountId)))
}

function daysCount(accountId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM days WHERE account_id = ?').get(accountId) as {
    n: number
  }
  return row.n
}

describe('登记（ADR-010 §2）', () => {
  it('四类项目事件 + note/updated 都在注册表里', () => {
    // 从**注册表**读（而不是从定义数组），顺带证明它们真的登记进了那个唯一清单
    const types = listRegisteredTypes()
    for (const type of [
      'project/created',
      'project/updated',
      'project/deleted',
      'project/current-changed',
      'note/updated',
    ]) {
      expect(types).toContain(type)
    }
  })
})

describe('project/created（插入行）', () => {
  it('逐字段等于载荷 + 事件里的账号与时刻；isCurrent 初始为 false、deletedAt 为 null', () => {
    const account = freshAccount()
    const projectId = pid(account, 'p1')
    append(account, [createdProject(projectId)])

    expect(readProjection(db, account).projects).toEqual([
      {
        id: projectId,
        accountId: account,
        name: '毕业课题',
        startsOn: '2026-09-01',
        endsOn: '2026-09-30',
        isCurrent: false, // 新建即「不是当前项目」；要设当前就追加一条 5.4
        deletedAt: null,
        createdAt: '2026-09-01T10:00:00+08:00',
        updatedAt: '2026-09-01T10:00:00+08:00',
      },
    ])
  })

  it('起止同日合法（1 天项目），同名项目合法（名字不是标识）', () => {
    const account = freshAccount()
    append(account, [
      createdProject(pid(account, 'p1'), { payload: { projectId: pid(account, 'p1'), name: '实验', startsOn: '2026-09-10', endsOn: '2026-09-10' } }),
      createdProject(pid(account, 'p2'), { payload: { projectId: pid(account, 'p2'), name: '实验', startsOn: '2026-09-01', endsOn: '2026-09-30' } }),
    ])
    expect(readProjection(db, account).projects.map((p) => p.name)).toEqual(['实验', '实验'])
  })

  it('同一项目 id 的第二次 created 覆盖而不是抛错（合并导入）', () => {
    const account = freshAccount()
    const projectId = pid(account, 'p1')
    append(account, [createdProject(projectId)])
    append(account, [createdProject(projectId, { batchId: nextId(), payload: { projectId, name: '改名后的', startsOn: '2026-09-01', endsOn: '2026-09-30' } })])
    const projects = readProjection(db, account).projects
    expect(projects).toHaveLength(1)
    expect(projects[0]!.name).toBe('改名后的')
  })
})

describe('project/updated（改名 / 改期，整行快照）', () => {
  it('覆盖 name / startsOn / endsOn，把 updatedAt 推到事件时刻', () => {
    const account = freshAccount()
    const projectId = pid(account, 'p1')
    append(account, [createdProject(projectId)])
    append(account, [updatedProject(projectId, { name: '延期的课题', endsOn: '2026-10-15' })])

    expect(readProjection(db, account).projects[0]).toMatchObject({
      name: '延期的课题',
      startsOn: '2026-09-01',
      endsOn: '2026-10-15',
      createdAt: '2026-09-01T10:00:00+08:00',
      updatedAt: '2026-09-10T10:00:00+08:00',
    })
  })

  /**
   * **`project/updated` 不携带 `isCurrent` 与 `deletedAt`**（ADR-016 §5.2）：
   * 每一个字段只有一个写入者。若它顺带把 `isCurrent` 清掉，
   * 一次改名就会让「当前项目」消失，而**没有任何事件解释这件事**。
   */
  it('不携带 isCurrent / deletedAt：改期时它们逐字不变', () => {
    const account = freshAccount()
    const projectId = pid(account, 'p1')
    append(account, [createdProject(projectId), currentChanged(projectId)])
    expect(readProjection(db, account).projects[0]!.isCurrent).toBe(true)

    append(account, [updatedProject(projectId, { name: '改名' })])
    expect(readProjection(db, account).projects[0]!.isCurrent).toBe(true)

    // 载荷里带上它们即 400（`.strict()`：静默忽略会让调用方以为自己改成功了）
    expect(() =>
      append(account, [
        updatedProject(projectId, { isCurrent: true, deletedAt: null, name: '再改' }),
      ]),
    ).toThrow(/载荷不合法/)
  })

  it('没有对应项目时是无操作：不伪造出一个没有创建事实的半行', () => {
    const account = freshAccount()
    append(account, [updatedProject(pid(account, 'ghost'), { name: '无中生有' })])
    expect(readProjection(db, account).projects).toHaveLength(0)
  })
})

describe('project/deleted（软删除）', () => {
  it('载荷只有 projectId；行**还在**、只置 deletedAt，且一并清掉 isCurrent', () => {
    const account = freshAccount()
    const projectId = pid(account, 'p1')
    append(account, [createdProject(projectId), currentChanged(projectId)])
    const [event] = append(account, [
      { type: 'project/deleted', occurredAt: '2026-09-20T10:00:00+08:00', batchId: nextId(), payload: { projectId } },
    ])
    // 不携带快照：行还在，多存一份定义就是第二个真相（§5.3）
    expect(event!.payload).toEqual({ projectId })

    const projects = readProjection(db, account).projects
    expect(projects).toHaveLength(1) // 行保留
    expect(projects[0]!.deletedAt).toBe('2026-09-20T10:00:00+08:00')
    expect(projects[0]!.isCurrent).toBe(false) // 「已删除的项目不能是当前项目」是不变式
    expect(projects[0]!.name).toBe('毕业课题') // 定义照常读得到
  })

  /**
   * **撤销 `project/deleted` 所在批次 → 项目逐字段回来**（含 `isCurrent`）。
   *
   * 「回来」不是靠某个还原动作，而是靠**撤销让那条事件不再参与折叠**——
   * 行的存在性从来没有变过（软删除），故 `isCurrent` 也随之回到删除前的取值。
   */
  it('撤销删除批次后逐字段还原（含 isCurrent）', () => {
    const account = freshAccount()
    const projectId = pid(account, 'p1')
    append(account, [createdProject(projectId), currentChanged(projectId)])
    const before = readProjection(db, account).projects[0]!

    const deleted = append(account, [
      { type: 'project/deleted', occurredAt: '2026-09-20T10:00:00+08:00', payload: { projectId } },
    ])[0]!
    expect(readProjection(db, account).projects[0]!.deletedAt).not.toBeNull()

    append(account, [
      { type: 'system/revoke', occurredAt: '2026-09-21T10:00:00+08:00', payload: { targetBatchId: deleted.batchId } },
    ])
    expect(readProjection(db, account).projects[0]!).toEqual(before)
    expect(readProjection(db, account).projects[0]!.isCurrent).toBe(true)
    expectProjectionMatchesReplay(account)
  })
})

describe('project/current-changed（至多一个当前项目）', () => {
  it('切到某项目：先全清、再置 true', () => {
    const account = freshAccount()
    const a = pid(account, 'a')
    const b = pid(account, 'b')
    append(account, [createdProject(a), createdProject(b)])
    append(account, [currentChanged(a)])
    expect(readProjection(db, account).projects.filter((p) => p.isCurrent).map((p) => p.id)).toEqual([a])

    append(account, [currentChanged(b)])
    expect(readProjection(db, account).projects.filter((p) => p.isCurrent).map((p) => p.id)).toEqual([b])
  })

  it('重复写同一条是幂等的（本事件不带 from，故重放与导入合并都不会产生第二个真相）', () => {
    const account = freshAccount()
    const a = pid(account, 'a')
    append(account, [createdProject(a)])
    append(account, [currentChanged(a)])
    append(account, [currentChanged(a)])
    expect(readProjection(db, account).projects.filter((p) => p.isCurrent)).toHaveLength(1)
  })

  /**
   * **`{ projectId: null }` 能写入、能重放**——这是它**不声明 `target`** 的原因
   * （ADR-016 §5.4）：`fromPayload` 必须返回非空字符串，声明 `target` 会让这一类
   * 合法事件根本写不进去。它对应 `DELETE /api/projects/current`：
   * 没有这个入口，用户就处在一个**只能被事件推入、不能主动进入**的状态里。
   */
  it('projectId 为 null：写入成功、重放得到「没有当前项目」', () => {
    const account = freshAccount()
    const a = pid(account, 'a')
    append(account, [createdProject(a), currentChanged(a)])
    const [event] = append(account, [currentChanged(null, { occurredAt: '2026-09-05T10:00:00+08:00' })])
    expect(event!.targetKind).toBeNull() // 两列为 NULL（不声明 target）
    expect(event!.targetId).toBeNull()
    expect(readProjection(db, account).projects.every((p) => !p.isCurrent)).toBe(true)
    expectProjectionMatchesReplay(account)
  })

  it('撤销切换批次后，当前项目恢复到**上一条**事件的值', () => {
    const account = freshAccount()
    const a = pid(account, 'a')
    const b = pid(account, 'b')
    append(account, [createdProject(a), createdProject(b)])
    append(account, [currentChanged(a)])
    const switched = append(account, [currentChanged(b, { occurredAt: '2026-09-06T10:00:00+08:00' })])[0]!
    expect(readProjection(db, account).projects.find((p) => p.isCurrent)!.id).toBe(b)

    append(account, [
      { type: 'system/revoke', occurredAt: '2026-09-07T10:00:00+08:00', payload: { targetBatchId: switched.batchId } },
    ])
    expect(readProjection(db, account).projects.find((p) => p.isCurrent)!.id).toBe(a)
    expectProjectionMatchesReplay(account)
  })

  it('指向不存在的项目：重放得到「一个当前项目都没有」（服务层在写入前就拒了，400）', () => {
    const account = freshAccount()
    append(account, [currentChanged(pid(account, 'ghost'))])
    expect(readProjection(db, account).projects).toHaveLength(0)
  })
})

describe('note/updated（每日备注，ADR-017 §6）', () => {
  it('无任何打卡的日子里也能备注，且**不建 days 行**（两条不变式各自成立）', () => {
    const account = freshAccount()
    append(account, [noteUpdated('2026-09-22', '发烧在家')])
    expect(readProjection(db, account).dayNotes).toEqual([
      { accountId: account, dayKey: '2026-09-22', text: '发烧在家', updatedAt: '2026-09-22T10:00:00+08:00' },
    ])
    // 「无行 ⇔ 无到达」没有被备注破坏：days 一行都没有
    expect(daysCount(account)).toBe(0)
  })

  it('同一归属日再写一条：后者整条胜出，updatedAt 推到该事件时刻', () => {
    const account = freshAccount()
    append(account, [noteUpdated('2026-09-22', '第一稿')])
    append(account, [noteUpdated('2026-09-22', '第二稿', { occurredAt: '2026-09-23T10:00:00+08:00' })])
    const notes = readProjection(db, account).dayNotes
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ text: '第二稿', updatedAt: '2026-09-23T10:00:00+08:00' })
  })

  it('text 为空串即清除该行；撤销该批次后备注原样回来', () => {
    const account = freshAccount()
    append(account, [noteUpdated('2026-09-22', '要清掉的')])
    const cleared = append(account, [noteUpdated('2026-09-22', '', { occurredAt: '2026-09-23T10:00:00+08:00' })])[0]!
    expect(readProjection(db, account).dayNotes).toEqual([])
    expect(countProjectedDayNotes(db, account)).toBe(0)

    append(account, [
      { type: 'system/revoke', occurredAt: '2026-09-24T10:00:00+08:00', payload: { targetBatchId: cleared.batchId } },
    ])
    // 清除的是**投影行**，不是事实：撤销那条事件，备注就回来了
    expect(readProjection(db, account).dayNotes[0]!.text).toBe('要清掉的')
    expectProjectionMatchesReplay(account)
  })

  it('空串本身不落库（「有没有备注」只有一种表示）', () => {
    const account = freshAccount()
    append(account, [noteUpdated('2026-09-22', '')])
    expect(readProjection(db, account).dayNotes).toEqual([])
  })

  it('多天的备注按 dayKey 升序（与 canonicalizeProjection 的规范化顺序一致）', () => {
    const account = freshAccount()
    append(account, [noteUpdated('2026-09-22', '后'), noteUpdated('2026-09-01', '前')])
    expect(readProjection(db, account).dayNotes.map((note) => note.dayKey)).toEqual([
      '2026-09-01',
      '2026-09-22',
    ])
    expectProjectionMatchesReplay(account)
  })
})

describe('多账号隔离（ADR-010 §1 的复合主键）', () => {
  it('同一个项目 id 在两个账号下各有一份副本', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    const sharedProjectId = 'bbbbbbbb-0000-7000-8000-000000000001'
    const imported = createdProject(sharedProjectId, { id: nextId(), batchId: nextId() })

    append(alice, [imported])
    expect(inTx(() => appendEvents(db, bob, [imported]))).toHaveLength(1)

    expect(readProjection(db, alice).projects.map((row) => [row.accountId, row.id])).toEqual([
      [alice, sharedProjectId],
    ])
    expect(readProjection(db, bob).projects.map((row) => [row.accountId, row.id])).toEqual([
      [bob, sharedProjectId],
    ])
    expect(countProjectedProjects(db, alice)).toBe(1)
    expect(countProjectedProjects(db, bob)).toBe(1)

    rebuildProjection(db, alice)
    expectProjectionMatchesReplay(alice)
    expectProjectionMatchesReplay(bob)
  })

  it('一个账号的备注不会被另一个账号的写入改动', () => {
    const alice = freshAccount()
    const bob = freshAccount()
    append(alice, [noteUpdated('2026-09-22', 'A 的备注')])
    expect(readProjection(db, bob).dayNotes).toHaveLength(0)
    append(bob, [noteUpdated('2026-09-22', 'B 的备注')])
    expect(readProjection(db, alice).dayNotes[0]!.text).toBe('A 的备注')
    expect(readProjection(db, bob).dayNotes[0]!.text).toBe('B 的备注')
  })
})

describe('增量与全量（ADR-010 §5）：项目与备注的每类事件都走一遍', () => {
  it('建—改—切当前—删—备注走一遍，增量结果 == 重建结果', () => {
    const account = freshAccount()
    const a = pid(account, 'a')
    const b = pid(account, 'b')
    append(account, [createdProject(a), createdProject(b)])
    append(account, [updatedProject(a, { name: 'A 改名', endsOn: '2026-10-15' })])
    append(account, [currentChanged(a)])
    append(account, [noteUpdated('2026-09-22', '写了一句')])
    append(account, [{ type: 'project/deleted', occurredAt: '2026-09-20T10:00:00+08:00', batchId: nextId(), payload: { projectId: b } }])

    const incremental = readProjection(db, account)
    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
    expect(incremental.projects.map((row) => row.name)).toEqual(['A 改名', '毕业课题'])
    expect(incremental.projects.find((row) => row.id === b)!.deletedAt).not.toBeNull()
    expect(incremental.dayNotes).toHaveLength(1)
  })
})
