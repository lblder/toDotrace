import type { Db } from '../db/connection.js'
import { toIsoInZone, today as accountToday } from '@shared/time'
import type { DayKey } from '@shared/time'
import type { AccountSettings } from '../events/types.js'
import { appendEvents } from '../events/append.js'
import { SETTINGS_UPDATED_TYPE, isIanaTimeZone } from '../events/definitions/settings.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import { invalidInput } from '../lib/errors.js'

/**
 * 账号设置（ADR-017 §1.5 / §7；机制见 ADR-010 §6）。
 *
 * ## `PATCH` 收差量、事件载荷是整行快照——**三处同名纪律的第二处**
 *
 * `settings/updated` 的 schema 里两个字段**都必填且 `.strict()`**
 * （`server/events/definitions/settings.ts`），故一个只改 `dayStartHour` 的请求
 * **不能**直接把 `{ dayStartHour }` 写进事件：本模块先读出当前 `timeZone`、
 * 合成 `{ timeZone, dayStartHour }` 整行、再写。漏掉这一步的后果不是报错，
 * 而是**另一个字段被清空或直接 schema 错**（ADR-017 §7 的原话）。
 * 另两处是任务的 `PATCH`（§4）与项目的 `PATCH`（§1.3 注）。
 *
 * ## `affectsFrom`：让「不追溯历史」对用户可见
 *
 * `GET` / `PATCH` 的响应都回带 `affectsFrom` = 该账号**当前的 `today`**
 * （ADR-017 §7：= 新设置开始生效的归属日）。界面据此显示
 * 「此设置自 9月22日 起生效，此前的记录不会改变」。
 *
 * **为什么不给一个恒为 `false` 的 `affectedExisting` 标志**（§7 的论证，照抄结论）：
 * 常量的响应字段是**死重**——它不携带任何服务端才知道的信息，却会进入契约，
 * 日后想删就是破坏性变更。而 `affectsFrom` 是一个**真实计算结果**
 * （依赖账号的时区与 `dayStartHour`，ADR-009 §3），**服务端才是唯一算得准的一方**。
 *
 * ## 不提供「重算历史」
 *
 * FR1 已裁决不追溯（ADR-001 §4：事件的 `day_key` 写入时固化、永不重算），
 * **提供选项等于把它变成一个可以搞坏数据的开关**（ADR-017 §7）。
 */

/** 设置对外的形态（ADR-017 §1.5 的三个字段 + §7 要求的 `affectsFrom`） */
export interface SettingsView {
  timeZone: string
  dayStartHour: number
  /** 该行最后一次写入时刻；**从未写过设置事件时是空串**（诚实取值，不伪造 now） */
  updatedAt: string
  /** 新设置开始生效的归属日 = 该账号当前的 `today`（ADR-017 §7） */
  affectsFrom: DayKey
}

/** `GET /api/settings`（只读，不开事务） */
export function readSettings(db: Db, accountId: string, now: Date): SettingsView {
  const settings = loadAccountSettings(db, accountId)
  return toView(settings, now)
}

/**
 * `PATCH /api/settings`（ADR-017 §7）。**调用方必须已在事务内。**
 *
 * `affectsFrom` 用**改动之后**的设置算（`toView` 拿的是合并后的那一份）：
 * 「新设置开始生效的归属日」就是它——用旧设置算会得到「旧口径的最后一天」，
 * 与界面要告诉用户的那句话正好差一天。
 */
export function patchSettings(
  db: Db,
  accountId: string,
  now: Date,
  patch: { timeZone?: string; dayStartHour?: number },
): SettingsView {
  assertInTransaction(db, '修改设置')
  const current = loadAccountSettings(db, accountId)
  const merged = {
    timeZone: patch.timeZone ?? current.timeZone,
    dayStartHour: patch.dayStartHour ?? current.dayStartHour,
  }

  // 时区必须是 `Intl` 能解析的名字（ADR-009 §9：**「非法名抛 RangeError」的准确含义是
  // 「Intl 无法解析的名字抛错」，不是「与 IANA 注册表逐字不符就抛」**）。
  // 大小写不规范的合法名（`asia/shanghai`）因此**照常接受**——`isIanaTimeZone` 用的
  // 就是事件层那一个判据（`new Intl.DateTimeFormat(...)`），两处不会分叉。
  if (!isIanaTimeZone(merged.timeZone)) {
    throw invalidInput(
      `时区名无法解析：'${merged.timeZone}'。必须是 ` +
        '`Intl` 认得的名字（如 Asia/Shanghai、UTC、America/New_York）。',
    )
  }
  if (!Number.isInteger(merged.dayStartHour) || merged.dayStartHour < 0 || merged.dayStartHour > 23) {
    throw invalidInput(`dayStartHour 必须是 0–23 的整数，实得 ${String(merged.dayStartHour)}`)
  }

  appendEvents(db, accountId, [
    {
      type: SETTINGS_UPDATED_TYPE,
      occurredAt: toIsoInZone(now, merged.timeZone),
      // **整行快照**：两个字段都必填（见文件头）。
      payload: { timeZone: merged.timeZone, dayStartHour: merged.dayStartHour },
      // ⚠️ **`timezone` 必须显式给出，不能省**：省掉时 `appendEvents` 会从
      // `loadAccountSettings()` 取——那是**改动之前**的时区，于是这一行的
      // `occurred_at`（按新时区渲染）与 `timezone` 列（旧值）互相解释不通，
      // 而 ADR-010 §1 要求的正是「四列自洽且可复算」（阶段 3 独立验证抓过同一个形状）。
      // 这三行是本文件唯一一处「多给的参数」，给的是同一份固化事实的另一半。
      timezone: merged.timeZone,
      dayKey: accountToday({ timeZone: merged.timeZone, dayStartHour: merged.dayStartHour }, now),
      dayStartHour: merged.dayStartHour,
    },
  ])

  return toView(loadAccountSettings(db, accountId), now)
}

function toView(settings: AccountSettings, now: Date): SettingsView {
  return {
    timeZone: settings.timeZone,
    dayStartHour: settings.dayStartHour,
    updatedAt: settings.updatedAt,
    affectsFrom: accountToday(timeContextOf(settings), now),
  }
}
