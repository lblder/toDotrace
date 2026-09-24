import type { DayKey } from '@shared/time'

/** 今日聚焦选择的是任务的一个实例，不改变任务的任何排期字段。 */
export interface FocusItem {
  taskId: string
  occurrenceKey: DayKey
}

/** `dayKey` 由服务端按当前账号的日界计算，客户端只负责展示。 */
export interface FocusToday {
  dayKey: DayKey
  items: FocusItem[]
}
