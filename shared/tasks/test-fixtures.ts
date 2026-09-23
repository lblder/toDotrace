/**
 * `shared/tasks/**` 的测试夹具（**只被 `*.test.ts` 使用**，不在任何生产路径上）。
 *
 * 为什么单独一个文件：四个测试文件都要构造 `ProjectedTask` 与完成事件，
 * 各写一份必然漂移——而漂移的症状是「同一个场景在两个文件里其实是两组数据」。
 *
 * **标识的形态是刻意的**（ADR-001「约束」：规范 UUIDv7、小写、**定长 36**）：
 * `deriveRounds` 与 `sortItems` 都用**字符串比较**判定「先后」，
 * 故夹具里的 id 必须让「字典序 === 时间序」成立，否则测试会锁死一个假的性质。
 */
import type { DayKey } from '@shared/time'

import type {
  OccurrenceEvent,
  ProjectedTask,
  RecurrenceSpec,
  StepCheck,
  TodoItem,
} from './types'

export const ACC = 'acc-1'
export const OTHER_ACC = 'acc-2'

/** 定长 36、小写、字典序 === 序号序（UUIDv7 的可排序形态） */
function padded(prefix: string, seq: number): string {
  return `${prefix}-0000-7000-8000-${String(seq).padStart(12, '0')}`
}

/** 任务标识：第 n 个任务 */
export function taskId(seq: number): string {
  return padded('01930000', seq)
}

/** 事件标识：第 n 条事件（**越大越晚**） */
export function eventId(seq: number): string {
  return padded('01920000', seq)
}

/** 一个合法的时刻串（ADR-009 §9 的形态）；`seq` 只影响时分秒 */
export function instant(seq: number): string {
  return `2026-09-22T${String(seq % 24).padStart(2, '0')}:00:00+08:00`
}

export function task(overrides: Partial<ProjectedTask> & { id: string }): ProjectedTask {
  return {
    accountId: ACC,
    title: '任务',
    notes: '',
    importance: 'normal',
    plannedDate: null,
    plannedWeek: null,
    dueDate: null,
    tags: [],
    projectId: null,
    status: 'not_started',
    manualOrder: null,
    recurrence: null,
    deletedAt: null,
    indexDate: '2026-09-01',
    createdAt: '2026-09-01T09:00:00+08:00',
    updatedAt: '2026-09-01T09:00:00+08:00',
    steps: [],
    ...overrides,
  }
}

/** 「每日」重复规则（ADR-011 §2 的 `daily`） */
export function dailyRule(): RecurrenceSpec {
  return { rule: { freq: 'daily', interval: 1 }, nextAnchorMode: 'catch_up', startsOn: '2026-09-01' }
}

/** 完成事件（ADR-013 §4.6） */
export function completed(
  seq: number,
  payload: {
    taskId: string
    originalPlannedDate: DayKey
    completedDayKey?: DayKey
    next?: { date: DayKey; mode: 'extend' | 'catch_up' | 'recompute' } | null
  },
  accountId: string = ACC,
): OccurrenceEvent {
  return {
    type: 'task/occurrence-completed',
    eventId: eventId(seq),
    accountId,
    occurredAt: instant(seq),
    payload: {
      taskId: payload.taskId,
      originalPlannedDate: payload.originalPlannedDate,
      completedDayKey: payload.completedDayKey ?? payload.originalPlannedDate,
      next: payload.next ?? null,
    },
  }
}

/** 取消完成事件（ADR-013 §4.7）——**追加一条**，不是删除 */
export function uncompleted(
  seq: number,
  payload: { taskId: string; originalPlannedDate: DayKey },
  accountId: string = ACC,
): OccurrenceEvent {
  return {
    type: 'task/occurrence-uncompleted',
    eventId: eventId(seq),
    accountId,
    occurredAt: instant(seq),
    payload: { taskId: payload.taskId, originalPlannedDate: payload.originalPlannedDate },
  }
}

/** 已勾选的步骤记录（ADR-013 §4.12 折叠后的形态） */
export function checked(
  taskIdValue: string,
  stepId: string,
  occurrenceKey: DayKey,
  checkedAt = '2026-09-22T10:00:00+08:00',
): StepCheck {
  return { taskId: taskIdValue, stepId, occurrenceKey, checkedAt }
}

/** 按 `taskId` 取行（断言「这一条在不在」时比数组下标可读） */
export function itemOf(items: readonly TodoItem[], id: string): TodoItem {
  const found = items.find((item) => item.taskId === id)
  if (found === undefined) throw new Error(`今日/视图结果里没有 taskId=${id}`)
  return found
}

/** 该行是否在结果里 */
export function has(items: readonly TodoItem[], id: string): boolean {
  return items.some((item) => item.taskId === id)
}

/** 结果里的 taskId 列表（升序，便于断言顺序无关的集合） */
export function idsOf(items: readonly TodoItem[]): string[] {
  return items.map((item) => item.taskId).sort()
}
