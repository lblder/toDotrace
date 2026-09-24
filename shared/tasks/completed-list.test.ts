import { describe, expect, it } from 'vitest'
import { buildCompletedTodoItems, buildTodoItems } from './today'
import { checked, completed, task, taskId, uncompleted } from './test-fixtures'

const TODAY = '2026-09-22'

describe('TodoItem.scheduledOccurrenceDate', () => {
  it('普通任务恒为 null；未来才开始的重复任务用首轮日，不把创建日当排期', () => {
    const ordinary = task({ id: taskId(1), plannedDate: '2026-09-28' })
    const recurring = task({
      id: taskId(2),
      indexDate: '2026-09-01',
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: '2026-09-28',
      },
    })
    const [one, two] = buildTodoItems({ tasks: [ordinary, recurring], events: [], today: TODAY })
    expect(one?.scheduledOccurrenceDate).toBeNull()
    expect(two).toMatchObject({
      occurrenceKey: '2026-09-01',
      scheduledOccurrenceDate: '2026-09-28',
      pending: false,
    })
  })

  it('当前有待做轮次取该轮；完成后取固化下一锚点允许的未来命中日，终止则 null', () => {
    const id = taskId(3)
    const recurring = task({
      id,
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: '2026-09-20',
      },
    })
    const pending = buildTodoItems({ tasks: [recurring], events: [], today: TODAY })[0]!
    expect(pending).toMatchObject({ occurrenceKey: TODAY, scheduledOccurrenceDate: TODAY, pending: true })

    const done = completed(1, {
      taskId: id,
      originalPlannedDate: TODAY,
      completedDayKey: TODAY,
      next: { date: '2026-09-23', mode: 'catch_up' },
    })
    const after = buildTodoItems({ tasks: [recurring], events: [done], today: TODAY })[0]!
    expect(after).toMatchObject({ occurrenceKey: TODAY, scheduledOccurrenceDate: '2026-09-23', pending: false })

    const skippedByAnchor = completed(3, {
      taskId: id,
      originalPlannedDate: TODAY,
      completedDayKey: TODAY,
      next: { date: '2026-09-25', mode: 'catch_up' },
    })
    expect(buildTodoItems({ tasks: [recurring], events: [skippedByAnchor], today: TODAY })[0]
      ?.scheduledOccurrenceDate).toBe('2026-09-25')

    const ended = task({
      ...recurring,
      recurrence: {
        rule: { freq: 'daily', interval: 1, count: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: TODAY,
      },
    })
    const terminal = completed(2, {
      taskId: id,
      originalPlannedDate: TODAY,
      completedDayKey: TODAY,
      next: null,
    })
    expect(buildTodoItems({ tasks: [ended], events: [terminal], today: TODAY })[0]?.scheduledOccurrenceDate).toBeNull()
  })
})

describe('已完成视图的实例行', () => {
  it('同一重复任务的两个有效完成轮次各一行；取消一轮后仅该轮消失', () => {
    const id = taskId(4)
    const recurring = task({
      id,
      status: 'abandoned',
      steps: [{ id: 'step-1', title: '复盘' }],
      recurrence: {
        rule: { freq: 'daily', interval: 1 },
        nextAnchorMode: 'catch_up',
        startsOn: '2026-09-20',
      },
    })
    const first = completed(1, {
      taskId: id,
      originalPlannedDate: '2026-09-20',
      next: { date: '2026-09-21', mode: 'catch_up' },
    })
    const second = completed(2, {
      taskId: id,
      originalPlannedDate: '2026-09-21',
      next: { date: TODAY, mode: 'catch_up' },
    })
    const input = {
      tasks: [recurring],
      events: [first, second],
      stepChecks: [checked(id, 'step-1', '2026-09-20')],
      today: TODAY,
    }
    const rows = buildCompletedTodoItems(input)
    expect(rows.map((item) => [item.taskId, item.occurrenceKey])).toEqual([
      [id, '2026-09-20'],
      [id, '2026-09-21'],
    ])
    expect(rows.every((item) => item.completedAt !== null && item.pending === false)).toBe(true)
    expect(rows[0]?.steps[0]?.checkedAt).not.toBeNull()
    expect(rows[1]?.steps[0]?.checkedAt).toBeNull()
    expect(rows.every((item) => item.status === 'abandoned')).toBe(true)

    const corrected = buildCompletedTodoItems({
      ...input,
      events: [...input.events, uncompleted(3, { taskId: id, originalPlannedDate: '2026-09-20' })],
    })
    expect(corrected.map((item) => item.occurrenceKey)).toEqual(['2026-09-21'])
  })

  it('普通任务的旧轮次孤立历史仍展示；软删除任务不产生行', () => {
    const id = taskId(5)
    const ordinary = task({ id, indexDate: '2026-09-10' })
    const valid = completed(1, { taskId: id, originalPlannedDate: '2026-09-10' })
    const formerRound = completed(2, { taskId: id, originalPlannedDate: '2026-09-11' })
    expect(buildCompletedTodoItems({ tasks: [ordinary], events: [valid, formerRound], today: TODAY })
      .map((item) => item.occurrenceKey)).toEqual(['2026-09-10', '2026-09-11'])
    expect(buildCompletedTodoItems({
      tasks: [task({ ...ordinary, deletedAt: '2026-09-22T12:00:00+08:00' })],
      events: [valid],
      today: TODAY,
    })).toEqual([])
  })
})
