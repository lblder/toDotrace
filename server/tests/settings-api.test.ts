import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DAY_START_HOUR, toDayKey } from '@shared/time'
import { readAccountEvents } from '../events/event-store.js'
import { serverTimeZone } from '../events/settings.js'
import {
  api,
  createMemberAccount,
  createOwnerAccount,
  createTaskViaApi,
  startTestServer,
  todayKey,
  type Account,
  type TestContext,
} from './helpers.js'

/**
 * 设置路由（ADR-017 §1.5 / §7）。
 *
 * 三条必须钉住的：
 *
 * 1. **`PATCH` 收差量、事件载荷是整行快照**（§7）——`settings/updated` 的两个字段
 *    都必填且 `.strict()`，故只改 `dayStartHour` 的请求**不能**直接把
 *    `{ dayStartHour }` 写进事件：服务层先读出当前 `timeZone`、合成整行、再写。
 *    漏掉这一步的后果不是报错，而是另一个字段被清空；
 * 2. **`affectsFrom` = 该账号当前的 `today`**（真实计算结果，不是死重的常量标志），
 *    且它按**改动之后**的设置算——「新设置开始生效的归属日」就是它；
 * 3. **设置变更不追溯历史**（ADR-001 §4）：既有事件的 `day_key` / `day_start_hour`
 *    逐字不变，此后写入的事件用新值。
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
  return createMemberAccount(ctx, owner.token, `set${seq}`)
}

const TODAY = todayKey()
const TZ = serverTimeZone()

describe('GET /api/settings', () => {
  it('返回账号设置 + affectsFrom（= 服务端算出的今日）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'GET', '/api/settings', { token: account.token })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      timeZone: TZ,
      dayStartHour: DEFAULT_DAY_START_HOUR,
      affectsFrom: TODAY,
      updatedAt: expect.any(String),
    })
  })

  it('响应里没有账号标识（响应体只含当前账号的数据）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'GET', '/api/settings', { token: account.token })
    expect(res.body).not.toHaveProperty('accountId')
  })
})

describe('PATCH /api/settings：差量进、**整行载荷出**', () => {
  it('只改 dayStartHour：事件载荷里 timeZone 是当前值（不是 undefined、不是被清空）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { dayStartHour: 6 },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ timeZone: TZ, dayStartHour: 6 })

    const settingsEvents = readAccountEvents(ctx.db, account.id).filter(
      (event) => event.type === 'settings/updated',
    )
    const last = settingsEvents[settingsEvents.length - 1]!
    expect(last.payload).toEqual({ timeZone: TZ, dayStartHour: 6 })
  })

  it('只改 timeZone：dayStartHour 保持当前值', async () => {
    const account = await freshAccount()
    await api(ctx, 'PATCH', '/api/settings', { token: account.token, body: { dayStartHour: 9 } })
    const res = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { timeZone: 'UTC' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ timeZone: 'UTC', dayStartHour: 9 })
  })

  it('改时区：**事件行的 `timezone` 列与 `occurred_at` 的偏移同源**（ADR-010 §1）', async () => {
    const account = await freshAccount()
    const res = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { timeZone: 'UTC' },
    })
    expect(res.status).toBe(200)

    const events = readAccountEvents(ctx.db, account.id).filter((e) => e.type === 'settings/updated')
    const last = events[events.length - 1]!
    // 四列自洽：`timezone` 是新值、`occurred_at` 的偏移取自**同一行**的 timezone
    // ——省掉 draft 里的 `timezone` 时，这一列会停在改动之前的时区，而偏移已经是新的，
    // 两列互相解释不通（阶段 3 独立验证抓过同一个形状）。
    expect(last.timezone).toBe('UTC')
    expect(last.occurredAt.endsWith('+00:00')).toBe(true)
    expect(last.payload).toEqual({ timeZone: 'UTC', dayStartHour: DEFAULT_DAY_START_HOUR })
  })

  it('非法时区 → 400；**大小写不规范的合法名（asia/shanghai）→ 成功**（ADR-009 §9）', async () => {
    const account = await freshAccount()
    for (const timeZone of ['Not/AZone', '', 'UTC+8', 'Shanghai']) {
      const res = await api(ctx, 'PATCH', '/api/settings', { token: account.token, body: { timeZone } })
      expect(res.status, timeZone).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
    // ADR-009 §9 的口径是「`Intl` 认不认得」，不是「与 IANA 注册表逐字相符」
    const ok = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { timeZone: 'asia/shanghai' },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.timeZone).toBe('asia/shanghai')
  })

  it('dayStartHour 越界 / 非整数 → 400', async () => {
    const account = await freshAccount()
    for (const dayStartHour of [-1, 24, 1.5, '4', null]) {
      const res = await api(ctx, 'PATCH', '/api/settings', {
        token: account.token,
        body: { dayStartHour },
      })
      expect(res.status, JSON.stringify(dayStartHour)).toBe(400)
    }
  })

  it('accountId / 未知字段 → 400（.strict()）', async () => {
    const account = await freshAccount()
    for (const body of [{ accountId: owner.id }, { timezone: 'UTC' }, { nope: 1 }]) {
      const res = await api(ctx, 'PATCH', '/api/settings', { token: account.token, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('affectsFrom 是真实计算结果（ADR-017 §7）', () => {
  it('按**改动之后**的设置算：改到会让归属日变动的 dayStartHour 时，affectsFrom 跟着变', async () => {
    const account = await freshAccount()
    const now = new Date()
    // 找一个会让归属日与当前不同的 dayStartHour（本地时刻小于 H 时，这一天从前一天的 H:00 起算）
    const candidate = Array.from({ length: 24 }, (_, hour) => hour).find(
      (hour) => toDayKey(now, { timeZone: TZ, dayStartHour: hour }) !== TODAY,
    )
    if (candidate === undefined) {
      // 本地时刻恰好落在「任何 dayStartHour 都给出同一天」的窗口（如 23:30）：
      // 这时只断言「affectsFrom 存在且是合法的归属日」，不假装能观察到位移。
      const res = await api(ctx, 'PATCH', '/api/settings', {
        token: account.token,
        body: { dayStartHour: (new Date().getHours() + 1) % 24 },
      })
      expect(res.status).toBe(200)
      expect(res.body.affectsFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      return
    }

    const res = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { dayStartHour: candidate },
    })
    expect(res.status).toBe(200)
    expect(res.body.affectsFrom).toBe(toDayKey(now, { timeZone: TZ, dayStartHour: candidate }))
    // 再 GET 一次：affectsFrom 与 PATCH 的响应一致（它是设置算出的事实，不是一次性快照）
    const read = await api(ctx, 'GET', '/api/settings', { token: account.token })
    expect(read.body.affectsFrom).toBe(res.body.affectsFrom)
  })
})

describe('设置变更**不追溯历史**（ADR-001 §4 / ADR-017 §7）', () => {
  it('既有事件的 day_key / day_start_hour 逐字不变；此后写入的事件用新值', async () => {
    const account = await freshAccount()
    // 先写一条事件（建任务），记下它的固化列
    const task = await createTaskViaApi(ctx, account.token, { title: '改动之前', plannedDate: TODAY })
    const before = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/created')!
    expect(before.dayKey).toBe(TODAY)
    expect(before.dayStartHour).toBe(DEFAULT_DAY_START_HOUR)
    expect(task.indexDate).toBe(TODAY)

    const next = (DEFAULT_DAY_START_HOUR + 1) % 24
    const patched = await api(ctx, 'PATCH', '/api/settings', {
      token: account.token,
      body: { dayStartHour: next },
    })
    expect(patched.status).toBe(200)

    // ① 历史事件**逐字不变**（永不重算）
    const stillThere = readAccountEvents(ctx.db, account.id).find((e) => e.type === 'task/created')!
    expect(stillThere.dayKey).toBe(before.dayKey)
    expect(stillThere.dayStartHour).toBe(before.dayStartHour)
    expect(stillThere.timezone).toBe(before.timezone)
    // 实例键也是写入时固化的，不跟着设置走
    const detail = await api(ctx, 'GET', `/api/tasks/${task.taskId}`, { token: account.token })
    expect(detail.body.task.indexDate).toBe(TODAY)

    // ② 此后写入的事件用新值
    await createTaskViaApi(ctx, account.token, { title: '改动之后' })
    const after = readAccountEvents(ctx.db, account.id)
      .filter((e) => e.type === 'task/created')
      .at(-1)!
    expect(after.dayStartHour).toBe(next)
    // 归属日按新设置算（可能仍是同一天——取决于当前时刻在窗口的哪一侧）
    expect(after.dayKey).toBe(toDayKey(new Date(), { timeZone: TZ, dayStartHour: next }))
  })
})
