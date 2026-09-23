/**
 * `sort.ts` 的测试矩阵（ADR-015 §4 的全序 + §后果 的「排序全序」「已完成靠后」）。
 *
 * **第 4 级（`taskId`）的回归是本文件的重点**：前三级相等时，若没有第 4 级，
 * 顺序就取决于 `Array.prototype.sort` 在比较函数恒返 0 时的行为——而规范不保证稳定，
 * 于是测试会 flaky、界面会偶发抖动。
 */
import { describe, expect, it } from 'vitest'

import { sortItems } from './sort'
import { buildTodoItems, urgencyBucket } from './today'
import { completed, task, taskId } from './test-fixtures'
import type { TodoItem } from './types'

const TODAY = '2026-09-22' // 周二
const YESTERDAY = '2026-09-21'
const TOMORROW = '2026-09-23'
const NEXT_MONDAY = '2026-09-28'

function build(overrides: Parameters<typeof task>[0][]): TodoItem[] {
  return buildTodoItems({ tasks: overrides.map((o) => task(o)), events: [], today: TODAY })
}

/** 颠倒、轮转：两种「换个顺序喂进来」的方式 */
function shuffled<T>(items: readonly T[], shift: number): T[] {
  const rotated = [...items.slice(shift), ...items.slice(0, shift)]
  return rotated.reverse()
}

describe('档位优先（ADR-015 §4 第二步）', () => {
  it('六个档位各自落位，且顺序就是档位序', () => {
    const items = build([
      { id: taskId(1), plannedDate: YESTERDAY }, // 0 逾期
      { id: taskId(2), plannedDate: TODAY }, // 1 今天
      { id: taskId(3), plannedDate: TOMORROW }, // 2 明天
      { id: taskId(4), plannedDate: '2026-09-25' }, // 3 本周
      { id: taskId(5) }, // 4 无日期
      { id: taskId(6), plannedDate: YESTERDAY, status: 'abandoned' }, // 5 已放弃
      {
        id: taskId(7),
        indexDate: '2026-09-01',
        plannedDate: TODAY,
      }, // 6 已完成
    ])
    const done = buildTodoItems({
      tasks: [task({ id: taskId(7), indexDate: '2026-09-01', plannedDate: TODAY })],
      events: [
        completed(1, {
          taskId: taskId(7),
          originalPlannedDate: '2026-09-01',
          completedDayKey: TODAY,
          next: null,
        }),
      ],
      today: TODAY,
    })[0]!

    const all = [...items.filter((item) => item.taskId !== taskId(7)), done]
    expect(all.map((item) => urgencyBucket(item, TODAY))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(sortItems(all, TODAY).map((item) => item.taskId)).toEqual([
      taskId(1),
      taskId(2),
      taskId(3),
      taskId(4),
      taskId(5),
      taskId(6),
      taskId(7),
    ])
  })

  it('**已完成靠后**：今天完成的排在所有未完成项之后', () => {
    const id = taskId(9)
    const doneItem = buildTodoItems({
      tasks: [task({ id, indexDate: '2026-09-01' })],
      events: [completed(1, { taskId: id, originalPlannedDate: '2026-09-01', completedDayKey: TODAY, next: null })],
      today: TODAY,
    })[0]!
    const unfinished = build([{ id: taskId(1) }])[0]! // 无日期（档 4）
    expect(sortItems([doneItem, unfinished], TODAY).map((item) => item.taskId)).toEqual([taskId(1), id])
  })
})

describe('同档内的三级比较（① 重要性 → ② createdAt → ③ taskId）', () => {
  it('① 重要性 high > normal > low', () => {
    const items = build([
      { id: taskId(1), plannedDate: TODAY, importance: 'low' },
      { id: taskId(2), plannedDate: TODAY, importance: 'high' },
      { id: taskId(3), plannedDate: TODAY, importance: 'normal' },
    ])
    expect(sortItems(items, TODAY).map((item) => item.taskId)).toEqual([taskId(2), taskId(3), taskId(1)])
  })

  it('② createdAt 升序（重要性相同时）', () => {
    const items = build([
      { id: taskId(3), plannedDate: TODAY, createdAt: '2026-09-03T09:00:00+08:00' },
      { id: taskId(1), plannedDate: TODAY, createdAt: '2026-09-01T09:00:00+08:00' },
      { id: taskId(2), plannedDate: TODAY, createdAt: '2026-09-02T09:00:00+08:00' },
    ])
    expect(sortItems(items, TODAY).map((item) => item.taskId)).toEqual([taskId(1), taskId(2), taskId(3)])
  })

  it('**③ taskId 升序**：两条 `createdAt` 完全相同的任务，顺序由 taskId 决定', () => {
    const same = '2026-09-01T09:00:00+08:00'
    const items = build([
      { id: taskId(2), plannedDate: TODAY, createdAt: same },
      { id: taskId(1), plannedDate: TODAY, createdAt: same },
    ])
    expect(sortItems(items, TODAY).map((item) => item.taskId)).toEqual([taskId(1), taskId(2)])
  })
})

describe('排序是一个**全序**（ADR-015 §后果 的回归）', () => {
  const same = '2026-09-01T09:00:00+08:00'
  const items = build([
    { id: taskId(1), plannedDate: TODAY, createdAt: same, importance: 'normal' },
    { id: taskId(2), plannedDate: TODAY, createdAt: same, importance: 'normal' },
    { id: taskId(3), plannedDate: TODAY, createdAt: same, importance: 'normal' },
    { id: taskId(4), plannedDate: TODAY, createdAt: same, importance: 'normal' },
    { id: taskId(5), plannedDate: TODAY, createdAt: same, importance: 'normal' },
  ])

  it('**颠倒（并轮转）输入数组顺序不改变结果**', () => {
    const expected = items.map((item) => item.taskId).sort()
    for (let shift = 0; shift < items.length; shift += 1) {
      expect(sortItems(shuffled(items, shift), TODAY).map((item) => item.taskId)).toEqual(expected)
    }
  })

  it('不改动入参（返回新数组）', () => {
    const input = [...items]
    const output = sortItems(input, TODAY)
    expect(input.map((item) => item.taskId)).toEqual(items.map((item) => item.taskId))
    expect(output).not.toBe(input)
  })

  it('today 不是合法 DayKey 时抛 RangeError', () => {
    expect(() => sortItems(items, 'garbage')).toThrow(RangeError)
  })
})

describe('另外三种排序模式（**口径未经 ADR 批准**，见文件头与报告）', () => {
  it("'due'：期限升序、无期限的排最后，同级回落智能序", () => {
    const items = build([
      { id: taskId(1), dueDate: '2026-10-01' },
      { id: taskId(2) }, // 无期限 → 最后
      { id: taskId(3), dueDate: '2026-09-23' },
    ])
    expect(sortItems(items, TODAY, 'due').map((item) => item.taskId)).toEqual([taskId(3), taskId(1), taskId(2)])
  })

  it("'created'：创建时间升序", () => {
    const items = build([
      { id: taskId(1), createdAt: '2026-09-05T09:00:00+08:00' },
      { id: taskId(2), createdAt: '2026-09-01T09:00:00+08:00' },
    ])
    expect(sortItems(items, TODAY, 'created').map((item) => item.taskId)).toEqual([taskId(2), taskId(1)])
  })

  it("'importance'：重要性降序，同级回落智能序", () => {
    const items = build([
      { id: taskId(1), importance: 'low', plannedDate: TODAY },
      { id: taskId(2), importance: 'high', plannedDate: NEXT_MONDAY },
      { id: taskId(3), importance: 'high', plannedDate: TODAY },
    ])
    expect(sortItems(items, TODAY, 'importance').map((item) => item.taskId)).toEqual([
      taskId(3), // high + 今天（同 importance 时智能序在前）
      taskId(2), // high + 下周一
      taskId(1), // low
    ])
  })
})
