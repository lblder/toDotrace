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
 * **模板、设置、打卡日（`days`）一视同仁**：三者都是投影，都只由事件重放得出，
 * 于是这里一并清空并从事件重建（ADR-010 §5/§6/§7、ADR-012 §2/§4）。
 * 某个键「重建后消失」的成因各自不同，但性质一样——**事件集合里没有它的事实**：
 *
 * - `settings`：没有 `settings/updated`（该批次被撤销、或被覆盖导入的锚点划到线外；
 *   存量账号的「压根没有这条事件」已由启动时的数据迁移补掉，见 `data-migration.ts`），
 *   重建后设置行消失，读取回落默认值；
 * - `days`：到达不在取值范围内，那几天重建后就是「没有到达」——
 *   **按 ADR-012 §5 的语义，那正是休息日**，界面文案「今天偷偷懒」，
 *   不计入打卡天数（ADR-002 §3 的 `COUNT(*)` 同样不需要额外条件）。
 *
 * 这两种「消失」都是可解释的取值，不是静默失真；反过来，把没有事件依据的行
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
