import type { Db } from '../db/connection.js'
import { DEFAULT_DAY_START_HOUR, type TimeContext } from '@shared/time'
import { SETTINGS_UPDATED_TYPE, type SettingsUpdatedPayload } from './definitions/settings.js'
import { readSettingsRow } from './projection-store.js'
import type { AccountSettings, EventDraft } from './types.js'

export type { AccountSettings }

/**
 * 账号设置（ADR-010 §6）：`events` 的 `timezone` / `day_key` / `day_start_hour`
 * 三个字段的**取值来源**。`appendEvents` 在写入时按它折算并固化，
 * 此后任何读取路径不得重算（ADR-001 §4）。
 *
 * **变更语义**（ADR-010 §6）：时区与 `dayStartHour` 的修改**只影响此后写入的事件**，
 * 历史事件的 `day_key` / `timezone` 已固化、永不重算。
 *
 * ## 设置是投影，唯一来源是 `settings/updated` 事件
 *
 * 本模块**只读不写**：写入路径唯一地是「追加 `settings/updated` 事件 →
 * `apply` 改内存投影 → `projection-store` 落表」（ADR-010 §6/§7）。
 * §约束 禁止任何模块直接写投影表，§7 更明文把「违反约束直接 UPDATE settings」
 * 列为错误路径——两者合起来只留下上面那一条。
 *
 * 因此读取分两种情形，且**都不写库**：
 *   - 库里有行 → 用行里的值。它由事件重放得出，因此可丢弃、可重建（ADR-002 §2）；
 *   - 库里没有行 → 服务端本地时区 + `DEFAULT_DAY_START_HOUR`。
 *     读事件的动作不该顺手在投影表里插一行——那是事件追加的职责。
 *
 * ## 「缺行回落」是**兜底**，不是正式路径
 *
 * 正式路径有两条，都在写入侧，**都不依赖读取瞬间**：
 *
 * 1. **账号创建**：`POST /api/setup/owner` / `POST /api/auth/register` 在创建账号的
 *    同一个事务里写下初始化事件（`initialSettingsDraft`）；
 * 2. **启动时的数据迁移**（ADR-010 §7）：`backfillAccountSettings` 为**存量账号**
 *    （模式迁移到 v2 之前就存在、因而没有 `settings/updated` 事件的账号）补写一条，
 *    时区取**数据迁移执行时**的服务端本地时区。
 *
 * 上一版注释在这里写过一段「缺行就该回落默认值」的论证，那是**与 ADR-010 §7 相反**的做法，
 * 而且它讲得通——两份互相论证的真相，比缺实现更坏。已被验证者当场证伪（真机实测：
 * 预置老账号 → 启动 → 事件表仍为空、设置行仍为空；`TZ` 一换，读出来的时区跟着变）。
 * 读时取值与漂移，正是 §7 点名禁止的两件事。
 *
 * 兜底保留，但它的定位是**防御性**的：正常路径下，任何账号在启动之后都该有设置事实。
 * 缺行如今只剩三种成因，且都不该被这里「就地修好」：
 *   - 该账号的初始化事件所在批次被撤销（ADR-006：撤销只跳过，读取回落即可）；
 *   - 该事件被覆盖导入的锚点划到线外（ADR-004 的覆盖面语义，见 `events-project.test.ts`）；
 *   - 调用方压根没跑启动流程（直连库的测试与脚本）。
 */

/**
 * 服务端本地时区——「首次创建账号时取服务端本地时区」（ADR-010 §6）的取值来源。
 *
 * 取不到时回落 `'UTC'` 而不是抛错：运行在缺少 tz 数据的容器里时，
 * 抛错会让**整个服务**起不来，而时区只是可改的设置项。
 */
export function serverTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC'
}

/** 读账号设置。缺行时返回默认值而不写库（见文件头）。 */
export function loadAccountSettings(db: Db, accountId: string): AccountSettings {
  const row = readSettingsRow(db, accountId)
  if (row !== null) return row
  return {
    accountId,
    timeZone: serverTimeZone(),
    dayStartHour: DEFAULT_DAY_START_HOUR,
    // 没有行就没有「最后写入时刻」。空串是诚实的取值——填 now 会伪造出一条不存在的设置事实。
    updatedAt: '',
  }
}

/**
 * 账号创建路径要写的那条**初始化事件**（`POST /api/setup/owner`、`POST /api/auth/register`）。
 *
 * 取值即 ADR-010 §6 的「首次创建账号时取服务端本地时区」+ `DEFAULT_DAY_START_HOUR`。
 * 放在这里而不是让两个创建路径各自拼载荷：**这条事件的形状是一处契约**，
 * 各写一遍就是两个真相（何况其中一处迟早会忘记 `occurredAt` 要带时区偏移）。
 */
export function initialSettingsDraft(occurredAt: string): EventDraft<SettingsUpdatedPayload> {
  return {
    type: SETTINGS_UPDATED_TYPE,
    occurredAt,
    payload: { timeZone: serverTimeZone(), dayStartHour: DEFAULT_DAY_START_HOUR },
  }
}

/** 设置 → `shared/time` 的时间上下文（`toDayKey` 的入参） */
export function timeContextOf(settings: AccountSettings): TimeContext {
  return { timeZone: settings.timeZone, dayStartHour: settings.dayStartHour }
}
