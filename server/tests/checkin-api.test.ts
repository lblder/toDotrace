import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DAY_START_HOUR, toDayKey } from '@shared/time'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { rebuildProjection } from '../events/rebuild.js'
import { CHECKIN_ARRIVED_TYPE, CHECKIN_LEFT_TYPE } from '../events/definitions/checkin.js'
import { SETTINGS_UPDATED_TYPE } from '../events/definitions/settings.js'
import { appendEvents } from '../events/append.js'
import { serverTimeZone } from '../events/settings.js'
import { arrive, leave } from '../checkin/service.js'
import {
  api,
  createMemberAccount,
  createOwnerAccount,
  startTestServer,
  type Account,
  type TestContext,
} from './helpers.js'

/**
 * 打卡的 HTTP 契约（ADR-012 §3）与接线（§4）。
 *
 * 这是**第一个从路由层调用 `appendEvents` 的功能**，所以这一组不只测响应形状，
 * 还要证明「路由 → 事务 → 事件 → 投影」这条链真的接通了：
 * 库里出现了事件、`days` 投影等于重放结果、且增量与全量重建一致（ADR-010 §5）。
 *
 * 时间语义（凌晨归前一天、跨零点配对）用注入时钟在 `checkin-service.test.ts` 里测——
 * 走 HTTP 就只能等真实时间走到那一刻。
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

/** 账号创建时写入的设置（`serverTimeZone()` + `DEFAULT_DAY_START_HOUR`） */
const DEFAULT_CONTEXT = { timeZone: serverTimeZone(), dayStartHour: DEFAULT_DAY_START_HOUR }

/** 每个用例一个全新 member：打卡是「每天一次」的状态机，共用账号会让断言互相污染 */
async function freshMember(): Promise<Account> {
  seq += 1
  return createMemberAccount(ctx, owner.token, `member${seq}`)
}

function todayKey(now: Date = new Date()): string {
  return toDayKey(now, DEFAULT_CONTEXT)
}

function countEvents(accountId: string, type: string): number {
  return readAccountEvents(ctx.db, accountId).filter((event) => event.type === type).length
}

describe('鉴权：四条路由一律需令牌（ADR-012 §3）', () => {
  it('无令牌 → 401，且不写任何事件', async () => {
    const paths: [string, string][] = [
      ['POST', '/api/checkin/arrive'],
      ['POST', '/api/checkin/leave'],
      ['GET', '/api/checkin/today'],
      ['GET', '/api/checkin/days?from=2026-09-01&to=2026-09-30'],
    ]
    for (const [method, path] of paths) {
      const res = await api(ctx, method, path)
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.body.error.code).toBe('auth/missing-token')
    }
  })

  it('令牌无效 → 401 auth/invalid-token', async () => {
    const res = await api(ctx, 'POST', '/api/checkin/arrive', { token: 'not-a-token' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('auth/invalid-token')
  })
})

describe('到达与离开（ADR-012 §3）', () => {
  it('POST /arrive → { day, created: true }，day_key 是服务端折算的今日', async () => {
    const account = await freshMember()
    const res = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(true)
    // 响应只有这三个字段（不外泄 accountId 之类）
    expect(Object.keys(res.body.day).sort()).toEqual(['arrivedAt', 'dayKey', 'leftAt'])
    expect(res.body.day.dayKey).toBe(todayKey())
    expect(res.body.day.leftAt).toBeNull()

    // 事件真的落库了，且 day_key 与响应一致
    const events = readAccountEvents(ctx.db, account.id)
    const arrival = events.find((event) => event.type === CHECKIN_ARRIVED_TYPE)!
    expect(arrival.dayKey).toBe(res.body.day.dayKey)
    expect(arrival.payload).toEqual({}) // 载荷是空对象（§1）
    expect(arrival.targetKind).toBeNull()
    expect(arrival.targetId).toBeNull()
  })

  it('重复到达：不写第二条事件，返回既有状态（created: false）', async () => {
    const account = await freshMember()
    const first = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
    const again = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })

    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(again.body.day).toEqual(first.body.day)
    expect(countEvents(account.id, CHECKIN_ARRIVED_TYPE)).toBe(1)
  })

  it('POST /leave → 闭合今日那次到达（created: true）', async () => {
    const account = await freshMember()
    const arrived = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
    const left = await api(ctx, 'POST', '/api/checkin/leave', { token: account.token })

    expect(left.status).toBe(200)
    expect(left.body.created).toBe(true)
    expect(left.body.day.dayKey).toBe(arrived.body.day.dayKey)
    expect(left.body.day.arrivedAt).toBe(arrived.body.day.arrivedAt)
    expect(left.body.day.leftAt).not.toBeNull()
    expect(countEvents(account.id, CHECKIN_LEFT_TYPE)).toBe(1)
  })

  it('★ 账户从无到达就离开 → 409 conflict/not-arrived（分流键是「有无到达」）', async () => {
    const account = await freshMember()
    const res = await api(ctx, 'POST', '/api/checkin/leave', { token: account.token })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict/not-arrived')
    expect(countEvents(account.id, CHECKIN_LEFT_TYPE)).toBe(0)
  })

  it('已经离开过再离开 → 200 幂等，created: false，不写第二条事件（ADR-012 §5 分流表 v1.2）', async () => {
    const account = await freshMember()
    await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
    const first = await api(ctx, 'POST', '/api/checkin/leave', { token: account.token })

    const res = await api(ctx, 'POST', '/api/checkin/leave', { token: account.token })
    // 重试安全：客户端超时重发不该拿到 409，而应拿回上一次的结果
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(false)
    expect(res.body.day).toEqual(first.body.day)
    expect(res.body.day.leftAt).not.toBeNull()
    expect(countEvents(account.id, CHECKIN_LEFT_TYPE)).toBe(1)
  })

  it('两个 POST 都不接受请求体：多一个字段即 400，空对象与无 body 都通过', async () => {
    const account = await freshMember()
    const withField = await api(ctx, 'POST', '/api/checkin/arrive', {
      token: account.token,
      body: { occurredAt: '2026-09-22T09:00:00+08:00' },
    })
    expect(withField.status).toBe(400)
    expect(withField.body.error.code).toBe('validation/invalid-input')
    expect(countEvents(account.id, CHECKIN_ARRIVED_TYPE)).toBe(0)

    const emptyBody = await api(ctx, 'POST', '/api/checkin/arrive', {
      token: account.token,
      body: {},
    })
    expect(emptyBody.status).toBe(200)
    expect(emptyBody.body.created).toBe(true)
  })
})

describe('GET /today（ADR-012 §3/§5）', () => {
  it('未打卡：day 为 null（休息日），streak 为 0', async () => {
    const account = await freshMember()
    const res = await api(ctx, 'GET', '/api/checkin/today', { token: account.token })

    expect(res.status).toBe(200)
    // §5：休息日不另设 isRestDay 字段，day === null 就是它
    expect(res.body).toEqual({ day: null, streak: 0, totalDays: 0, anomalies: [] })
  })

  it('已打卡：day 有值、streak 从 1 起', async () => {
    const account = await freshMember()
    await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })

    const res = await api(ctx, 'GET', '/api/checkin/today', { token: account.token })
    expect(res.body.day.dayKey).toBe(todayKey())
    expect(res.body.streak).toBe(1)
  })
})

describe('GET /days 的参数契约（ADR-012 §3）', () => {
  async function days(token: string, query: string) {
    return api(ctx, 'GET', `/api/checkin/days?${query}`, { token })
  }

  it('from / to 均必填', async () => {
    const account = await freshMember()
    for (const query of ['', 'from=2026-09-01', 'to=2026-09-30']) {
      const res = await days(account.token, query)
      expect(res.status, query || '(空)').toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
  })

  /**
   * ★ 非法 dayKey **不得透传给域层**（ADR-012 §3）：
   * ADR-009 §7 规定 `makeDayKey` 对不存在的日历日抛 `RangeError`，
   * 透传会落到 ADR-008 的错误信封之外（500）。这一条逐个盯住那些「看着像日期」的值。
   */
  it('★ 不存在的日历日 → 400（不是 500），包括 2026-02-30', async () => {
    const account = await freshMember()
    const illegal = [
      '2026-02-30', // 2 月没有 30 日 —— §3 点名的那个
      '2026-02-29', // 2026 不是闰年
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-9-1', // 未补零
      '2026-09-1x',
      'yesterday',
      '2026-09-22T00:00:00+08:00', // 时刻不是 DayKey
    ]
    for (const value of illegal) {
      const res = await days(account.token, `from=${value}&to=2026-09-30`)
      expect(res.status, `from=${value}`).toBe(400)
      expect(res.body.error.code, `from=${value}`).toBe('validation/invalid-input')
    }
  })

  it('对照：闰年的 2 月 29 日是合法日期（判定按真实日历，不是正则）', async () => {
    const account = await freshMember()
    const res = await days(account.token, 'from=2024-02-29&to=2024-02-29')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ days: [] })
  })

  it('from > to → 400（不返回空数组）', async () => {
    const account = await freshMember()
    const res = await days(account.token, 'from=2026-09-30&to=2026-09-01')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
  })

  it('跨度上限 366 天（含两端）：366 通过，367 → 400', async () => {
    const account = await freshMember()
    const ok = await days(account.token, 'from=2026-01-01&to=2027-01-01') // 366 天
    expect(ok.status).toBe(200)

    const tooWide = await days(account.token, 'from=2026-01-01&to=2027-01-02') // 367 天
    expect(tooWide.status).toBe(400)
    expect(tooWide.body.error.code).toBe('validation/invalid-input')
  })

  it('多余的查询参数 → 400（与请求体同一套 strict 纪律）', async () => {
    const account = await freshMember()
    const res = await days(account.token, 'from=2026-09-01&to=2026-09-30&limit=10')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
  })

  it('重复键（from 出现两次）也是 400，不会落进域层', async () => {
    const account = await freshMember()
    const res = await days(account.token, 'from=2026-09-01&from=2026-09-02&to=2026-09-30')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
  })
})

describe('GET /days 的数据（升序、闭区间、只含本账号）', () => {
  /** 时区固定为 Asia/Shanghai，测试才能用确定的归属日铺数据 */
  async function memberWithFixedZone(): Promise<Account> {
    const account = await freshMember()
    ctx.db.transaction(() =>
      appendEvents(ctx.db, account.id, [
        {
          type: SETTINGS_UPDATED_TYPE,
          occurredAt: '2026-09-01T10:00:00+08:00',
          payload: { timeZone: 'Asia/Shanghai', dayStartHour: 4 },
        },
      ]),
    )()
    return account
  }

  function seed(accountId: string, iso: string): void {
    ctx.db.transaction(() => arrive(ctx.db, accountId, new Date(iso)))()
  }

  it('闭区间、升序、只含本账号的本日数据', async () => {
    const account = await memberWithFixedZone()
    const other = await memberWithFixedZone()
    for (const iso of ['2026-09-20T09:00:00+08:00', '2026-09-22T09:00:00+08:00', '2026-09-24T09:00:00+08:00']) {
      seed(account.id, iso)
      seed(other.id, iso)
    }

    const res = await api(ctx, 'GET', '/api/checkin/days?from=2026-09-20&to=2026-09-23', {
      token: account.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.days.map((day: { dayKey: string }) => day.dayKey)).toEqual([
      '2026-09-20',
      '2026-09-22',
    ])
    expect(Object.keys(res.body.days[0]).sort()).toEqual(['arrivedAt', 'dayKey', 'leftAt'])

    const all = await api(ctx, 'GET', '/api/checkin/days?from=2026-09-01&to=2026-09-30', {
      token: other.token,
    })
    expect(all.body.days).toHaveLength(3) // 另一账号的三天，没被串进来
  })

  it('离开之后同一天只有一行，leftAt 出现在同一行上', async () => {
    const account = await memberWithFixedZone()
    seed(account.id, '2026-09-20T23:00:00+08:00')
    ctx.db.transaction(() => leave(ctx.db, account.id, new Date('2026-09-21T05:00:00+08:00')))()

    const res = await api(ctx, 'GET', '/api/checkin/days?from=2026-09-20&to=2026-09-21', {
      token: account.token,
    })
    expect(res.body.days).toHaveLength(1)
    expect(res.body.days[0].dayKey).toBe('2026-09-20')
    expect(res.body.days[0].leftAt).not.toBeNull()
  })
})

describe('★ occurred_at 的偏移取自账号时区，不是进程时区（ADR-010 §1）', () => {
  it('账号时区设成 UTC 后打卡：库内四列自洽，仅凭事件行即可复算 day_key', async () => {
    const account = await freshMember()
    // 把账号时区改成 UTC（进程时区通常是 +08:00，两者不同源——正是被证伪的那一态）
    ctx.db.transaction(() =>
      appendEvents(ctx.db, account.id, [
        {
          type: SETTINGS_UPDATED_TYPE,
          occurredAt: '2026-09-22T00:00:00+00:00',
          payload: { timeZone: 'UTC', dayStartHour: 4 },
        },
      ]),
    )()

    const res = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
    expect(res.status).toBe(200)

    const row = ctx.db
      .prepare('SELECT occurred_at, timezone, day_key, day_start_hour FROM events WHERE account_id = ? AND type = ?')
      .get(account.id, CHECKIN_ARRIVED_TYPE) as {
      occurred_at: string
      timezone: string
      day_key: string
      day_start_hour: number
    }

    expect(row.timezone).toBe('UTC')
    expect(row.occurred_at.endsWith('+00:00')).toBe(true)
    expect(res.body.day.arrivedAt).toBe(row.occurred_at)
    // 审计者只拿这一行就能复算出同一个 day_key（ADR-001 §4 的可解释性）
    expect(
      toDayKey(new Date(row.occurred_at), {
        timeZone: row.timezone,
        dayStartHour: row.day_start_hour,
      }),
    ).toBe(row.day_key)
  })
})

describe('★ 接线：HTTP 打卡之后，days 投影 == 全量重建结果（ADR-012 §4 item 3 / ADR-010 §5）', () => {
  it('真实请求写入的投影经得起重建，且与重放结果逐字段一致', async () => {
    const account = await freshMember()

    // 真实 HTTP 请求（不是直接调域函数）
    const arrived = await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
    const left = await api(ctx, 'POST', '/api/checkin/leave', { token: account.token })
    expect(arrived.status).toBe(200)
    expect(left.status).toBe(200)

    // 1. 投影表 = 重放结果（ADR-010 §4 的不变式，在 HTTP 路径上成立）
    const incremental = readProjection(ctx.db, account.id)
    expect(incremental.days).toEqual(project(readAccountEvents(ctx.db, account.id)).days)

    // 2. HTTP 的响应就是投影里的那一行（响应不是另拼出来的第二个真相）
    expect(incremental.days).toHaveLength(1)
    expect(incremental.days[0]).toMatchObject({
      dayKey: arrived.body.day.dayKey,
      arrivedAt: arrived.body.day.arrivedAt,
      leftAt: left.body.day.leftAt,
    })

    // 3. 增量维护的结果 == 全量重建的结果（ADR-010 §5）
    rebuildProjection(ctx.db, account.id)
    expect(readProjection(ctx.db, account.id)).toEqual(incremental)

    // 4. 重建之后 GET /days 的响应一字不变
    const from = arrived.body.day.dayKey
    const before = await api(ctx, 'GET', `/api/checkin/days?from=${from}&to=${from}`, {
      token: account.token,
    })
    expect(before.body.days).toEqual([left.body.day])
  })
})


it('暂离接口需要认证，按当前账号操作，并拒绝未到达状态', async () => {
  const account = await freshMember()
  const other = await freshMember()
  for (const route of ['/away', '/return']) {
    expect((await api(ctx, 'POST', '/api/checkin' + route)).status).toBe(401)
    expect((await api(ctx, 'POST', '/api/checkin' + route, { token: account.token })).status).toBe(409)
  }
  await api(ctx, 'POST', '/api/checkin/arrive', { token: account.token })
  const away = await api(ctx, 'POST', '/api/checkin/away', { token: account.token })
  expect(away.status).toBe(200)
  expect(away.body.day.breaks[0].endedAt).toBeNull()
  expect((await api(ctx, 'POST', '/api/checkin/away', { token: account.token })).body.created).toBe(false)
  expect((await api(ctx, 'GET', '/api/checkin/today', { token: other.token })).body.day).toBeNull()
  const returned = await api(ctx, 'POST', '/api/checkin/return', { token: account.token })
  expect(returned.status).toBe(200)
  expect(returned.body.day.breaks[0].endedAt).not.toBeNull()
})
