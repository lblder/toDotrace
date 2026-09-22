import { z } from 'zod'
import { isUuidV7 } from '../../lib/uuid.js'
import { defineEvent, type EventDefinition, type RegisteredDefinition } from '../types.js'

/**
 * 两类**系统事件**（ADR-010 §7）：不由用户动作产生，而是机制自身的边界标记。
 *
 *   | type                      | 产生方            | 作用                       |
 *   |---------------------------|-------------------|----------------------------|
 *   | `system/overwrite-anchor` | 覆盖导入（阶段 5）| 覆盖面：其之前的全部事件不参与折叠 |
 *   | `system/revoke`           | 用户撤销（阶段 5）| 被撤销批次内的事件不参与折叠 |
 *
 * **两者的 `apply` 都是空操作**（ADR-010 §7 明文要求）：它们不写任何投影表，
 * 只参与 `project()` 第 1 步的边界扫描与第 3 步的跳过。
 * 若不登记，§2 的「未登记 type 一律拒绝写入」与 §4 的「project 对它们有定义」会互相打死。
 *
 * 阶段 2 **只实现它们在 `project()` 中的语义**，不实现产生它们的用户动作
 * （覆盖导入属阶段 5，撤销 UI 属阶段 5）。
 *
 * ⚠️ **命名以 ADR-010 §7 为准**：ADR-004 正文写作 `overwrite_anchor`、ADR-006 写作 `revoke`，
 * 是同一批事件的两套名字；`type` 是持久化字符串，以带 `system/` 前缀的写法为准。
 */

/** 覆盖面锚点（ADR-004） */
export const ANCHOR_TYPE = 'system/overwrite-anchor'

/** 撤销（ADR-006） */
export const REVOKE_TYPE = 'system/revoke'

/** 全部系统事件类型 */
export const SYSTEM_EVENT_TYPES: readonly string[] = [ANCHOR_TYPE, REVOKE_TYPE]

/**
 * 是否是会移动折叠边界的系统事件。
 * 增量投影路径据此判断能否继续增量——见 `server/events/append.ts`。
 */
export function isBoundaryEventType(type: string): boolean {
  return type === ANCHOR_TYPE || type === REVOKE_TYPE
}

const uuidV7 = (label: string) =>
  z.string().refine(isUuidV7, `${label} 必须是 UUIDv7`)

/**
 * `system/overwrite-anchor` 载荷（ADR-004 §1、ADR-010 §7）：
 * 「来源文件标识、被覆盖事件数、覆盖前流水末端 id」。
 *
 * 发起账号与时刻**不重复放进载荷**——事件表已有 `account_id` / `occurred_at`。
 * 具体取值由阶段 5 的覆盖导入填写。
 */
export const overwriteAnchorPayloadSchema = z
  .object({
    /** 来源文件标识（文件名或摘要，阶段 5 定） */
    sourceFile: z.string().min(1),
    /** 被覆盖的事件数量 */
    overwrittenCount: z.number().int().min(0),
    /** 覆盖前流水末端 id = 回滚锚点；流水为空时为 null */
    previousHeadId: uuidV7('覆盖前流水末端 id').nullable(),
  })
  .strict()

export type OverwriteAnchorPayload = z.infer<typeof overwriteAnchorPayloadSchema>

/**
 * `system/revoke` 载荷（ADR-006 §1、ADR-010 §7）：目标批次标识 + 可选原因。
 *
 * `targetBatchId` 指向**原批次标识**——这也是 ADR-010 §3 要求导入的事件
 * 保留原 `batch_id` 的原因：重写成新批次会让 revoke 解析不到目标，
 * 被撤销的历史在导入后静默复活。
 */
export const revokePayloadSchema = z
  .object({
    targetBatchId: uuidV7('目标批次标识'),
    reason: z.string().min(1).optional(),
  })
  .strict()

export type RevokePayload = z.infer<typeof revokePayloadSchema>

/**
 * 覆盖面锚点：**apply 是空操作**。
 * 它的全部语义在第 1 步的边界扫描（`project()`）与「锚点自身不参与折叠」里。
 */
export const overwriteAnchorDefinition: EventDefinition<OverwriteAnchorPayload> = defineEvent({
  type: ANCHOR_TYPE,
  schema: overwriteAnchorPayloadSchema,
  apply: () => {
    // 空操作：不写任何投影表（ADR-010 §7）
  },
})

/**
 * 撤销：**apply 是空操作**。
 *
 * 它不写投影表；「跳过被撤销批次」发生在 `project()` 第 3 步，
 * 由 `project()` 从 revoke 事件的载荷构建跳过集合——而**不是**在 apply 里
 * （撤销不能靠「追加反向事件」实现，那样无法处理一批上万条事件的导入）。
 */
export const revokeDefinition: EventDefinition<RevokePayload> = defineEvent({
  type: REVOKE_TYPE,
  schema: revokePayloadSchema,
  apply: () => {
    // 空操作：不写任何投影表（ADR-010 §7）
  },
})

/** 阶段 2 登记的全部系统事件定义（注册表以 `RegisteredDefinition` 形态收纳） */
export const systemEventDefinitions: readonly RegisteredDefinition[] = [
  overwriteAnchorDefinition,
  revokeDefinition,
]
