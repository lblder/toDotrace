import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toDayKey } from '@shared/time'
import { openMigratedDatabase, type Db } from '../db/index.js'
import { toIso } from '../lib/time.js'
import { appendEvents } from '../events/append.js'
import { readAccountEvents } from '../events/event-store.js'
import { readProjection } from '../events/projection-store.js'
import { project } from '../events/project.js'
import { rebuildProjection } from '../events/rebuild.js'
import { CHECKIN_ARRIVED_TYPE, CHECKIN_LEFT_TYPE } from '../events/definitions/checkin.js'
import { SETTINGS_UPDATED_TYPE } from '../events/definitions/settings.js'
import { ApiError } from '../lib/errors.js'
import { insertUser } from '../repo/users.js'
import { arrive, leave, listDays, today } from '../checkin/service.js'

/**
 * 打卡的域语义（ADR-012 §3 的幂等 / §5 的配对规则）。
 *
 * **时钟一律注入**（`arrived(db, account, now)`）：ADR-009 的纪律是纯函数不读系统时钟，
 * 而这里要断言的恰恰是**跨零点**这类只靠真实时钟测不到的行为——
 * 「23:00 到达 → 次日 05:00 离开记在同一天」不可能靠等一晚上来验证。
 *
 * 账号设置铺成 `Asia/Shanghai` + `dayStartHour = 4`，于是归属日只由
 * 「账号时区 + 起始小时」决定，与服务端运行的时区无关。
 */

let dir: string
let db: Db
let seq = 0

const TZ = 'Asia/Shanghai'

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-checkin-service-'))
  db = openMigratedDatabase(path.join(dir, 'app.db'))
})

afterAll(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 新账号 + 一条 `settings/updated`（时区与起始小时固化下来，测试才可确定地推算归属日） */
function freshAccount(dayStartHour = 4, timeZone = TZ): string {
  seq += 1
  const id = `u-${seq}`
  insertUser(db, {
    id,
    username: `user${seq}`,
    displayName: `用户${seq}`,
    role: 'member',
    passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
    createdAt: '2026-09-20T10:00:00+08:00',
  })
  db.transaction(() =>
    appendEvents(db, id, [
      {
        type: SETTINGS_UPDATED_TYPE,
        occurredAt: '2026-09-20T10:00:00+08:00',
        payload: { timeZone, dayStartHour },
      },
    ]),
  )()
  return id
}

/** 打卡路径都要求调用方已在事务内（ADR-012 §4）——测试也走同一道门 */
function inTx<T>(fn: () => T): T {
  return db.transaction(fn)()
}

function at(iso: string): Date {
  return new Date(iso)
}

function eventTypes(accountId: string): string[] {
  return readAccountEvents(db, accountId).map((event) => event.type)
}

/** 账号铺设置时也写了一条事件，取到达事件必须按类型挑（不能按下标 0） */
function arrivalEvent(accountId: string) {
  const event = readAccountEvents(db, accountId).find((row) => row.type === CHECKIN_ARRIVED_TYPE)
  if (event === undefined) throw new Error('没有到达事件')
  return event
}

describe('归属日：到达（ADR-012 §5 第一条）', () => {
  it('凌晨到达归前一天（dayStartHour = 4）', () => {
    const account = freshAccount()
    const result = inTx(() => arrive(db, account, at('2026-09-23T02:00:00+08:00')))

    expect(result.created).toBe(true)
    expect(result.day.dayKey).toBe('2026-09-22')
    // 事件上的 occurred_at 仍是真实发生时刻——被「归到前一天」的只有 day_key
    expect(Date.parse(result.day.arrivedAt)).toBe(Date.parse('2026-09-23T02:00:00+08:00'))
    expect(arrivalEvent(account).dayKey).toBe('2026-09-22')
  })

  it('白天到达归当天；起始小时整点算当天（04:00 不归前一天）', () => {
    const account = freshAccount()
    expect(inTx(() => arrive(db, account, at('2026-09-23T09:00:00+08:00'))).day.dayKey).toBe(
      '2026-09-23',
    )

    const boundary = freshAccount()
    expect(inTx(() => arrive(db, boundary, at('2026-09-23T04:00:00+08:00'))).day.dayKey).toBe(
      '2026-09-23',
    )
  })

  it('到达的 day_start_hour 取写入时生效的设置（它是「这天为什么归到这天」的解释）', () => {
    const account = freshAccount(6)
    inTx(() => arrive(db, account, at('2026-09-23T05:00:00+08:00')))

    const event = arrivalEvent(account)
    expect(event.dayStartHour).toBe(6)
    expect(event.dayKey).toBe('2026-09-22') // 05:00 < 06:00 ⇒ 前一天
  })
})

describe('配对：离开闭合最近一条有到达的行（ADR-012 §5，v1.1/v1.2 最重要的一处）', () => {
  it('★ 跨零点的到访记在同一天：到达 23:00 → 离开次日 05:00，时长 6 小时', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T23:00:00+08:00')))
    const closed = inTx(() => leave(db, account, at('2026-09-23T05:00:00+08:00')))

    expect(closed.created).toBe(true)
    // 归属日 = 它所闭合的那次到达的归属日（§5），**不是** 05:00 自己折算出的 09-23
    expect(closed.day.dayKey).toBe('2026-09-22')
    expect(closed.day.leftAt).not.toBeNull()
    expect(Date.parse(closed.day.leftAt!) - Date.parse(closed.day.arrivedAt)).toBe(
      6 * 60 * 60 * 1000,
    )

    // 离开事件的行上：day_key 与到达同日，而 occurred_at 是次日凌晨
    const left = readAccountEvents(db, account).find((event) => event.type === CHECKIN_LEFT_TYPE)!
    expect(left.dayKey).toBe('2026-09-22')
    expect(Date.parse(left.occurredAt)).toBe(Date.parse('2026-09-23T05:00:00+08:00'))

    // 没有产生「有离开、无到达」的 09-23 行——那正是 §2 用结构堵死的形态
    expect(readProjection(db, account).days.map((row) => row.dayKey)).toEqual(['2026-09-22'])
  })

  it('★ 账户从无到达 → 409 conflict/not-arrived（不是静默写一条无到达的离开）', () => {
    const account = freshAccount()
    try {
      inTx(() => leave(db, account, at('2026-09-22T18:00:00+08:00')))
      throw new Error('本应抛出 409')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(409)
      expect((error as ApiError).code).toBe('conflict/not-arrived')
    }
    expect(readAccountEvents(db, account)).toHaveLength(1) // 只有那条 settings/updated
    expect(readProjection(db, account).days).toHaveLength(0)
  })

  /**
   * ⚠️ **留痕：这里曾经有一处契约矛盾**（实现者发现，ADR-012 §5 于 v1.2 裁决修掉）。
   *
   * 本 ADR v1.1 的 §3 幂等段写「重复离开（该到达已闭合）→ `created: false`」，
   * 而 §3 的失败路径表与 §5 写「无未闭合到达 → 409」；同时 §3 又规定
   * 「判据一律读当前投影，不扫事件流水」。三者合读**无法区分「已经离开过」与
   * 「从没到达过」**——在投影上它们是同一个状态（无未闭合到达），
   * 于是幂等与 409 不能并存。
   *
   * **裁决（§5 v1.2）：两边都要，换分流键**——从「有无**未闭合**到达」改成
   * 「**有无到达**」：从没有过到达才是 409；有过到达但已闭合，是重试或重复点击 → 幂等。
   * 这条测试固定住裁决结果。**这个坑曾经真实存在，留痕不删。**
   */
  it('已经离开过再离开 → 200 幂等返回该行，created: false（§5 分流表第 3 行）', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T09:00:00+08:00')))
    const first = inTx(() => leave(db, account, at('2026-09-22T12:00:00+08:00')))

    const again = inTx(() => leave(db, account, at('2026-09-22T18:00:00+08:00')))

    // 幂等：返回**既有的那一行**（第一次离开的时刻），不是 409，也不是新时刻
    expect(again.created).toBe(false)
    expect(again.day).toEqual(first.day)
    expect(Date.parse(again.day.leftAt!)).toBe(Date.parse('2026-09-22T12:00:00+08:00'))
    // 没有写出第二条离开事件
    expect(eventTypes(account).filter((type) => type === CHECKIN_LEFT_TYPE)).toHaveLength(1)
  })

  /**
   * §5 的分流表只看「**最近那条**有到达的行」，不回头找更早的未闭合行。
   * 本阶段每天至多一次到达（到达幂等），因此「最近一条」即当日那次，不会配错会话；
   * 代价是更早那条未闭合的到达会一直保持未闭合（时长未知）——如实记下，不粉饰。
   */
  it('最近那条已闭合时，第二次离开不回头闭合更早的未闭合行（§5 只看最近一条）', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-20T09:00:00+08:00')))
    inTx(() => arrive(db, account, at('2026-09-21T09:00:00+08:00')))
    inTx(() => leave(db, account, at('2026-09-21T18:00:00+08:00'))) // 闭合 09-21（最近一条）

    const again = inTx(() => leave(db, account, at('2026-09-22T09:00:00+08:00')))

    expect(again.created).toBe(false)
    expect(again.day.dayKey).toBe('2026-09-21') // 最近那条，不是 09-20
    expect(
      readProjection(db, account).days.map((row) => [row.dayKey, row.leftAt === null]),
    ).toEqual([
      ['2026-09-20', true], // 仍未闭合——分流表不回头
      ['2026-09-21', false],
    ])
    expect(eventTypes(account).filter((type) => type === CHECKIN_LEFT_TYPE)).toHaveLength(1)
  })

  /**
   * ★ §5 明写「按 `day_key` 降序」，**不是**按 `arrived_at` 的时刻。
   * 两者只在设置被改动过（后写的到达归到更早的日）或导入乱序数据上分歧，
   * 正常路径同解——所以这一条必须人为造出分歧，否则契约的选择无人看守。
   */
  it('★「最近一条」按 day_key 降序取，不是按 arrived_at 的时刻取', () => {
    const account = freshAccount(4)
    inTx(() => arrive(db, account, at('2026-09-25T05:00:00+08:00'))) // h=4 ⇒ 归属日 09-25

    // 把起始小时改成 23：此后 09-25 20:00 写下的到达，归属日反而落到 09-24
    inTx(() =>
      appendEvents(db, account, [
        {
          type: SETTINGS_UPDATED_TYPE,
          occurredAt: '2026-09-25T12:00:00+08:00',
          payload: { timeZone: TZ, dayStartHour: 23 },
        },
      ]),
    )
    inTx(() => arrive(db, account, at('2026-09-25T20:00:00+08:00')))

    const rows = readProjection(db, account).days
    expect(rows.map((row) => row.dayKey)).toEqual(['2026-09-24', '2026-09-25'])
    // 时刻上更近的是 09-25T20:00（09-24 那行）；契约要的是 day_key 最大的 09-25
    expect(Date.parse(rows[1]!.arrivedAt)).toBeLessThan(Date.parse(rows[0]!.arrivedAt))
    expect(inTx(() => leave(db, account, at('2026-09-26T09:00:00+08:00'))).day.dayKey).toBe(
      '2026-09-25',
    )
  })

  it('多条未闭合的到达：闭合 day_key 最大的那一次', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-20T09:00:00+08:00')))
    inTx(() => arrive(db, account, at('2026-09-21T09:00:00+08:00')))

    const closed = inTx(() => leave(db, account, at('2026-09-21T18:00:00+08:00')))

    expect(closed.day.dayKey).toBe('2026-09-21')
    const rows = readProjection(db, account).days
    expect(rows.map((row) => [row.dayKey, row.leftAt === null])).toEqual([
      ['2026-09-20', true], // 仍未闭合（时长未知）
      ['2026-09-21', false],
    ])
  })

  it('离开可以跨多天闭合（到达后隔了两天才离开）', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-20T09:00:00+08:00')))
    const closed = inTx(() => leave(db, account, at('2026-09-23T09:00:00+08:00')))

    expect(closed.day.dayKey).toBe('2026-09-20')
    expect(Date.parse(closed.day.leftAt!) - Date.parse(closed.day.arrivedAt)).toBe(
      3 * 24 * 60 * 60 * 1000,
    )
  })
})

describe('幂等：到达（ADR-012 §3）', () => {
  it('当天重复到达不写第二条事件，返回既有状态（created: false）', () => {
    const account = freshAccount()
    const first = inTx(() => arrive(db, account, at('2026-09-22T09:00:00+08:00')))
    const again = inTx(() => arrive(db, account, at('2026-09-22T15:00:00+08:00')))

    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    // 返回的是**既有**状态：时刻仍是第一次的 09:00，没有被第二次改写
    expect(Date.parse(again.day.arrivedAt)).toBe(Date.parse('2026-09-22T09:00:00+08:00'))
    expect(eventTypes(account).filter((type) => type === CHECKIN_ARRIVED_TYPE)).toHaveLength(1)
  })

  it('判据读当前投影：到达 → 离开 → 当天再到达仍被幂等挡下', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T09:00:00+08:00')))
    inTx(() => leave(db, account, at('2026-09-22T12:00:00+08:00')))

    // 「每天至多一条未被撤销的 arrived」（§3 的准确表述）——已闭合也是已有，
    // 与「未被撤销」不矛盾：闭合不是撤销，撤销属阶段 5。
    const again = inTx(() => arrive(db, account, at('2026-09-22T20:00:00+08:00')))
    expect(again.created).toBe(false)
    expect(again.day.leftAt).not.toBeNull()
    expect(eventTypes(account).filter((type) => type === CHECKIN_ARRIVED_TYPE)).toHaveLength(1)
  })

  it('跨天后是新的一天，正常写入', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T09:00:00+08:00')))
    const nextDay = inTx(() => arrive(db, account, at('2026-09-23T09:00:00+08:00')))

    expect(nextDay.created).toBe(true)
    expect(readProjection(db, account).days.map((row) => row.dayKey)).toEqual([
      '2026-09-22',
      '2026-09-23',
    ])
  })

  it('事务未开时当场抛错，且一个字都不写（ADR-012 §4 item 1 的兜底）', () => {
    const account = freshAccount()
    expect(() => arrive(db, account, at('2026-09-22T09:00:00+08:00'))).toThrow(/事务/)
    expect(() => leave(db, account, at('2026-09-22T09:00:00+08:00'))).toThrow(/事务/)
    expect(eventTypes(account)).toEqual([SETTINGS_UPDATED_TYPE])
  })
})

describe('今日状态与连续天数（ADR-012 §3 / §6）', () => {
  it('没有到达 → day 为 null（休息日）、streak 为 0', () => {
    const account = freshAccount()
    const state = today(db, account, at('2026-09-22T09:00:00+08:00'))

    expect(state.day).toBeNull()
    expect(state.streak).toBe(0)
  })

  it('今天已打卡 → streak 从今天往回数', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T09:00:00+08:00')))
    inTx(() => arrive(db, account, at('2026-09-21T09:00:00+08:00')))
    inTx(() => arrive(db, account, at('2026-09-20T09:00:00+08:00')))

    const state = today(db, account, at('2026-09-22T20:00:00+08:00'))
    expect(state.day!.dayKey).toBe('2026-09-22')
    expect(state.streak).toBe(3)
  })

  it('今天未打卡但昨天有 → 从昨天数（当天尚未打卡不立即判零）', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-21T09:00:00+08:00')))
    inTx(() => arrive(db, account, at('2026-09-20T09:00:00+08:00')))

    const state = today(db, account, at('2026-09-22T09:00:00+08:00'))
    expect(state.day).toBeNull()
    expect(state.streak).toBe(2)
  })

  it('昨天也没有 → 0（宽容式：断几天不毁掉全部，但断了就是 0）', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-19T09:00:00+08:00')))

    expect(today(db, account, at('2026-09-22T09:00:00+08:00')).streak).toBe(0)
  })

  it('今日状态用**今日归属日**，凌晨看的是前一天（与到达同一把尺）', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T23:00:00+08:00')))

    // 次日凌晨 02:00：归属日仍是 09-22，因此「今天」已打卡
    const state = today(db, account, at('2026-09-23T02:00:00+08:00'))
    expect(state.day!.dayKey).toBe('2026-09-22')
    expect(state.streak).toBe(1)
  })
})

describe('范围查询（ADR-012 §3）', () => {
  it('闭区间、升序、只含本账号', () => {
    const account = freshAccount()
    const other = freshAccount()
    for (const day of ['2026-09-20', '2026-09-22', '2026-09-24']) {
      inTx(() => arrive(db, account, at(`${day}T09:00:00+08:00`)))
      inTx(() => arrive(db, other, at(`${day}T09:00:00+08:00`)))
    }

    expect(listDays(db, account, '2026-09-20', '2026-09-23').map((row) => row.dayKey)).toEqual([
      '2026-09-20',
      '2026-09-22',
    ])
    expect(listDays(db, account, '2026-09-21', '2026-09-21')).toEqual([])
    expect(listDays(db, other, '2026-09-20', '2026-09-24')).toHaveLength(3)
  })
})

describe('表 = 重放：服务只经事件层写投影（ADR-012 §4 item 2）', () => {
  it('到达与离开之后，投影表的 days 与重放结果逐字段一致', () => {
    const account = freshAccount()
    inTx(() => arrive(db, account, at('2026-09-22T23:00:00+08:00')))
    inTx(() => leave(db, account, at('2026-09-23T05:00:00+08:00')))
    inTx(() => arrive(db, account, at('2026-09-24T09:00:00+08:00')))

    const incremental = readProjection(db, account)
    expect(incremental.days).toEqual(project(readAccountEvents(db, account)).days)

    rebuildProjection(db, account)
    expect(readProjection(db, account)).toEqual(incremental)
  })
})

/**
 * ★ 四列自洽：`occurred_at` 的偏移取自**账号时区**，不是进程时区（ADR-010 §1）。
 *
 * 这是阶段 3 独立验证的整改项。被证伪的形态是：
 *
 * ```
 * 账号设置 UTC、dayStartHour=4，进程 TZ = UTC+14 时写入：
 *   occurred_at = "2026-10-10T16:00:00+14:00"   ← 偏移来自进程
 *   timezone    = "UTC"                          ← 来自账号设置
 *   day_key     = "2026-10-09"
 * 绝对时刻没错、day_key 也没错，但两列互相解释不通：
 * 审计者不知道写入瞬间的进程 TZ（这一项根本没被记录），无法仅凭事件行复算 day_key。
 * ```
 *
 * 修法之后，**仅凭事件行**（`occurred_at` + `timezone` + `day_start_hour`）
 * 就能复算出同一 `day_key`——这正是 ADR-001 §4 给这几列的可解释性。
 * 期望值是**硬编码的已知偏移**，不拿被测代码反算，避免自证。
 */
describe('★ occurred_at 的偏移取自账号时区（ADR-010 §1）', () => {
  /**
   * 挑一个**与进程时区偏移不同**的账号时区（外加它在该瞬间的已知偏移）。
   * 本组用例的意义全在「两者不同」，而进程时区随机器而变——
   * 候选里必有一个与进程不同（三个候选的偏移两两不同），故用例在任何机器上都不空转。
   */
  function zoneDifferingFromProcess(instant: Date): { zone: string; offset: string } {
    const processMinutes = -instant.getTimezoneOffset() // 东为正
    const candidates = [
      { zone: 'UTC', offset: '+00:00', minutes: 0 },
      { zone: 'Asia/Kathmandu', offset: '+05:45', minutes: 345 },
      { zone: 'America/New_York', offset: '-04:00', minutes: -240 }, // 2026-10-10 为 EDT
    ]
    const picked = candidates.find((candidate) => candidate.minutes !== processMinutes)
    if (picked === undefined) throw new Error('三个候选时区都与进程时区同偏移，本用例无法成立')
    return { zone: picked.zone, offset: picked.offset }
  }

  it('★ 账号时区 ≠ 进程时区：四列自洽，仅凭事件行即可复算 day_key', () => {
    const instant = at('2026-10-10T06:00:00Z')
    const { zone, offset } = zoneDifferingFromProcess(instant)
    const account = freshAccount(4, zone)

    const result = inTx(() => arrive(db, account, instant))
    const event = arrivalEvent(account)

    // ① 偏移取自账号时区（硬编码期望：UTC → +00:00）
    expect(result.day.arrivedAt.endsWith(offset)).toBe(true)
    expect(event.occurredAt).toBe(result.day.arrivedAt)

    // ② 进程时区确实与账号时区不同 —— 这一条保证本用例不是空转。
    //    修复前 event.occurredAt 走的就是 toIso（进程时区），这里会当场失败。
    expect(toIso(instant)).not.toBe(event.occurredAt)

    // ③ 四列自洽 + 仅凭事件行复算 day_key 得同一值（ADR-001 §4 的可解释性）
    expect(event.timezone).toBe(zone)
    expect(event.dayStartHour).toBe(4)
    expect(
      toDayKey(new Date(event.occurredAt), {
        timeZone: event.timezone,
        dayStartHour: event.dayStartHour,
      }),
    ).toBe(event.dayKey)

    // ④ 绝对时刻分毫未变（改的只是渲染偏移）
    expect(Date.parse(event.occurredAt)).toBe(instant.getTime())
  })

  it('★ 偏移是**该瞬间**的偏移而不是常量：跨 DST 的两个瞬间各按当季偏移渲染', () => {
    // 2026 年美国夏令时于 11-01 结束：10-30 是 EDT(-04:00)，11-05 是 EST(-05:00)
    const summer = at('2026-10-30T12:00:00Z')
    const winter = at('2026-11-05T12:00:00Z')
    const account = freshAccount(0, 'America/New_York')

    const first = inTx(() => arrive(db, account, summer))
    const second = inTx(() => arrive(db, account, winter))

    expect(first.day.arrivedAt.endsWith('-04:00')).toBe(true)
    expect(second.day.arrivedAt.endsWith('-05:00')).toBe(true)

    // 两行各自都可复算（常量偏移的写法会在其中一行上算错）
    for (const event of readAccountEvents(db, account).filter(
      (row) => row.type === CHECKIN_ARRIVED_TYPE,
    )) {
      expect(
        toDayKey(new Date(event.occurredAt), {
          timeZone: event.timezone,
          dayStartHour: event.dayStartHour,
        }),
      ).toBe(event.dayKey)
    }
  })

  it('离开事件的两列同样同源（day_key 继承自到达，`occurred_at` / `timezone` 仍按账号时区）', () => {
    const instant = at('2026-10-10T06:00:00Z')
    const { zone, offset } = zoneDifferingFromProcess(instant)
    const account = freshAccount(4, zone)

    inTx(() => arrive(db, account, at('2026-10-10T05:00:00Z')))
    const closed = inTx(() => leave(db, account, instant))
    const left = readAccountEvents(db, account).find((event) => event.type === CHECKIN_LEFT_TYPE)!

    expect(left.timezone).toBe(zone)
    expect(left.occurredAt.endsWith(offset)).toBe(true)
    expect(Date.parse(left.occurredAt)).toBe(instant.getTime())
    // 唯一一处**不能**用 occurred_at 复算 day_key 的地方（ADR-012 §5 的收窄）：
    // 离开的归属日继承自它所配对的到达，而不是它自己时刻的折算结果。
    expect(left.dayKey).toBe(closed.day.dayKey)
    expect(left.dayKey).toBe(
      readAccountEvents(db, account).find((event) => event.type === CHECKIN_ARRIVED_TYPE)!.dayKey,
    )
  })
})
