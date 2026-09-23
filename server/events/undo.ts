import type { Db } from '../db/connection.js'
import { toIsoInZone, today as accountToday } from '@shared/time'
import { appendEvents } from './append.js'
import { REVOKE_TYPE } from './definitions/system.js'
import { readAccountEvents, readRevokedBatchIds } from './event-store.js'
import { loadAccountSettings, timeContextOf } from './settings.js'
import { assertInTransaction } from './transaction.js'
import { batchNotRevocable, notFound } from '../lib/errors.js'

/**
 * 撤销入口（ADR-017 §8；机制见 ADR-006）。
 *
 * ## 为什么它在阶段 4 就位（§8 的论证，照抄结论）
 *
 * ADR-013 §4.8 定「删除是软删除，撤销删除 = 撤销该批次」，**不设 `task/restored`**；
 * 而「30 秒撤销」原本排在阶段 5。两条合读的后果是：**阶段 4 的删除是删了就没了**——
 * 用户裁决要的「支持删除任务」会变成一个没有退路的危险动作，而任务删除是**唯一**一个
 * 把东西移出所有视图的操作。机制成本近乎为零：`system/revoke` 与其在 `project()` 里的
 * 跳过语义阶段 2 已实现并有测试，本文件补的就是那个**用户动作**。
 *
 * ## 四条约束（§8）
 *
 * 1. **只能撤销本账号的批次**：跨账号 `404`（不泄露存在性）。「不存在」与「属于他人」
 *    在数据上**完全同形**（批次只是事件行的列，没有独立的表），区分它们就是泄露——
 *    故两者一律 404，而不是 §2 表格里写的 409 `batch-not-revocable`
 *    （那一格与 §8 及 §后果 的「跨账号撤销 → 404」相冲突，实现按 §8 与测试矩阵走）；
 * 2. **撤销一个 `system/revoke` 批次被拒**（`conflict/batch-not-revocable`，409）——
 *    「撤销撤销」的语义是「让它复活」，而 ADR-006 未定义它，**不允许凭直觉实现**；
 * 3. **重复撤销同一个批次是幂等**（ADR-006 的约束：「一个批次只能被撤销一次，
 *    重复撤销为无操作」）：本次**不写第二条 revoke 事件**，如实返回既有状态
 *    （`revoked: true`）——再写一条的效果完全一样（`project()` 收的是**集合**），
 *    但流水里会留下一次并不存在的「第二次撤销」；
 * 4. **不做 30 秒窗口的服务端强制**（FR3：30 秒是**界面提示时长**，不是服务端能力边界）：
 *    服务端可撤销任何批次，窗口是界面的事。
 *
 * ## 撤销会移动折叠边界 → 触发全量重建
 *
 * `system/revoke` 是边界事件（`isBoundaryEventType`），`appendEvents` 因此走
 * `rebuildProjection`——这是既有行为（ADR-010 §5 已把「撤销后重建」列为用途之一），
 * 本文件不改变它，也不额外调用重建。
 */
export function undoBatch(
  db: Db,
  accountId: string,
  now: Date,
  batchId: string,
): { batchId: string; revoked: true } {
  assertInTransaction(db, '撤销批次')

  const events = readAccountEvents(db, accountId)
  const batch = events.filter((event) => event.batchId === batchId)
  if (batch.length === 0) {
    // 不存在 / 属于其它账号：**同一个响应**（见文件头第 1 条）。
    throw notFound(`批次不存在（${batchId}）`)
  }
  if (batch.some((event) => event.type === REVOKE_TYPE)) {
    throw batchNotRevocable(
      '不能撤销一个「撤销」批次：「撤销撤销」的语义是让它复活，' +
        '而 ADR-006 未定义它——恢复被撤销的批次请重新执行那个动作或走覆盖导入。',
    )
  }
  if (readRevokedBatchIds(db, accountId).has(batchId)) {
    // 幂等（见文件头第 3 条）：不写第二条 revoke。
    return { batchId, revoked: true }
  }

  const settings = loadAccountSettings(db, accountId)
  appendEvents(db, accountId, [
    {
      type: REVOKE_TYPE,
      occurredAt: toIsoInZone(now, settings.timeZone),
      payload: { targetBatchId: batchId },
      dayKey: accountToday(timeContextOf(settings), now),
      dayStartHour: settings.dayStartHour,
    },
  ])

  return { batchId, revoked: true }
}
