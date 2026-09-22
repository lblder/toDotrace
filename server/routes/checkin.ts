import { Router, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { compareDayKey, diffDays, isDayKey, type DayKey } from '@shared/time'
import { arrive, leave, listDays, today } from '../checkin/service.js'
import type { Db } from '../db/connection.js'
import { invalidInput } from '../lib/errors.js'
import { parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'

/**
 * 打卡（ADR-012 §3）。四条路由，**全部需鉴权**，响应体一律只含当前账号的数据。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | POST | `/api/checkin/arrive` | `{ day: DayRow, created: boolean }` |
 * | POST | `/api/checkin/leave`  | `{ day: DayRow, created: boolean }` |
 * | GET  | `/api/checkin/today`  | `{ day: DayRow \| null, streak: number }` |
 * | GET  | `/api/checkin/days?from=&to=` | `{ days: DayRow[] }`（**升序**） |
 *
 * ## 接线（ADR-012 §4，本阶段最大风险点）
 *
 * 打卡是**第一个从路由层调用 `appendEvents` 的功能**，故三条纪律写在这里：
 *
 * 1. **路由层开事务**（ADR-002 §1 / ADR-012 §4）：一次打卡 = 一个批次 = 一个事务，
 *    事件与 `days` 投影同事务提交。两个 POST 都是 `db.transaction(...)()`；
 *    §4 说「实现侧已由 `appendEvents` 的 `assertInTransaction` 结构性强制」——
 *    那是**兜底**，不是理由：事务在这里开，是因为请求的边界在这里；
 * 2. **投影不在这里写**：本文件与 `checkin/service.ts` 都不含任何 SQL 写语句，
 *    投影更新只发生在 `appendEvents` 内部（ADR-010 §约束）。
 *    `server/tests/events-discipline.test.ts` 扫源码核对这一点（`days` 已纳入）；
 * 3. **时刻由服务端取 `now`**：两个 POST 都**不接受请求体**（§3）——
 *    允许客户端传时刻等于开放「补记任意历史打卡」，而 FR1 未要求该能力。
 *
 * 归属日与配对的规则在 `checkin/service.ts`（§5），本文件只做参数契约。
 */

/** `/days` 的跨度上限（ADR-012 §3）：366 天，**两端都算**（闰年整年正好 366 天）。 */
export const MAX_RANGE_DAYS = 366

/**
 * 查询参数契约（ADR-012 §3）：`from` / `to` **均必填**，且只有这两个字段。
 *
 * `strict()` 的理由与请求体一致（ADR-008 §8「多给字段即 400」）：静默忽略多余字段
 * 会让调用方依赖上并不存在的契约。这里额外挡住 `?from=a&from=b` 这类重复键
 * （Express 会给出数组，`z.string()` 直接拒绝，**不会**落到 `isDayKey` 里）。
 */
const dayRangeSchema = z.object({ from: z.string(), to: z.string() }).strict()

/**
 * 解析并校验 `/days` 的区间。
 *
 * ⚠️ **非法 dayKey 必须在这里被挡住，不得透传给域层**（ADR-012 §3）：
 * ADR-009 §7 规定 `makeDayKey` 对**不存在的日历日**（`2026-02-30`、`2026-13-01`…）
 * 抛 `RangeError`，透传会落到 ADR-008 的错误信封之外（未处理异常 → 500）。
 * 把关用 `shared/time` 的 `isDayKey`——它按**真实日历**判定（含闰年 2 月 29 日），
 * 不是正则匹配。
 */
export function parseDayRange(query: unknown): { from: DayKey; to: DayKey } {
  const input = parseInput(dayRangeSchema, query)
  if (!isDayKey(input.from)) {
    throw invalidInput(`from 不是合法的日期（应为 YYYY-MM-DD 的真实日历日），实得 '${input.from}'`)
  }
  if (!isDayKey(input.to)) {
    throw invalidInput(`to 不是合法的日期（应为 YYYY-MM-DD 的真实日历日），实得 '${input.to}'`)
  }
  if (compareDayKey(input.from, input.to) > 0) {
    // 不返回空数组（ADR-012 §3）：静默返回空会让调用方以为「那段时间没打卡」。
    throw invalidInput(`from（${input.from}）不能晚于 to（${input.to}）`)
  }
  if (diffDays(input.from, input.to) + 1 > MAX_RANGE_DAYS) {
    throw invalidInput(`单次查询跨度最多 ${MAX_RANGE_DAYS} 天（含两端），请分次查询`)
  }
  return { from: input.from, to: input.to }
}

/**
 * 两个 POST 都不接受请求体（ADR-012 §3）。空对象通过、多一个字段即 400——
 * `zod.strict()` 是 ADR-008 §8 给请求体定的形态，与「无 body 也能成功」并不冲突：
 * 不带 body 时 Express 给出 `undefined`，`?? {}` 让它与 `{}` 同解。
 */
const emptyBodySchema = z.object({}).strict()

function assertNoBody(req: Request): void {
  parseInput(emptyBodySchema, req.body ?? {})
}

export function checkinRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()

  router.use(requireAuth)

  router.post('/arrive', (req, res) => {
    assertNoBody(req)
    const accountId = getAuth(req).user.id
    // 一次打卡 = 一个批次 = 一个事务（ADR-012 §4）。`new Date()` 只在这里取一次：
    // 同一事务内的投影读写与事件时刻都基于它，不会出现「读的是一个时刻、写的是另一个」。
    const result = db.transaction(() => arrive(db, accountId, new Date()))()
    res.status(200).json(result)
  })

  router.post('/leave', (req, res) => {
    assertNoBody(req)
    const accountId = getAuth(req).user.id
    const result = db.transaction(() => leave(db, accountId, new Date()))()
    res.status(200).json(result)
  })

  router.get('/today', (req, res) => {
    const accountId = getAuth(req).user.id
    res.json(today(db, accountId, new Date()))
  })

  router.get('/days', (req, res) => {
    const accountId = getAuth(req).user.id
    const { from, to } = parseDayRange(req.query)
    res.json({ days: listDays(db, accountId, from, to) })
  })

  return router
}
