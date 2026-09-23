/**
 * 排序 —— ADR-015 §4 的**可判定**实现（FR2.6「智能排序」）。
 *
 * 零依赖纯函数，**服务端与前端导入同一份**（ADR-015 §7）：服务端用它产出默认顺序，
 * 前端用它做交互式切换。**不得在组件里重写排序**——FR2.6 要求界面显示的排序理由
 * 与实际档位是同一个东西；两份实现必然漂移，而漂移的表现是
 * 「它说因为逾期排第一，但实际排第三」，用户无法察觉这是 bug，只会觉得软件不可信。
 *
 * ## 全序（第 4 级不能省）
 *
 * 档位 → ① 重要性（`high > normal > low`）→ ② `createdAt` 升序 → ③ **`taskId` 升序**。
 *
 * ③ 不是凑数的：两条任务若在同一毫秒创建，② 相等；此时没有 ③ 的话，排序结果取决于
 * `Array.prototype.sort` 在比较函数恒返 0 时的行为——**而规范不保证它是稳定排序**，
 * 同一份数据在不同 Node 版本可能给出不同顺序。加上 ③ 才是全序，测试才可断言、
 * 界面才不会偶发抖动。（§后果 有一条专门的回归：「颠倒输入数组顺序不改变结果」。）
 *
 * ## 五种模式（§4 定 `smart`，§4.1 定其余四种）
 *
 * | 模式 | 排序键 |
 * |---|---|
 * | `smart`（默认） | §4 的档位 → 重要性 → `createdAt` → `taskId` |
 * | `due` | `dueDate` 升序（null 最后）→ 档位 → 重要性 → `createdAt` → `taskId` |
 * | `created` | `createdAt` 升序 → `taskId` |
 * | `importance` | 重要性 → 档位 → `createdAt` → `taskId` |
 * | `manual` | `manualOrder` 升序（null 最后）→ `createdAt` → `taskId` |
 *
 * **五种都必须以 `taskId` 收尾**，否则不是全序（§4.1 明文，理由同上）。
 * **`manual` 与 `smart` 不互相污染**：`manual` 不看档位，`smart` **不看 `manualOrder`**
 * ——用户在手动模式里排好的顺序，切回智能排序不生效，再切回来仍在（§4.1）。
 */
import { compareDayKey, isDayKey } from '@shared/time'
import type { DayKey } from '@shared/time'

import { urgencyBucket } from './today'
import type { Importance, TodoItem } from './types'

/** 排序模式（FR2.6 的五种）；`smart` 是默认（ADR-015 §4 / §4.1） */
export type SortMode = 'smart' | 'due' | 'created' | 'importance' | 'manual'

/** 重要性次序：`high` 最前（FR2.6「同一档比重要性」） */
const IMPORTANCE_RANK: Readonly<Record<Importance, number>> = { high: 0, normal: 1, low: 2 }

/**
 * 字符串比较（-1 / 0 / 1）。
 *
 * 依赖「字典序 === 时间序」这条**跨模块的隐式性质**（与 `deriveRounds` 对 `eventId`
 * 的处置同源，ADR-001 §2）：
 * - `taskId`：规范 UUIDv7、小写、定长 36 ⇒ 字典序 === 时间序；
 * - `createdAt`：ISO 8601 定宽串（ADR-009 §9 的 `toIsoInZone`），
 *   **同一账号共用同一个时区**，故字典序 === 时间序。
 *   （唯一的例外是用户在夏令时回拨那一小时内恰好创建了两条任务：两份串的偏移不同，
 *   字典序可能与时间序相差一次偏移量。代价如实登记——这个窗口一年一次、一次一小时。）
 */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * 智能排序的比较函数（§4 的全序）。
 *
 * **同档内**依次比较重要性、`createdAt`、`taskId`；**跨档**只比档位。
 * 已完成的（档 6）与已放弃的（档 5）因此自然排在最后，不混在当天里。
 */
export function compareBySmart(a: TodoItem, b: TodoItem, today: DayKey): number {
  const bucketDiff = urgencyBucket(a, today) - urgencyBucket(b, today)
  if (bucketDiff !== 0) return bucketDiff < 0 ? -1 : 1

  const importanceDiff = IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]
  if (importanceDiff !== 0) return importanceDiff < 0 ? -1 : 1

  const createdDiff = compareText(a.createdAt, b.createdAt)
  if (createdDiff !== 0) return createdDiff

  return compareText(a.taskId, b.taskId)
}

/** 期限升序；**无期限的排在最后**（§4.1：「没有期限」不该看起来最紧急），同级回落智能序 */
function compareByDueDate(a: TodoItem, b: TodoItem, today: DayKey): number {
  if (a.dueDate === null && b.dueDate === null) return compareBySmart(a, b, today)
  if (a.dueDate === null) return 1
  if (b.dueDate === null) return -1
  const diff = compareDayKey(a.dueDate, b.dueDate)
  return diff !== 0 ? diff : compareBySmart(a, b, today)
}

/**
 * 手动顺序（§4.1）：`manualOrder` 升序，**`null` 统一排在已手动排过的之后**，
 * 于是**新任务不会插队到用户手工排好的清单中间**；`null` 之间按 `createdAt`。
 *
 * **不掺任何档位/重要性**——`manual` 只有这三把键（§4.1 的表）。
 * `manualOrder` 由 `task/reordered` 写入（ADR-013 §4.5 的中值法），
 * 本模块**只读不写**。
 */
function compareByManual(a: TodoItem, b: TodoItem): number {
  if (a.manualOrder === null && b.manualOrder === null) {
    const created = compareText(a.createdAt, b.createdAt)
    return created !== 0 ? created : compareText(a.taskId, b.taskId)
  }
  if (a.manualOrder === null) return 1
  if (b.manualOrder === null) return -1
  if (a.manualOrder !== b.manualOrder) return a.manualOrder < b.manualOrder ? -1 : 1
  // 两条 `manualOrder` 完全相等（中值法耗尽、或导入带来的重复值）时，
  // 仍然要落到 `createdAt` → `taskId`，否则这一段不是全序
  const created = compareText(a.createdAt, b.createdAt)
  return created !== 0 ? created : compareText(a.taskId, b.taskId)
}

/**
 * 创建时间升序（§4.1 的第一行「`created` = `createdAt` 升序 → `taskId`」）。
 *
 * ⚠️ **它只有这两把键**——不像 `due` / `importance` 那样中间还夹着「档位 → 重要性」。
 * 这不是省笔墨：§4.1 的表在另外两行**明写了**那两级，这里没写，故按字面实现。
 * 语义上也对：用户点「按创建时间」要的是**创建顺序**，若中间插一层档位，
 * 一条早创建的逾期任务会被一条晚创建的未来任务挤到后面，那就不是按创建时间了。
 */
function compareByCreatedAt(a: TodoItem, b: TodoItem): number {
  const diff = compareText(a.createdAt, b.createdAt)
  return diff !== 0 ? diff : compareText(a.taskId, b.taskId)
}

/** 重要性降序（`high` 最前），同级回落智能序——即 §4.1 的「重要性 → 档位 → createdAt → taskId」 */
function compareByImportance(a: TodoItem, b: TodoItem, today: DayKey): number {
  const diff = IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]
  if (diff !== 0) return diff < 0 ? -1 : 1
  return compareBySmart(a, b, today)
}

/**
 * 排序（**返回新数组，不改动入参**——纯函数，同一输入反复调用结果恒等）。
 *
 * `today` 必须显式传入：档位由紧迫日与 `today` 共同决定（§4），本模块不读时钟。
 *
 * @param items 待排序的行（`todayItems` / `queryItems` 的输出）
 * @param today 今日归属日（ADR-015 §6：由服务端算好并回带）
 * @param mode  排序模式，默认 `'smart'`（§4）
 */
export function sortItems(
  items: readonly TodoItem[],
  today: DayKey,
  mode: SortMode = 'smart',
): TodoItem[] {
  if (!isDayKey(today)) {
    throw new RangeError(`today 不是合法 DayKey：'${String(today)}'`)
  }
  const compare = comparatorFor(mode)
  return [...items].sort((a, b) => compare(a, b, today))
}

function comparatorFor(mode: SortMode): (a: TodoItem, b: TodoItem, today: DayKey) => number {
  switch (mode) {
    case 'smart':
      return compareBySmart
    case 'due':
      return compareByDueDate
    case 'created':
      return compareByCreatedAt
    case 'importance':
      return compareByImportance
    case 'manual':
      return compareByManual
  }
}
