import type { Db } from '../db/connection.js'
import { today as accountToday, toIsoInZone, type DayKey } from '@shared/time'
import type { FocusItem, FocusToday } from '@shared/focus'
import { appendEvents } from '../events/append.js'
import {
  FOCUS_ADDED_TYPE,
  FOCUS_REMOVED_TYPE,
  type FocusEventPayload,
} from '../events/definitions/focus.js'
import { readAccountEvents } from '../events/event-store.js'
import { foldedEvents } from '../events/project.js'
import { readTaskRows } from '../events/projection-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'
import type { Event } from '../events/types.js'
import { invalidInput, notFound } from '../lib/errors.js'
import { getTaskDetail, listTasks } from '../tasks/service.js'

type FocusDirective = { item: FocusItem; selected: boolean }

function itemKey(item: FocusItem): string {
  return `${item.taskId}\x00${item.occurrenceKey}`
}

/** 保留移除指令，供自动集合判断「今天明确移出」；撤销批次已由调用方过滤。 */
function foldFocusDirectives(events: readonly Event[], dayKey: DayKey): Map<string, FocusDirective> {
  const directives = new Map<string, FocusDirective>()
  for (const event of events) {
    if (event.type !== FOCUS_ADDED_TYPE && event.type !== FOCUS_REMOVED_TYPE) continue
    const payload = event.payload as FocusEventPayload
    if (payload.focusDayKey !== dayKey) continue
    const item = { taskId: payload.taskId, occurrenceKey: payload.occurrenceKey }
    const key = itemKey(item)
    directives.delete(key)
    directives.set(key, { item, selected: event.type === FOCUS_ADDED_TYPE })
  }
  return directives
}

/**
 * 今日聚焦没有独立可变表：对同一账号已经应用覆盖面和批次撤销规则的事件，
 * 按 UUIDv7 id 序折叠最后一次加入/移除。键同时包含日和实例，避免重复任务串轮。
 */
export function foldFocusEvents(events: readonly Event[], dayKey: DayKey): FocusItem[] {
  return [...foldFocusDirectives(events, dayKey).values()]
    .filter((directive) => directive.selected)
    .map((directive) => directive.item)
}

function currentDirectives(db: Db, accountId: string, dayKey: DayKey): Map<string, FocusDirective> {
  return foldFocusDirectives(foldedEvents(readAccountEvents(db, accountId)), dayKey)
}

function visibleFocus(db: Db, accountId: string, items: FocusItem[]): FocusItem[] {
  const liveTaskIds = new Set(
    readTaskRows(db, accountId).filter((task) => task.deletedAt === null).map((task) => task.id),
  )
  return items.filter((item) => liveTaskIds.has(item.taskId))
}

function dayOf(db: Db, accountId: string, now: Date): DayKey {
  return accountToday(timeContextOf(loadAccountSettings(db, accountId)), now)
}

/** 自动收录今天明确安排的可执行实例；已完成项只在今天完成时保留。 */
function automaticFocus(db: Db, accountId: string, now: Date, dayKey: DayKey): FocusItem[] {
  return listTasks(db, accountId, now, { scope: 'all' }).items
    .filter((item) => {
      if (item.status === 'abandoned') return false
      if (item.recurring) {
        return item.occurrenceKey === dayKey
          && ((item.pending && item.completedAt === null) || item.completedDayKey === dayKey)
      }
      return (item.plannedDate === dayKey || item.dueDate === dayKey)
        && (item.completedAt === null || item.completedDayKey === dayKey)
    })
    .map((item) => ({ taskId: item.taskId, occurrenceKey: item.occurrenceKey }))
}

/** 自动安排 + 手动加入 − 当日显式移除；账号日界后重新计算，排期字段不被改写。 */
export function focusToday(db: Db, accountId: string, now: Date): FocusToday {
  const dayKey = dayOf(db, accountId, now)
  const directives = currentDirectives(db, accountId, dayKey)
  const merged = new Map<string, FocusItem>()
  for (const item of automaticFocus(db, accountId, now, dayKey)) {
    if (directives.get(itemKey(item))?.selected === false) continue
    merged.set(itemKey(item), item)
  }
  for (const directive of directives.values()) {
    if (directive.selected) merged.set(itemKey(directive.item), directive.item)
  }
  return { dayKey, items: visibleFocus(db, accountId, [...merged.values()]) }
}

/**
 * 加入聚焦前按任务现有的轮次推导校验实例键。
 * 普通任务的键恒为 indexDate；重复任务的键是轮次原计划日。
 * 聚焦行为只写自己的事件，不改计划日、期限或项目归属。
 */
export function addToFocusToday(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  occurrenceKey: DayKey,
): FocusToday {
  assertInTransaction(db, '加入今日聚焦')
  const settings = loadAccountSettings(db, accountId)
  const dayKey = accountToday(timeContextOf(settings), now)
  // 先保证标识属于当前账号。显式已入选项直接返回；自动入选项收到 PUT 时
  // 仍写出显式选择，避免日内改期后从「我的一天」消失。
  const ownedTask = readTaskRows(db, accountId).find((row) => row.id === taskId)
  if (ownedTask === undefined) throw notFound(`任务不存在（${taskId}）`)
  const item = { taskId, occurrenceKey }
  const directive = currentDirectives(db, accountId, dayKey).get(itemKey(item))
  if (directive?.selected === true) {
    return focusToday(db, accountId, now)
  }

  // 自动成员（含今天完成的成员）可被显式钉在今天，也可在移出后重新加入；
  // 非自动候选继续执行实例与完成守卫，不能选入任意历史轮次。
  const isAutomatic = automaticFocus(db, accountId, now, dayKey)
    .some((entry) => itemKey(entry) === itemKey(item))
  if (!isAutomatic) {
    const detail = getTaskDetail(db, accountId, now, taskId)
    const round = detail.occurrences.find((row) => row.originalPlannedDate === occurrenceKey)
    if (round === undefined) {
      throw notFound(`实例不存在（任务 ${taskId} 没有原计划日期为 '${occurrenceKey}' 的轮次）`)
    }
    if (detail.task.status === 'abandoned') throw invalidInput('已放弃的任务不能加入今日聚焦')
    if (round.status === 'completed') throw invalidInput('已完成的轮次不能加入今日聚焦')
  }

  appendEvents(db, accountId, [{
    type: FOCUS_ADDED_TYPE,
    occurredAt: toIsoInZone(now, settings.timeZone),
    payload: { taskId, occurrenceKey, focusDayKey: dayKey },
    dayKey,
    dayStartHour: settings.dayStartHour,
  }])
  return focusToday(db, accountId, now)
}

/** 重复移除不追加事件；允许清理已软删除任务留下的聚焦事实。 */
export function removeFromFocusToday(
  db: Db,
  accountId: string,
  now: Date,
  taskId: string,
  occurrenceKey: DayKey,
): FocusToday {
  assertInTransaction(db, '移出今日聚焦')
  const settings = loadAccountSettings(db, accountId)
  const dayKey = accountToday(timeContextOf(settings), now)
  const task = readTaskRows(db, accountId).find((row) => row.id === taskId)
  if (task === undefined) throw notFound(`任务不存在（${taskId}）`)

  const item = { taskId, occurrenceKey }
  const directive = currentDirectives(db, accountId, dayKey).get(itemKey(item))
  if (directive?.selected === true
    || focusToday(db, accountId, now).items.some((entry) => itemKey(entry) === itemKey(item))) {
    appendEvents(db, accountId, [{
      type: FOCUS_REMOVED_TYPE,
      occurredAt: toIsoInZone(now, settings.timeZone),
      payload: { taskId, occurrenceKey, focusDayKey: dayKey },
      dayKey,
      dayStartHour: settings.dayStartHour,
    }])
  }
  return focusToday(db, accountId, now)
}
