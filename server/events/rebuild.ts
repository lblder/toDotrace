import type { Db } from '../db/connection.js'
import { readAccountEvents } from './event-store.js'
import { canonicalizeProjection, project } from './project.js'
import { clearProjection, writeProjection } from './projection-store.js'
import { runInTransaction } from './transaction.js'

/**
 * 全量重建某账号的投影（ADR-010 §5）：
 *
 * > 清空投影表 → 读全部事件 → `project()` → 写回，**全程一个事务**。
 *
 * 它是 ADR-002 §2 那条「投影必须可丢弃、可重建」的落点——**安全网不能只是理论存在**，
 * 否则「覆盖导入」「清空重置」这些动作就没有兜底。平时不走这里（平时是增量）。
 *
 * **`settings` 同样是「可丢弃、可重建」的**：`settings/updated` 事件登记之后，
 * 账号设置与模板一样由事件重放得出，于是这里一并清空并从事件重建
 * （ADR-010 §6/§7：设置是投影，唯一来源是那条事件）。若某账号的流水里没有
 * `settings/updated`（v2 之前建的老库、或该事件所在批次被撤销），重建后设置行消失，
 * 读取回落默认值——这是可解释的取值，不是静默失真；反过来，把没有事件依据的行
 * 留在表里才是：表内容将不再是投影的函数，`增量 == 全量` 这条不变式也当场失效。
 */
export function rebuildProjection(db: Db, accountId: string): void {
  runInTransaction(db, () => {
    clearProjection(db, accountId)
    const events = readAccountEvents(db, accountId)
    const projection = project(events)
    canonicalizeProjection(projection)
    writeProjection(db, accountId, projection)
  })
}
