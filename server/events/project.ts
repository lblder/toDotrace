import { compareDayKey } from '@shared/time'
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
  // 空流水的投影 = 「什么都没发生过」：任务为空，设置**未设置**（null，不是默认值），
  // 打卡日为空（无行 = 无到达 = 休息日，ADR-012 §2/§5），项目与每日备注为空。
  // 默认值属于读取方的回落策略，`project()` 若在这里填默认值就得读服务端时区。
  const projection: Projection = {
    tasks: [],
    projects: [],
    settings: null,
    days: [],
    dayNotes: [],
  }
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
 * 把投影的数组顺序规范化 —— **排序键写死在 ADR-013 §5 的那张表里，不留给实现者**：
 *
 * | 投影数组 | 排序键 |
 * |---|---|
 * | `tasks` | `id` 升序 |
 * | `projects` | `id` 升序 |
 * | `days` | `dayKey` 升序 |
 * | `dayNotes` | `dayKey` 升序 |
 *
 * 折叠顺序是「事件 id」序，而任务会被原地更新、软删除、撤销批次改写——它与任务 id 序
 * **天然不同**。两条路径若不按同一个键规范化，产出的数组顺序就不一致，
 * ADR-010 §5 要求的「增量维护结果 == 全量重建结果」那条断言**必然 flaky**，
 * 而 flaky 的断言会被当成测试问题而不是设计问题。
 *
 * `id` 的字符串比较前提见 ADR-001「约束」：规范 UUIDv7、小写、**定长 36**
 * ⇒ **字典序 === 时间序**。
 *
 * 打卡日按 `dayKey` 升序还有第二个用途：ADR-012 §6 要求 `shared/checkin` 的入参
 * `dayKeys`「已升序、已去重」，而投影是它唯一被保证的来源（§3 的 `/days` 也返回升序）。
 * 比较走 `@shared/time` 的 `compareDayKey`——**不引入本层自己的日期比较**
 * （§约束「所有归属日折算经 shared/time」）。
 *
 * **嵌套的 `steps` 不单独排序**（ADR-013 §5）：它的顺序是 `apply` 维护的**数组顺序**本身
 * （`step-added` 追加到末尾、`step-removed` 原位删除、`steps-reordered` 整体替换）。
 * 它是事件顺序的确定性函数，故无需额外规范化——**但这也意味着 `steps-reordered` 的
 * `order` 载荷必须是完整列表**（§4.13）。
 */
export function canonicalizeProjection(projection: Projection): void {
  projection.tasks.sort((a, b) => compareIds(a.id, b.id))
  projection.projects.sort((a, b) => compareIds(a.id, b.id))
  projection.days.sort((a, b) => compareDayKey(a.dayKey, b.dayKey))
  projection.dayNotes.sort((a, b) => compareDayKey(a.dayKey, b.dayKey))
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
 * 那样会把 B 的任务写进 A 的行里。宁可当场抛错。
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
