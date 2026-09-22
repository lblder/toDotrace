import type { Db } from '../db/connection.js'
import { appendEvents } from './append.js'
import { SETTINGS_UPDATED_TYPE } from './definitions/settings.js'
import { initialSettingsDraft } from './settings.js'
import { runInTransaction } from './transaction.js'

/**
 * **启动时的数据迁移**（ADR-010 §7）——与「模式迁移」是两件事，分属两层：
 *
 * | 阶段 | 归属 | 职责 |
 * |---|---|---|
 * | 模式迁移 | `db/schema.ts` | **纯 DDL**，不含领域事实 |
 * | 数据迁移 | 本文件（事件层） | 为缺设置事实的存量账号追加一条 `settings/updated` |
 *
 * ## 为什么必须是数据迁移，而不是「读时回落」
 *
 * 存量账号（模式迁移到 v2 之前就存在的账号）没有任何 `settings/updated` 事件，
 * 于是 `settings` 表里没有它的行。若就此让读取路径每次回落默认值，会同时犯下 ADR-010 §7
 * 明文禁止的两件事：
 *
 * 1. **读时**（而非迁移时）取时区——服务器换一个时区运行，同一个账号的时区就变了；
 * 2. **漂移**——账号设置是投影（§3），而投影必须**可由事件重放得出**（§2）：
 *    一个只在读取瞬间存在、库里查无实据的设置值，重放不出、也解释不了。
 *
 * 「迁移时的服务端本地时区」只有一个时刻说得清，所以它必须**在当时**被写进一条事件，
 * 此后不再重算——与「首次创建账号时取服务端本地时区」（§6）同一口径。
 *
 * ## 幂等
 *
 * 判据是**事件存在性**（`users` 左连接该类型事件，缺者为空），不是投影行是否存在：
 * 重复启动不产生第二条；被覆盖导入划到线外（ADR-004）的账号也不会被反复补写——
 * 那条线是有意的语义，不该由数据迁移去「修」。
 *
 * 兜底仍在（`loadAccountSettings` 缺行回落默认值），但那是**防御性**的：
 * 正常路径下，任何一个账号在启动后都应该有设置事实。
 *
 * @returns 本次补写了事件的账号 id（按 id 升序）；无账号需要补写时为空数组。
 */
export function backfillAccountSettings(db: Db, now: Date = new Date()): string[] {
  const missing = db
    .prepare(
      `SELECT u.id AS id
         FROM users u
         LEFT JOIN events e
           ON e.account_id = u.id AND e.type = ?
        WHERE e.id IS NULL
        ORDER BY u.id`,
    )
    .all(SETTINGS_UPDATED_TYPE) as { id: string }[]

  if (missing.length === 0) return []

  // 只传**时刻**，不自己渲染串：时区取值（迁移时，不是读时）与 occurred_at 的偏移
  // 由 `initialSettingsDraft` 内部一次完成、同源（ADR-010 §1：事件行的偏移必须取自
  // 同一行的 `timezone` 列）。这里负责的是另一半——`now` 只取一次，让所有补写的账号
  // 落在同一个瞬间，否则「为什么这个账号是这个时区」在某些运行方式下解释不通。
  const accountIds = missing.map((row) => row.id)

  // 全部账号一个事务：要么都补上，要么一条不写——不在库里留下「补了一半」的中间态。
  runInTransaction(db, () => {
    for (const accountId of accountIds) {
      appendEvents(db, accountId, [initialSettingsDraft(now)])
    }
  })

  return accountIds
}
