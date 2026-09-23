/**
 * 任务界面的中文文案 —— **每一个都按 `shared/` 的联合类型穷举**。
 *
 * 为什么用 `Record<TodoReason, string>` 而不是几张散落的 `if`：
 * 这些联合类型是「唯一一份」的定义（`shared/tasks/types.ts`），而文案是它们的
 * **每个取值**都必须回答的问题。写成 Record，将来任何一处新增取值
 * （如 ADR-015 §1 补 `bucket_abandoned` 那次）都会**编译不过**，
 * 而不是在界面上静默缺一行字。
 *
 * ⚠️ **档位理由（`bucket_*`）的文案必须与 ADR-015 §4 的档位表逐字对应**：
 * 界面显示的是「它为什么排在这里」（FR2.6），而档位由 `urgencyBucket` 判定。
 * 措辞与档位一旦分叉，用户看到的就是一句假话——而 FR2.6 要求理由**可见且为真**。
 */
import type { Importance, TaskStatus, TodoReason } from '@shared/tasks'
import type { SortMode } from '@shared/tasks'
import type { StatusFilter } from '@shared/tasks'
import type { OwnershipLevel } from '@shared/plan'

/** **入选**理由：回答「它为什么在这儿」（§1 的分类由 `isSelectionReason` 判定） */
export const SELECTION_REASON_TEXT: Readonly<Record<TodoReason, string>> = {
  planned_today: '计划日就是今天',
  planned_overdue: '计划日已经过了',
  due_today: '期限今天到',
  due_overdue: '期限已经过了',
  in_progress_undated: '你把它标成了进行中',
  completed_today: '今天完成的',
  recurring_pending: '这一轮今天该做',
  recurring_overdue: '这一轮已经拖过',
  // 下面七条是**档位**理由，不是入选理由；放在同一张 Record 里是为了穷举，
  // 界面取用时必须经 `isBucketReason` 分流（见 `reasonText`）。
  bucket_overdue: '排在最前：已逾期',
  bucket_today: '排在前面：今天到期',
  bucket_tomorrow: '明天到期',
  bucket_this_week: '本周内到期',
  bucket_no_date: '没有日期，或排在本周之后',
  bucket_abandoned: '已放弃',
  bucket_done: '已完成',
  outside_project_range: '排期在项目区间之外',
}

/** 档位徽标的短文案（与 §4 的七档一一对应，顺序即档位顺序） */
export const BUCKET_LABEL: Readonly<Record<TodoReason, string>> = {
  ...SELECTION_REASON_TEXT,
  bucket_overdue: '已逾期',
  bucket_today: '今天',
  bucket_tomorrow: '明天',
  bucket_this_week: '本周',
  bucket_no_date: '无日期',
  bucket_abandoned: '已放弃',
  bucket_done: '已完成',
}

export const STATUS_TEXT: Readonly<Record<TaskStatus, string>> = {
  not_started: '未开始',
  in_progress: '进行中',
  abandoned: '已放弃',
}

export const IMPORTANCE_TEXT: Readonly<Record<Importance, string>> = {
  high: '高',
  normal: '普通',
  low: '低',
}

/**
 * FR2.6 的排序模式。**五种，与 `SortMode` 一一对应。**
 *
 * > `manual` 一度**不在这里**，注释里写着它「实现不了」——理由当时是成立的：
 * > `TodoItem` 上没有 `manualOrder`（而读取侧拿不到它，任何「按它排」的实现都只能凭空造值），
 * > 写入侧 `POST /api/tasks/:id/order` 却存在，即**能写不能读**。
 * >
 * > **那个缺口已补**（`TodoItem.manualOrder` + `compareByManual`）。这条注释留在
 * > 记录里，是因为它当时的具体措辞——**「界面不摆一个点了没用的排序模式」**——
 * > 是正确判断：**缺口该让用户看不见，而不是让它看起来能用。**
 * > 反过来，**缺口的修法不该是「把选项藏起来」，而是把它补上**；
 * > 藏只是不误导，补才是完成。
 */
export const SORT_TEXT: Readonly<Record<SortMode, string>> = {
  smart: '智能排序',
  due: '按期限',
  created: '按创建时间',
  importance: '按重要性',
  manual: '手动排序',
}

export const STATUS_FILTER_TEXT: Readonly<Record<StatusFilter, string>> = {
  active: '进行中',
  completed: '已完成',
  abandoned: '已放弃',
  all: '全部',
}

/**
 * 「进行中」这个筛选值**不是** `TaskStatus.in_progress`（`shared/tasks/filter.ts` 的注释
 * 专门澄清过）。文案同上，但这里留一个明确的区分锚点，免得下一个人把它们合并。
 */
export const STATUS_FILTER_HINT =
  '「进行中」筛选 = 未完成且未放弃，与任务状态里的「进行中」不是同一件事。'

export const OWNERSHIP_TEXT: Readonly<Record<OwnershipLevel, string>> = {
  day: '日',
  week: '周',
  project: '项目',
  unplaced: '未归层',
}

/** 取一条理由的可读文案。键一定是 `TodoReason`，故查表必然命中 */
export function reasonText(reason: TodoReason): string {
  return SELECTION_REASON_TEXT[reason]
}
