/**
 * `state.ts` 的测试矩阵（ADR-013 §2 的迁移表 + §4.6 / §4.7 的完成与取消完成 + §3.2 的顺延禁令）。
 *
 * 这四条判据是**前端禁用按钮**与**服务端 409** 的共同来源（ADR-013 §后果：
 * 「不得在前端重写一份」），故每条都要断言到**错误码**，而不只是 true/false。
 */
import { describe, expect, it } from 'vitest'

import {
  STATUS_TRANSITIONS,
  TASK_STATUSES,
  canChangeStatus,
  canCompleteOccurrence,
  canRescheduleTask,
  canUncompleteOccurrence,
} from './state'
import { dailyRule } from './test-fixtures'

const openTask = { status: 'not_started', deletedAt: null } as const

describe('任务级状态迁移表（ADR-013 §2）', () => {
  it('表内每条合法边都能走', () => {
    expect(canChangeStatus({ from: 'not_started', to: 'in_progress', recurring: false })).toEqual({
      allowed: true,
      noop: false,
    })
    expect(canChangeStatus({ from: 'in_progress', to: 'not_started', recurring: false }).allowed).toBe(true)
    expect(canChangeStatus({ from: 'not_started', to: 'abandoned', recurring: false }).allowed).toBe(true)
    expect(canChangeStatus({ from: 'in_progress', to: 'abandoned', recurring: false }).allowed).toBe(true)
    expect(canChangeStatus({ from: 'abandoned', to: 'not_started', recurring: false }).allowed).toBe(true)
  })

  it('**`已完成 → 已放弃` 是同一条边**：任务级状态此时仍是未开始/进行中，放弃与完成态正交', () => {
    // 「已完成」不是任务级状态（TASK_STATUSES 里没有它）——这就是 §4 那张表
    // 把这一行单列的原因：标的是**入口**，不是多一条规则。
    expect(TASK_STATUSES).not.toContain('completed')
    expect(canChangeStatus({ from: 'not_started', to: 'abandoned', recurring: false }).allowed).toBe(true)
    // 反方向不存在：放弃了不能直接「完成」（完成不是任务级迁移，走 canCompleteOccurrence）
    expect(canChangeStatus({ from: 'abandoned', to: 'in_progress', recurring: false })).toMatchObject({
      allowed: false,
      code: 'conflict/status-transition',
    })
  })

  it('**重复任务的「进行中」不可达**（可达性约束，不是第二套状态机）', () => {
    expect(canChangeStatus({ from: 'not_started', to: 'in_progress', recurring: true })).toMatchObject({
      allowed: false,
      code: 'conflict/status-transition',
    })
    // 但「放弃」照常可达——重复任务借此**终止整个系列**（ADR-013 §2）
    expect(canChangeStatus({ from: 'not_started', to: 'abandoned', recurring: true }).allowed).toBe(true)
  })

  it('同值 = 允许但 `noop`（事件幂等，§4.4；界面据此置灰而不是报错）', () => {
    expect(canChangeStatus({ from: 'abandoned', to: 'abandoned', recurring: false })).toEqual({
      allowed: true,
      noop: true,
    })
    expect(canChangeStatus({ from: 'not_started', to: 'not_started', recurring: true })).toEqual({
      allowed: true,
      noop: true,
    })
  })

  it('迁移表是显式的（三元素各有自己的可达集，没有「任意到任意」的兜底）', () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual(['abandoned', 'in_progress', 'not_started'])
    expect(STATUS_TRANSITIONS.abandoned).toEqual(['not_started'])
  })
})

describe('完成 / 取消完成一个实例（ADR-013 §2 / §4.6 / §4.7）', () => {
  it('合法前提：未放弃、未删除、该实例尚未完成', () => {
    expect(canCompleteOccurrence({ task: openTask, instanceCompleted: false })).toEqual({
      allowed: true,
      noop: false,
    })
    expect(
      canCompleteOccurrence({
        task: { status: 'in_progress', deletedAt: null },
        instanceCompleted: false,
      }).allowed,
    ).toBe(true)
  })

  it('**已放弃的任务不可完成**（「不做了」之后允许完成 = 同一条任务既被放弃又被完成）', () => {
    expect(
      canCompleteOccurrence({ task: { status: 'abandoned', deletedAt: null }, instanceCompleted: false }),
    ).toMatchObject({ allowed: false, code: 'conflict/task-not-completable' })
  })

  it('已删除的任务不可完成（软删除行仍在，但不在任何视图里）', () => {
    expect(
      canCompleteOccurrence({
        task: { status: 'not_started', deletedAt: '2026-09-20T10:00:00+08:00' },
        instanceCompleted: false,
      }),
    ).toMatchObject({ allowed: false, code: 'conflict/task-not-completable' })
  })

  it('重复完成同一实例 → `conflict/occurrence-already-completed`（提示可先取消完成）', () => {
    const verdict = canCompleteOccurrence({ task: openTask, instanceCompleted: true })
    expect(verdict).toMatchObject({ allowed: false, code: 'conflict/occurrence-already-completed' })
    if (!verdict.allowed) expect(verdict.message).toContain('取消完成')
  })

  it('取消完成：未完成的实例被拒，已完成的放行（**不看任务是否已放弃**——放弃与完成态正交）', () => {
    expect(canUncompleteOccurrence({ instanceCompleted: false })).toMatchObject({
      allowed: false,
      code: 'conflict/occurrence-not-completed',
    })
    expect(canUncompleteOccurrence({ instanceCompleted: true })).toEqual({ allowed: true, noop: false })
  })

  it('「完成 → 取消 → 完成」在判据上是一条可反复走的路径（不抹除历史）', () => {
    // 第一次完成
    expect(canCompleteOccurrence({ task: openTask, instanceCompleted: false }).allowed).toBe(true)
    // 取消
    expect(canUncompleteOccurrence({ instanceCompleted: true }).allowed).toBe(true)
    // 再完成
    expect(canCompleteOccurrence({ task: openTask, instanceCompleted: false }).allowed).toBe(true)
  })
})

describe('顺延（ADR-013 §3.2）', () => {
  it('重复任务一律拒绝（日期由规则决定）', () => {
    expect(canRescheduleTask({ recurrence: dailyRule() })).toMatchObject({
      allowed: false,
      code: 'conflict/date-driven-by-rule',
    })
  })

  it('非重复任务放行', () => {
    expect(canRescheduleTask({ recurrence: null })).toEqual({ allowed: true, noop: false })
  })
})
