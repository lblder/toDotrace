import { compareDayKey, toDayKey, type DayKey } from '@shared/time'
import { currentStreak } from '@shared/checkin'
import type { Db } from '../db/connection.js'
import { appendEvents } from '../events/append.js'
import { CHECKIN_ARRIVED_TYPE, CHECKIN_LEFT_TYPE } from '../events/definitions/checkin.js'
import { readProjection } from '../events/projection-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import type { ProjectedDay } from '../events/types.js'
import { notArrived } from '../lib/errors.js'
import { toIso } from '../lib/time.js'

/**
 * 打卡的域逻辑（ADR-012 §3 / §5）。
 *
 * ## 本模块的纪律（ADR-012 §4）
 *
 * 1. **不开事务**：ADR-002 §1 规定「事务由服务端在请求处理层开启」，
 *    ADR-012 §4 把它钉成「一次打卡 = 一个批次 = 一个事务」。事务由路由层开
 *    （`routes/checkin.ts`），本模块只**断言**自己处在事务内——
 *    绕开路由直接调用会在 `appendEvents` 之前就抛错，而不是留下半条数据；
 * 2. **不写投影表**：本模块只读投影（`readProjection`），写入一律经由
 *    `appendEvents` → `EventDefinition.apply` → `projection-store`（ADR-010 §约束）；
 * 3. **不读系统时钟**：`now` 一律由调用方传入（与 `shared/time` 同一纪律，
 *    ADR-009「理由」），使「凌晨到达归前一天」「跨零点的离开」可被确定性地测试。
 *
 * ## 归属日（ADR-012 §5）
 *
 * - **到达**：`toDayKey(occurred_at, ctx)`——「凌晨到达归前一天」是它的既有行为，
 *   本模块不新增任何折算；
 * - **离开**：**记在所配对的那次到达的归属日上**（§5 对 ADR-001 §4 的收窄）。
 *   于是 `dayKey` 与 `dayStartHour` 这一对在离开事件上必须**显式给出**——
 *   它们不是从 `occurred_at` 折出来的。见 `leave()` 的注释。
 *
 * ## 离开的分流键是「有无到达」（ADR-012 §5 的裁决）
 *
 * **不是**「有无未闭合的到达」——后者把「已经离开过（重试/重复点击）」与
 * 「从没到达过」混成同一个状态，在投影上无从区分。两者现在分开：
 * 从无到达才是 409，有过到达但已闭合是幂等。见 `leave()` 的分流表。
 */

/** 对外的打卡日形态（ADR-012 §3 的 `DayRow`）：**只有这三个字段**，不带账号标识。 */
export interface DayRow {
  dayKey: DayKey
  arrivedAt: string
  /** `null` = 尚未离开（时长未知，FR1） */
  leftAt: string | null
}

export interface CheckinResult {
  day: DayRow
  /** `false` = 今天（或这次离开）已经记过，本次没有写入新事件（ADR-012 §3 的幂等语义） */
  created: boolean
}

/** 今日状态（ADR-012 §5：休息日就是 `day: null`，不另设 `isRestDay` 字段）。 */
export interface TodayResult {
  day: DayRow | null
  streak: number
}

/** 一次到达（ADR-012 §3 的 `POST /api/checkin/arrive`）。**调用方必须已在事务内。** */
export function arrive(db: Db, accountId: string, now: Date): CheckinResult {
  assertInTransaction(db, '打卡（到达）')

  const settings = loadAccountSettings(db, accountId)
  const dayKey = toDayKey(now, timeContextOf(settings))

  // 幂等判据**读当前投影**，不扫事件流水（ADR-012 §3：判据一律读当前投影）。
  // 已有的行 = 今天已经到达过（§2 保证行必有到达），此时一个字都不写。
  const existing = findDay(db, accountId, dayKey)
  if (existing !== null) {
    return { day: toDayRow(existing), created: false }
  }

  const occurredAt = toIso(now)
  appendEvents(db, accountId, [
    {
      type: CHECKIN_ARRIVED_TYPE,
      occurredAt,
      payload: {},
      // 归属日与折算设置**显式成对给出**：它们就是上面那次折算的结果，
      // 由事件层再折一次等于允许两条路径产出不同的日（ADR-012 §5 的收窄只在离开上
      // 把「输入」换了，不变式仍是「写入时确定、此后永不重算」）。
      dayKey,
      dayStartHour: settings.dayStartHour,
    },
  ])

  const written = findDay(db, accountId, dayKey)
  if (written === null) throw projectionMissing(dayKey)
  return { day: toDayRow(written), created: true }
}

/**
 * 一次离开（ADR-012 §3 的 `POST /api/checkin/leave`）。**调用方必须已在事务内。**
 *
 * ## 分流表（ADR-012 §5 的裁决，v1.2）
 *
 * 取「最近一条**有到达**的 `days` 行」（按 `day_key` 降序）后按该行状态分流：
 *
 * | 该行状态 | 行为 |
 * |---|---|
 * | **不存在**（账户从无到达） | `409 conflict/not-arrived` |
 * | `left_at` 为空 | **闭合它**，`created: true` |
 * | `left_at` 非空 | **幂等返回该行**，`created: false` |
 *
 * **分流键是「有无到达」，不是「有无未闭合的到达」**：后者无法区分
 * 「已经离开过（网络重试 / 重复点击）」与「从没到达过」——在投影上它们是同一个状态，
 * 于是幂等与 409 不能并存。改键之后两者同时成立，且判据**仍是纯投影**（不扫事件流水）。
 * 这个坑曾经真实存在于 ADR 里，留痕见 `checkin-service.test.ts` 的 ⚠️ 注释。
 *
 * ## 归属日（§5 对 ADR-001 §4 的收窄）
 *
 * 离开事件的 `day_key` **不是**它自己的 `occurred_at` 折算出来的，而是**所配对的那次
 * 到达的**归属日；`§5` 给的反例就是本规则的存在理由（`dayStartHour = 4`）：
 * 到达 23:00（归属日 D）→ 通宵 → 离开 05:00。若按自己的 `occurred_at` 折算，
 * 05:00 ≥ 04:00 会得到 D+1，而 D+1 没有到达 ⇒ 409，**这次离开永远记不上**；
 * 而 23:00 → 05:00 明明是一次 6 小时的到访。记在 D 行上，`leftAt - arrivedAt = 6h` 直接成立。
 */
export function leave(db: Db, accountId: string, now: Date): CheckinResult {
  assertInTransaction(db, '打卡（离开）')

  const latest = findLatestArrival(db, accountId)
  if (latest === null) {
    // 账户从无到达：没有可配对的到达，也就无从知道这次离开该记在哪一天（§5）。
    // ADR-012 §3 的失败路径表与 §5 都规定这个码是 409 conflict/not-arrived。
    throw notArrived()
  }
  if (latest.leftAt !== null) {
    // 该行已闭合：这是重复点击或网络重试，**不写第二条离开事件**，如实返回既有状态
    // （§3 的幂等语义）。注意 §5 的分流表确实就是「看最近那条」，不去找更早的未闭合行——
    // 本阶段每天至多一次到达，不存在配错会话的情况。
    return { day: toDayRow(latest), created: false }
  }

  const settings = loadAccountSettings(db, accountId)
  appendEvents(db, accountId, [
    {
      type: CHECKIN_LEFT_TYPE,
      occurredAt: toIso(now),
      payload: {},
      // §5：归属日 = **所配对的那次到达的**归属日，不是本事件 occurred_at 的折算结果。
      dayKey: latest.dayKey,
      // ⚠️ `dayKey` 与 `dayStartHour` 必须成对出现（append 的纪律），但**这个
      // `dayStartHour` 不是上面那个 `dayKey` 的折算依据**——它只是**写入时生效的口径存档**
      // （离开的归属继承自配对的到达，不由它折算）。别拿它去反推归属日，那会得出错误结论。
      // 它与每行事件上的同名列同一个含义：使「这天为什么归到这天」可解释（ADR-001 §4）。
      dayStartHour: settings.dayStartHour,
    },
  ])

  const written = findDay(db, accountId, latest.dayKey)
  if (written === null) throw projectionMissing(latest.dayKey)
  return { day: toDayRow(written), created: true }
}

/** 今日状态（ADR-012 §3 的 `GET /api/checkin/today`）。只读，不开事务。 */
export function today(db: Db, accountId: string, now: Date): TodayResult {
  const settings = loadAccountSettings(db, accountId)
  const dayKey = toDayKey(now, timeContextOf(settings))
  const projection = readProjection(db, accountId)

  const day = projection.days.find((row) => row.dayKey === dayKey)
  return {
    day: day === undefined ? null : toDayRow(day),
    // 连续天数由 `shared/checkin` 定义（ADR-012 §6）——**不在服务端另写一份**：
    // §5 明说「shared/checkin 里已有同名函数，两个实现即两个真相」。
    // 入参的 dayKeys 就是投影的打卡日（§6：来源必须是 `SELECT day_key FROM days …`，
    // 而 §2 的结构约束使「有行 ⇔ 有到达」），且已由 canonicalizeProjection 保证升序。
    streak: currentStreak(
      projection.days.map((row) => row.dayKey),
      dayKey,
    ),
  }
}

/**
 * 范围查询（ADR-012 §3 的 `GET /api/checkin/days`，**升序**）。
 *
 * `from > to` 与非法 dayKey 由**路由层**在进入这里之前挡掉（§3 要求 400，
 * 且不得透传给域层）——本函数只接受已校验的区间。
 *
 * 范围过滤在内存里做（不写 SQL）：投影表的读写只归 `projection-store`，
 * 把查询留在那儿、把语义留在这儿，两件事不混在一处；
 * 而 `days` 的规模是「该账号每天至多一行」（ADR-002 §3），十年也就三千余行。
 */
export function listDays(db: Db, accountId: string, from: DayKey, to: DayKey): DayRow[] {
  return readProjection(db, accountId)
    .days.filter(
      (row) => compareDayKey(row.dayKey, from) >= 0 && compareDayKey(row.dayKey, to) <= 0,
    )
    .map(toDayRow)
}

// ─────────────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────────────

function findDay(db: Db, accountId: string, dayKey: DayKey): ProjectedDay | null {
  return readProjection(db, accountId).days.find((row) => row.dayKey === dayKey) ?? null
}

/**
 * 最近一条**有到达**的 `days` 行：`day_key` 最大的那条（ADR-012 §5：「按 `day_key` 降序」）。
 * `null` = 账户从无到达（一行都没有）。
 *
 * 用 `compareDayKey` 显式比较，而不是依赖「投影的 `days` 已升序、取最后一条」：
 * 顺序是别处的实现细节，这条规则是契约本身——不把两者绑在一起。
 *
 * ⚠️ 按 `day_key` 而非 `arrived_at` 的时刻排序，是 §5 明写的（v1.2）：
 * 两者只在**设置被改动过**（后写的到达归到更早的日）或**导入的乱序数据**上分歧，
 * 正常路径同解。契约选了 `day_key` 序，此处照办。
 */
function findLatestArrival(db: Db, accountId: string): ProjectedDay | null {
  let best: ProjectedDay | null = null
  for (const row of readProjection(db, accountId).days) {
    if (best === null || compareDayKey(row.dayKey, best.dayKey) > 0) best = row
  }
  return best
}

function toDayRow(day: ProjectedDay): DayRow {
  // 显式构造而不是展开：返回体只含 ADR-012 §3 列的三个字段，
  // `accountId` 不外泄（响应体「一律只含当前账号的数据」——多一个自己的 id 也无用）。
  return { dayKey: day.dayKey, arrivedAt: day.arrivedAt, leftAt: day.leftAt }
}

/**
 * 事件写进去了、投影却查不到该行——只可能是事件层坏了（投影 = 重放这条不变式被破坏），
 * 不是调用方能造成的，故抛内部错误而不是 4xx。
 */
function projectionMissing(dayKey: DayKey): Error {
  return new Error(
    `打卡事件已写入，但投影里没有 '${dayKey}' 这一行：` +
      '「投影 = 重放结果」这条不变式被破坏了（ADR-010 §4/§5）。',
  )
}
