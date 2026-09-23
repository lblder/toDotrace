/**
 * 归属层级派生的测试矩阵（ADR-016 §1 的判定表 + ADR-013 §后果「层级派生」那一行）。
 *
 * 「层级」不是一个字段，所以这里**没有任何「同步层级」的用例**——那正是派生要消灭的动作。
 * 下面的用例都是「改锚点 → 层级自己变」。
 */
import { describe, expect, it } from 'vitest'

import { ownershipLevelOf } from './index'
import type { Anchors } from './index'

/** 三锚点全空的基线：收件箱 */
const EMPTY: Anchors = { plannedDate: null, plannedWeek: null, projectId: null }

describe('四态各一例（ADR-016 §1 的判定表）', () => {
  it('plannedDate 非空 ⇒ day（周 / 项目锚点可以同时非空，日锚点在先）', () => {
    expect(ownershipLevelOf({ ...EMPTY, plannedDate: '2026-09-10' })).toBe('day')
    expect(ownershipLevelOf({ ...EMPTY, plannedDate: '2026-09-10', projectId: 'p-1' })).toBe('day')
  })

  it('plannedDate 空、plannedWeek 非空 ⇒ week', () => {
    expect(ownershipLevelOf({ ...EMPTY, plannedWeek: '2026-09-07' })).toBe('week')
    expect(ownershipLevelOf({ ...EMPTY, plannedWeek: '2026-09-07', projectId: 'p-1' })).toBe('week')
  })

  it('两个日期锚点都空、projectId 非空 ⇒ project', () => {
    expect(ownershipLevelOf({ ...EMPTY, projectId: 'p-1' })).toBe('project')
  })

  it('三者皆空 ⇒ unplaced（收件箱，**不是第四层**；ADR-013 §1 本来就允许 plannedDate 为 null）', () => {
    expect(ownershipLevelOf(EMPTY)).toBe('unplaced')
  })
})

describe('派生的意思：改锚点，层级自己变（没有第二个字段要同步）', () => {
  it('清空 plannedDate 后自动降到 plannedWeek（不是停在 day）', () => {
    const before: Anchors = { plannedDate: '2026-09-10', plannedWeek: '2026-09-07', projectId: null }
    expect(ownershipLevelOf(before)).toBe('day')
    expect(ownershipLevelOf({ ...before, plannedDate: null })).toBe('week')
  })

  it('继续清空 plannedWeek 后降到 projectId', () => {
    const a: Anchors = { plannedDate: null, plannedWeek: '2026-09-07', projectId: 'p-1' }
    expect(ownershipLevelOf(a)).toBe('week')
    expect(ownershipLevelOf({ ...a, plannedWeek: null })).toBe('project')
  })

  it('三个锚点依次清空：day → week → project → unplaced，一次一个动作', () => {
    const full: Anchors = { plannedDate: '2026-09-10', plannedWeek: '2026-09-07', projectId: 'p-1' }
    expect(ownershipLevelOf(full)).toBe('day')
    expect(ownershipLevelOf({ ...full, plannedDate: null })).toBe('week')
    expect(ownershipLevelOf({ ...full, plannedDate: null, plannedWeek: null })).toBe('project')
    expect(ownershipLevelOf(EMPTY)).toBe('unplaced')
  })
})

describe('判定细节', () => {
  it('判据是 `!== null` 而非真值判断：空串 projectId 仍是 project 层（写成 `if (a.projectId)` 会静默降级）', () => {
    // 空串不是合法 id，但本函数是纯派生、不做校验（锚点合法性由载荷 schema + 表 CHECK 两道管，
    // ADR-016 §1）。这里钉的是「非空判断用的是 `!== null`」——换一种写法就是静默行为改变。
    expect(ownershipLevelOf({ ...EMPTY, projectId: '' })).toBe('project')
    expect(ownershipLevelOf({ ...EMPTY, plannedWeek: '' })).toBe('week')
    expect(ownershipLevelOf({ ...EMPTY, plannedDate: '' })).toBe('day')
  })

  it('非法组合（plannedDate 与 plannedWeek 同时非空）按判定次序取 day —— 钉的是本次序，不是认可该组合', () => {
    // 该组合由载荷 `zod .superRefine` + `tasks` 表的 CHECK **两道**拒绝（ADR-016 §1），
    // 本函数不兜底（在派生里再判一次就成了第三份规则）。这条断言只锁住次序：
    // 若有人把判定次序调换，这里先红，而不是等前端显示成「周级」。
    expect(
      ownershipLevelOf({ plannedDate: '2026-09-10', plannedWeek: '2026-09-07', projectId: null }),
    ).toBe('day')
  })
})
