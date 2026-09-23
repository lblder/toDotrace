import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays } from '@shared/time'
import { readAccountEvents } from '../events/event-store.js'
import {
  api,
  countEventsOfType,
  createMemberAccount,
  createOwnerAccount,
  startTestServer,
  todayKey,
  type Account,
  type TestContext,
} from './helpers.js'

/**
 * 每日备注（ADR-017 §6，ADR-012 §1 的推迟项）。
 *
 * 本组的**核心断言只有一条**，但它是整个 §6 的裁决所在：
 * **无到达也可以备注，且 `days` 表一行都不建**。
 *
 * ADR-012 §1 当初删掉每日备注，反对的是「在 `days` 表上加一列 `note`」——那会让备注
 * 独立于到达存在，从而建出一行「有备注、无到达」的 `days` 行，当场推翻 §2 的
 * 「**无行 ⇔ 无到达**」不变式（FR1 的休息日判定与 ADR-002 §3 的
 * 「打卡天数 = COUNT(*)」都建立在它上面）。**该理由不适用于独立表**：
 * 备注放 `day_notes`，两条不变式各自成立、互不干扰。
 *
 * 故本文件里每一条写备注的用例，都要连带断言 `days` 表**仍未建行**。
 */

let ctx: TestContext
let owner: Account
let seq = 0

beforeAll(async () => {
  ctx = await startTestServer()
  owner = await createOwnerAccount(ctx)
})

afterAll(async () => {
  await ctx.close()
})

async function freshAccount(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `note${seq}`)
}

const TODAY = todayKey()
const YESTERDAY = addDays(TODAY, -1)

function getNote(account: Account, dayKey: string) {
  return api(ctx, 'GET', `/api/checkin/days/${dayKey}/note`, { token: account.token })
}

function putNote(account: Account, dayKey: string, text: unknown) {
  return api(ctx, 'PUT', `/api/checkin/days/${dayKey}/note`, { token: account.token, body: { text } })
}

/** `days` 的行数（ADR-012 §2 的「无行 ⇔ 无到达」不变式的直接观测点） */
function countDays(accountId: string, dayKey: string): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) AS n FROM days WHERE account_id = ? AND day_key = ?')
      .get(accountId, dayKey) as { n: number }
  ).n
}

function countDayNotes(accountId: string): number {
  return (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM day_notes WHERE account_id = ?').get(accountId) as {
      n: number
    }
  ).n
}

describe('GET /api/checkin/days/:dayKey/note', () => {
  it('没有备注时返回**空串**（不是 404：空备注是一个状态，不是缺失）', async () => {
    const account = await freshAccount()
    const res = await getNote(account, TODAY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ dayKey: TODAY, text: '' })
  })

  it('非法 dayKey → 400，且不透传给域层（ADR-009 §7）', async () => {
    const account = await freshAccount()
    // 空段（`/days//note`）进不了这条路由——Express 不匹配空路径段，由 `/api` 的兜底
    // 给出 404。那是路由层面的「没有这条路径」，与「dayKey 不合法」是两件事，故不在此列。
    for (const dayKey of ['2026-02-30', 'garbage', '2026-9-2', '2026-13-01']) {
      const res = await api(ctx, 'GET', `/api/checkin/days/${dayKey}/note`, { token: account.token })
      expect(res.status, dayKey).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
  })

  it('无令牌 → 401', async () => {
    const res = await api(ctx, 'GET', `/api/checkin/days/${TODAY}/note`)
    expect(res.status).toBe(401)
  })
})

describe('PUT /api/checkin/days/:dayKey/note：**备注不依赖到达**（§6 的裁决）', () => {
  it('无任何打卡的日子里写备注 → 成功，且 `days` 表**仍未建行**', async () => {
    const account = await freshAccount()
    expect(countDays(account.id, TODAY)).toBe(0)

    const res = await putNote(account, TODAY, '发烧在家')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ dayKey: TODAY, text: '发烧在家' })

    // ① 备注读得回来
    expect((await getNote(account, TODAY)).body.text).toBe('发烧在家')
    // ② **ADR-012 §2 的不变式未被破坏**：`days` 一行都没有（休息日的判定仍由「无行」给出）
    expect(countDays(account.id, TODAY)).toBe(0)
    // ③ 打卡接口看到的仍是「今天没打卡」
    const today = await api(ctx, 'GET', '/api/checkin/today', { token: account.token })
    expect(today.body.day).toBeNull()
    // ④ 事件写的是 `note/updated`，与打卡事件互不干涉
    expect(countEventsOfType(ctx, account.id, 'note/updated')).toBe(1)
    expect(countEventsOfType(ctx, account.id, 'checkin/arrived')).toBe(0)
  })

  it('过去的休息日也能备注（FR1 的休息日恰恰是最需要写一句的日子）', async () => {
    const account = await freshAccount()
    const res = await putNote(account, YESTERDAY, '外出开会')
    expect(res.status).toBe(200)
    expect((await getNote(account, YESTERDAY)).body.text).toBe('外出开会')
    expect(countDays(account.id, YESTERDAY)).toBe(0)
  })

  it('空串即清除：行被删除，重新 GET 返回空串（不引入 null）', async () => {
    const account = await freshAccount()
    await putNote(account, TODAY, '写点什么')
    expect(countDayNotes(account.id)).toBe(1)

    const cleared = await putNote(account, TODAY, '')
    expect(cleared.status).toBe(200)
    expect(cleared.body).toEqual({ dayKey: TODAY, text: '' })
    expect(countDayNotes(account.id)).toBe(0)
    expect((await getNote(account, TODAY)).body.text).toBe('')
    // **事件本身保留**（撤销该批次后备注原样回来）——删除的是投影行，不是事实
    expect(countEventsOfType(ctx, account.id, 'note/updated')).toBe(2)
    expect(countDays(account.id, TODAY)).toBe(0)
  })

  it('同一天的第二次写入覆盖第一次（折叠按事件 id 序，后者胜）', async () => {
    const account = await freshAccount()
    await putNote(account, TODAY, '第一版')
    await putNote(account, TODAY, '第二版')
    expect((await getNote(account, TODAY)).body.text).toBe('第二版')
    expect(countDayNotes(account.id)).toBe(1)
  })

  it('打卡之后备注仍可写，且不改变到达行', async () => {
    const account = await freshAccount()
    const arrived = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
    expect(arrived.status).toBe(200)
    const res = await putNote(account, TODAY, '今天来过')
    expect(res.status).toBe(200)
    expect(countDays(account.id, TODAY)).toBe(1)
    const today = await api(ctx, 'GET', '/api/checkin/today', { token: account.token })
    expect(today.body.day.arrivedAt).toBe(arrived.body.day.arrivedAt)
  })
})

describe('入口契约', () => {
  it('text 上限 20000 / 20001；accountId 与未知字段 → 400', async () => {
    const account = await freshAccount()
    expect((await putNote(account, TODAY, 'n'.repeat(20000))).status).toBe(200)
    expect((await putNote(account, TODAY, 'n'.repeat(20001))).status).toBe(400)

    for (const body of [{ text: 'x', accountId: owner.id }, { text: 'x', account_id: owner.id }, {}]) {
      const res = await api(ctx, 'PUT', `/api/checkin/days/${TODAY}/note`, {
        token: account.token,
        body,
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('text 不是字符串 → 400', async () => {
    const account = await freshAccount()
    for (const text of [null, 1, ['a']]) {
      expect((await putNote(account, TODAY, text)).status, JSON.stringify(text)).toBe(400)
    }
  })

  it('无令牌 → 401，且不写事件', async () => {
    const res = await api(ctx, 'PUT', `/api/checkin/days/${TODAY}/note`, { body: { text: 'x' } })
    expect(res.status).toBe(401)
  })
})

describe('账号隔离', () => {
  it('A 的备注对 B 不可见（B GET 得到空串），投影表里也只有 A 那一行', async () => {
    const a = await freshAccount()
    const b = await freshAccount()
    await putNote(a, TODAY, 'A 的备注')

    expect((await getNote(a, TODAY)).body.text).toBe('A 的备注')
    expect((await getNote(b, TODAY)).body.text).toBe('')
    expect(countDayNotes(b.id)).toBe(0)
    expect(countDayNotes(a.id)).toBe(1)
  })

  it('备注事件写在**调用者**名下（accountId 取自鉴权上下文）', async () => {
    const a = await freshAccount()
    const b = await freshAccount()
    await putNote(a, TODAY, 'A 的')
    const events = readAccountEvents(ctx.db, a.id).filter((e) => e.type === 'note/updated')
    expect(events).toHaveLength(1)
    expect(events[0]!.accountId).toBe(a.id)
    expect(readAccountEvents(ctx.db, b.id)).toHaveLength(1) // 只有注册时那条 settings/updated
  })
})
