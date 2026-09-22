import { z } from 'zod'
import { defineEvent, type EventDefinition, type Projection, type RegisteredDefinition } from '../types.js'

/**
 * 打卡事件（ADR-012 §1）——阶段 3 登记项。
 *
 * | type | 载荷 | `target` | 施加到投影 |
 * |---|---|---|---|
 * | `checkin/arrived` | `{}`（**空对象**） | 省略 | upsert `days` 行的 `arrived_at` |
 * | `checkin/left` | `{}` | 省略 | upsert `days` 行的 `left_at` |
 *
 * ## 为什么载荷是空对象
 *
 * 语义要素**事件行上已经有了**：`occurred_at`（发生时刻）、`day_key`（固化归属日）、
 * `timezone`。载荷里再放一份就是第二个真相——与 ADR-010 §2 的 `target` 派生式同一思路。
 * 空对象而非 `null`：`zod.strict()` 拒绝多余字段，空对象让「该类型无载荷」这件事**显式**
 * （`null` 只是「没有」，`{}` 是「有一个空的载荷」）。
 *
 * **无 `target`**：打卡不针对特定对象（没有模板那样的标识），两列为 NULL（ADR-010 §1）。
 *
 * ## 不变式：每一行必有到达（ADR-012 §2，本版的关键约束）
 *
 * `days.arrived_at` 是 `NOT NULL`，且**只有 `checkin/arrived` 会建行**——
 * `checkin/left` 对没有行的日子**不建行**（见下）。于是「无行 ⇔ 无到达」恒成立，
 * FR1 的「无到达记录 = 休息日」与 ADR-002 §3 的「打卡天数 = COUNT(*)」都直接成立。
 *
 * 这是 ADR-012 说的「**把不变式做成结构，而不是靠约定**」在本层的落点：
 * §1 删掉每日备注、§5 约束 left 的配对，两条都在事件层收口。
 */

export const CHECKIN_ARRIVED_TYPE = 'checkin/arrived'
export const CHECKIN_LEFT_TYPE = 'checkin/left'

/**
 * 空载荷：`{}` 通过，多一个字段即拒绝。
 *
 * 用 `z.object({}).strict()` 而不是 `z.undefined()` / `z.null()`：
 * 事件的 `payload` 列存的是 JSON，`{}` 是唯一能在「列非空」与「无内容」之间
 * 同时成立的形态（`JSON.stringify(undefined)` 是 `undefined`，写不进 NOT NULL 列）。
 */
export const checkinPayloadSchema = z.object({}).strict()

export type CheckinPayload = z.infer<typeof checkinPayloadSchema>

/**
 * 定位某账号某归属日的投影行。**纯函数**（ADR-010 §4：折叠只吃 (projection, event)）。
 *
 * 线性扫描即可：`days` 的规模是「该账号每天至多一行」（ADR-002 §3），
 * 十年日常使用也就三千余行；而保持简单使 `apply` 不需要维护第二份索引结构
 * ——数组顺序由 `canonicalizeProjection` 统一规范，`apply` 不必操心。
 */
function findDay(projection: Projection, dayKey: string) {
  return projection.days.find((day) => day.dayKey === dayKey)
}

export const checkinArrivedDefinition: EventDefinition<CheckinPayload> = defineEvent({
  type: CHECKIN_ARRIVED_TYPE,
  schema: checkinPayloadSchema,
  apply(projection, event) {
    const existing = findDay(projection, event.dayKey)
    if (existing !== undefined) {
      // 同一归属日再来一条到达：按 id 序折叠，**后者胜**（与所有事件的「后来者覆盖」一致）。
      // `left_at` 一并清空——一次新的到达开启一次新的到访，
      // 留着上一次的离开时刻会得到 `left_at < arrived_at` 这种不可能的行。
      // 正常路径下走不到这里（路由按 ADR-012 §3 幂等：当天已有到达即不写第二条事件），
      // 它服务的是导入与撤销后重打这两种来源。
      existing.arrivedAt = event.occurredAt
      existing.leftAt = null
      return
    }
    projection.days.push({
      accountId: event.accountId,
      dayKey: event.dayKey,
      arrivedAt: event.occurredAt,
      leftAt: null,
    })
  },
  // 无 target：打卡不针对特定对象，两列为 NULL（ADR-010 §1）。
})

export const checkinLeftDefinition: EventDefinition<CheckinPayload> = defineEvent({
  type: CHECKIN_LEFT_TYPE,
  schema: checkinPayloadSchema,
  apply(projection, event) {
    const existing = findDay(projection, event.dayKey)
    if (existing === undefined) {
      // **不建行**：没有到达就没有这一行（ADR-012 §2 的结构约束——
      // `arrived_at NOT NULL` 使「有离开、无到达」的行根本表达不出来）。
      // 一条离开事件落在这里，说明它所配对的到达不在本次折叠的取值范围内：
      // 或所在批次被撤销，或被覆盖导入的锚点划到了线外（ADR-004 / ADR-006）。
      // 那两种情形本来就是「跳过」，此处与之一致；凭空补一行才是伪造事实。
      return
    }
    // 闭合（或再闭合）该行。正常路径下路由保证「只闭合最近一条有到达的行」，
    // 且该行已闭合时重复离开不写第二条事件（ADR-012 §3 的幂等 / §5 的分流表）；
    // 折叠这一层只负责「后来者覆盖」。
    existing.leftAt = event.occurredAt
  },
})

/** 阶段 3 登记的打卡事件定义 */
export const checkinEventDefinitions: readonly RegisteredDefinition[] = [
  checkinArrivedDefinition,
  checkinLeftDefinition,
]
