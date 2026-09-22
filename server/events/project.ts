import { ANCHOR_TYPE, REVOKE_TYPE } from './definitions/system.js'
import { getEventDefinition } from './registry.js'
import type { Event, Projection } from './types.js'

/**
 * 重放：给定事件集合，得到状态（ADR-010 §4）。
 *
 * **必须是纯函数**：不读库、不读时钟、不读全局状态——它只吃一个事件数组。
 * 边界信息（覆盖面、撤销集合）也**从事件数组本身推导**，而不是从额外的簿记表读，
 * 这样「同一份事件集必得同一状态」在跨设备重放时依然成立（ADR-010「理由」）。
 *
 * 内部三步（顺序即语义）：
 *   1. **排定边界**：找到最后一条 `system/overwrite-anchor`，只保留它之后的事件
 *      （ADR-004）；收集全部 `system/revoke` 得到被撤销的 `batch_id` 集合（ADR-006）；
 *   2. **排序**：按 `id` 升序（ADR-001 §2）。**不得**用 rowid / 插入顺序 / `batch_id`；
 *   3. **折叠**：跳过被撤销批次内的事件，逐条调用其 `EventDefinition.apply`。
 */
export function project(events: readonly Event[]): Projection {
  // 空流水的投影 = 「什么都没发生过」：模板为空，设置**未设置**（null，不是默认值）。
  // 默认值属于读取方的回落策略，`project()` 若在这里填默认值就得读服务端时区。
  const projection: Projection = { templates: [], settings: null }
  if (events.length === 0) return projection

  assertSingleAccount(events)

  // ── 第 1 步：排定边界 ─────────────────────────────────────────────
  // 锚点取「id 最大的一条」而不是「数组里最后一条」：ADR-004 的约束明写
  // 「『最后一条锚点』的定位必须与重放排序键（ADR-001）一致，不得依赖 seq 或插入顺序」。
  let anchorId: string | null = null
  for (const event of events) {
    if (event.type === ANCHOR_TYPE && (anchorId === null || event.id > anchorId)) {
      anchorId = event.id
    }
  }

  // 撤销集合：**全部** revoke 事件的载荷目标。revoke 自身不参与该集合的构建
  // （避免自指），且 revoke 事件本身不可被撤销 —— 见第 3 步的跳过条件。
  const revokedBatchIds = new Set<string>()
  for (const event of events) {
    if (event.type !== REVOKE_TYPE) continue
    const target = (event.payload as { targetBatchId?: unknown } | null)?.targetBatchId
    if (typeof target === 'string') revokedBatchIds.add(target)
  }

  // ── 第 2 步：按 id 升序 ───────────────────────────────────────────
  const ordered = [...events].sort(compareById)

  // ── 第 3 步：折叠 ────────────────────────────────────────────────
  for (const event of ordered) {
    // 覆盖面**之前**的全部事件（含锚点自身）不参与折叠，但物理保留（ADR-004/010）。
    // 用 id 比较而非数组下标：与重放排序键一致，且与输入顺序无关。
    if (anchorId !== null && event.id <= anchorId) continue

    // 被撤销批次内的事件跳过；**revoke 事件自身不可被撤销**（ADR-006），
    // 因此它在任何情况下都参与折叠（其 apply 是空操作，起作用的是它在第 1 步的贡献）。
    if (event.type !== REVOKE_TYPE && revokedBatchIds.has(event.batchId)) continue

    // 未登记的 type 在这里抛错：无法重放的事件等于无法定义的状态
    getEventDefinition(event.type).apply(projection, event)
  }

  canonicalizeProjection(projection)
  return projection
}

/**
 * 把投影的数组顺序规范化成**模板 id 升序**。
 *
 * 折叠顺序是「事件 id」序，删除会让数组出现空位、更新会原地替换，
 * 于是同一份状态可以有多种数组顺序。若不规范化，「增量维护」与「全量重建」
 * 两条路径产出的对象会在顺序上不同，ADR-010 §5 要求的「两者结果必须一致」
 * 就无法逐字段断言（只能比较排序后的副本，等于把不变式测松了）。
 */
export function canonicalizeProjection(projection: Projection): void {
  projection.templates.sort((a, b) => compareIds(a.id, b.id))
}

/**
 * 排序键：**唯一地是事件 `id`**（ADR-001 §2）。
 * 用码元比较（`<` / `>`）而不是 `localeCompare`——后者依赖宿主 locale，
 * 会让「同一份事件集在任何设备上重放得到同一状态」落空。
 */
function compareById(a: Event, b: Event): number {
  return compareIds(a.id, b.id)
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * 单账号不变量：`project()` 的边界（「该账号最后一条锚点」）以**一个账号**为前提。
 * 混入第二个账号的事件会静默产出跨账号合并的状态，而投影表是按账号写的——
 * 那样会把 B 的模板写进 A 的行里。宁可当场抛错。
 */
function assertSingleAccount(events: readonly Event[]): void {
  const first = events[0]!.accountId
  for (const event of events) {
    if (event.accountId !== first) {
      throw new Error(
        `project() 只接受单个账号的事件流：同时出现 '${first}' 与 '${event.accountId}'。` +
          '混账号折叠会产出跨账号状态（ADR-010 §4 的边界以账号为单位）。',
      )
    }
  }
}
