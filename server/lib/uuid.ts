/**
 * 服务端的 UUIDv7 入口 —— **一次再导出，本文件不再有自己的实现**（ADR-017 §5.1 ③）。
 *
 * 生成器已搬到 `shared/uuid.ts`，因为两端要共用同一份：浏览器侧生成任务 id
 * （快速录入、新建任务）与服务端生成事件 id 必须是同一个规则，
 * 否则「id 序 === 时间序」这件事会有两份可能漂移的实现。
 * 搬家时改掉了两处 Node 内建（`Buffer` / `node:crypto`），三条约束与「本文件为何可以不纯」
 * 写在该文件头部；本文件只保留原路径，让既有导入点（`events/append.ts` /
 * `events/definitions/system.ts` / `domain/accounts.ts` 与两个测试文件）不必改动——
 * **路径留着是为了少改调用方，不是因为这里还有第二份实现**。
 */
export { isUuidV7, uuidv7 } from '@shared/uuid'
