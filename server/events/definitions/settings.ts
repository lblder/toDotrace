import { z } from 'zod'
import { defineEvent, type EventDefinition, type RegisteredDefinition } from '../types.js'

/**
 * `settings/updated`（ADR-010 §6 / §7）——阶段 2 登记项。
 *
 * ADR-010 §6 把 `settings` 列为投影表之后，它是这张表**唯一**的写入方：
 * 「任何模块不得直接写投影表——只能经由事件追加」（§约束）与
 * 「违反约束直接 UPDATE settings 是错误路径」（§7）两条合起来，只留下这一条合法路径。
 *
 * | 载荷 | 施加到投影 |
 * |---|---|
 * | `{ timeZone, dayStartHour }`（**更新后的整行**，非差量） | `projection.settings = { … }` |
 *
 * 三条口径与 `definitions/recurrence.ts` 完全一致：
 *
 * 1. **载荷是整行而非差量**：差量只有在「初始化事件一定先于它」时才拼得出完整设置，
 *    而事件集合可能因撤销、合并导入而缺前半截；
 * 2. **账号标识不重复放进载荷**：事件表已有 `account_id`，`apply` 取 `event.accountId`；
 * 3. **`updatedAt` 取自 `occurred_at`**：与模板的 `createdAt` / `updatedAt` 同一口径。
 *
 * 生效范围（ADR-010 §6）：设置只影响**此后写入**的事件；历史事件的
 * `timezone` / `day_key` / `day_start_hour` 已固化，永不重算。
 */

export const SETTINGS_UPDATED_TYPE = 'settings/updated'

/**
 * IANA 时区名是否可解析。
 *
 * 校验放在事件边界而不是推迟到 `toDayKey()`：时区一旦写进流水就**永久生效**，
 * 而它出错的表现是「之后每一次写入都抛 RangeError」——在账号创建路径上就意味着
 * 一个建得出来却再也写不进任何事件的账号。宁可当场拒绝这条事件。
 */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const settingsUpdatedPayloadSchema = z
  .object({
    /** IANA 时区名 */
    timeZone: z.string().refine(isIanaTimeZone, '必须是可解析的 IANA 时区名'),
    /** 0–23；与 `settings.day_start_hour` 同域 */
    dayStartHour: z.number().int().min(0).max(23),
  })
  .strict()

export type SettingsUpdatedPayload = z.infer<typeof settingsUpdatedPayloadSchema>

export const settingsUpdatedDefinition: EventDefinition<SettingsUpdatedPayload> = defineEvent({
  type: SETTINGS_UPDATED_TYPE,
  schema: settingsUpdatedPayloadSchema,
  apply(projection, event) {
    // 整行覆盖：折叠按事件 id 升序，最后一条 settings/updated 胜出。
    projection.settings = {
      accountId: event.accountId,
      timeZone: event.payload.timeZone,
      dayStartHour: event.payload.dayStartHour,
      updatedAt: event.occurredAt,
    }
  },
  // 无 target：设置不针对特定对象，两列为 NULL（ADR-010 §1）。
})

/** 阶段 2 登记的全部设置事件定义 */
export const settingsEventDefinitions: readonly RegisteredDefinition[] = [settingsUpdatedDefinition]
