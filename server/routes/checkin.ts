import { Router, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { compareDayKey, diffDays, isDayKey, type DayKey } from '@shared/time'
import { arrive, leave, listDays, today } from '../checkin/service.js'
import { getNote, putNote } from '../checkin/notes.js'
import type { Db } from '../db/connection.js'
import { invalidInput } from '../lib/errors.js'
import { assertNoBody, parseInput } from '../lib/validate.js'
import { getAuth } from '../middleware/auth.js'

/**
 * 打卡（ADR-012 §3）与每日备注（ADR-017 §1.4）。
 *
 * | 方法 | 路径 | 响应 |
 * |---|---|---|
 * | POST | `/api/checkin/arrive` | `{ day: DayRow, created: boolean }` |
 * | POST | `/api/checkin/leave`  | `{ day: DayRow, created: boolean }` |
 * | GET  | `/api/checkin/today`  | `{ day: DayRow \| null, streak: number }` |
 * | GET  | `/api/checkin/days?from=&to=` | `{ days: DayRow[] }`（**升序**） |
 * | GET  | `/api/checkin/days/:dayKey/note` | `{ dayKey, text }` |
 * | PUT  | `/api/checkin/days/:dayKey/note` | `{ dayKey, text }` |
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
 * 两个 POST 都不接受请求体（ADR-012 §3）——空对象通过、多一个字段即 400，
 * 由 `lib/validate.ts` 的共享 `assertNoBody` 把关（ADR-008 §8 的「多给字段即 400」
 * 在本阶段被 ADR-017 §5 提到最高优先级：`accountId` 只能是**被拒**，不能是**被忽略**）。
 */

/**
 * 每日备注（ADR-017 §1.4，ADR-012 §1 的推迟项）。
 *
 * `text` 的上限取 **20000**：ADR-017 §3 只给任务的 `notes` 定了这个上限
 * （「约 10 页文本；个人备注不会更长」），而每日备注与它同类、只会更短。
 * 这是**一处 ADR 没规定、由实现者补的取值**（已报告）；不设上限的话，
 * 唯一的边界会退化成 `express.json` 的 64kb 请求体上限。
 */
const noteBodySchema = z
  .object({ text: z.string().max(20000, '备注最多 20000 个字符（与任务备注同一上限）') })
  .strict()

/** 路径里的 `dayKey`：非法即 400，**不透传给域层**（ADR-009 §7 的既有口径） */
function dayKeyParam(req: Request): DayKey {
  const value = req.params.dayKey
  if (typeof value !== 'string' || !isDayKey(value)) {
    throw invalidInput(
      `dayKey 必须是真实存在的日历日（零填充定宽 YYYY-MM-DD），实得 '${String(value)}'`,
    )
  }
  return value
}

export function checkinRoutes(db: Db, requireAuth: RequestHandler): Router {
  const router = Router()

  router.use(requireAuth)

  router.post('/arrive', (req, res) => {
    assertNoBody(req.body)
    const accountId = getAuth(req).user.id
    // 一次打卡 = 一个批次 = 一个事务（ADR-012 §4）。`new Date()` 只在这里取一次：
    // 同一事务内的投影读写与事件时刻都基于它，不会出现「读的是一个时刻、写的是另一个」。
    const result = db.transaction(() => arrive(db, accountId, new Date()))()
    res.status(200).json(result)
  })

  router.post('/leave', (req, res) => {
    assertNoBody(req.body)
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

  /**
   * 备注**不依赖到达**（ADR-017 §6 的裁决）：这两条路由不查 `days`、也不建 `days` 行
   * ——「无行 ⇔ 无到达」那条不变式由 `day_notes` 是独立表来保证（ADR-012 §2 不受影响）。
   */
  router.get('/days/:dayKey/note', (req, res) => {
    const accountId = getAuth(req).user.id
    res.json(getNote(db, accountId, dayKeyParam(req)))
  })

  router.put('/days/:dayKey/note', (req, res) => {
    const accountId = getAuth(req).user.id
    const dayKey = dayKeyParam(req)
    const input = parseInput(noteBodySchema, req.body ?? {})
    const result = db.transaction(() => putNote(db, accountId, new Date(), dayKey, input.text))()
    res.status(200).json(result)
  })

  return router
}
