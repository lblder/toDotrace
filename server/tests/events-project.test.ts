import { describe, expect, it, vi } from 'vitest'
import { ANCHOR_TYPE, REVOKE_TYPE } from '../events/definitions/system.js'
import { project } from '../events/project.js'
import { listRegisteredTypes } from '../events/registry.js'
import type { Event, Projection } from '../events/types.js'

/**
 * `project()` 的纯函数性与边界机制（ADR-010 §4）。
 *
 * 本文件**不建数据库**：`project()` 的前提就是「只吃一个事件数组」，
 * 若它哪天开始读库，这里会立刻红。
 */

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'

/** 递增的合法 UUIDv7：测试用它精确控制折叠顺序（排序键就是 id）。 */
let counter = 0
function nextId(): string {
  counter += 1
  return `${counter.toString(16).padStart(8, '0')}-0000-7000-8000-000000000000`
}

function event(overrides: Partial<Event> & Pick<Event, 'id' | 'type' | 'batchId'>): Event {
  return {
    accountId: ACCOUNT,
    occurredAt: '2026-09-22T10:00:00+08:00',
    timezone: 'Asia/Shanghai',
    dayKey: '2026-09-22',
    dayStartHour: 4,
    targetKind: null,
    targetId: null,
    payload: {},
    appendedAt: '2026-09-22T10:00:00+08:00',
    ...overrides,
  }
}

function templateCreated(batchId: string, templateId: string, title: string, id = nextId()): Event {
  return event({
    id,
    type: 'recurrence/template-created',
    batchId,
    targetKind: 'recurrence_template',
    targetId: templateId,
    payload: {
      templateId,
      title,
      rule: { freq: 'daily', interval: 1 },
      nextAnchorMode: 'catch_up',
      startsOn: '2026-09-22',
    },
  })
}

function templateUpdated(batchId: string, templateId: string, title: string, id = nextId()): Event {
  return event({
    id,
    type: 'recurrence/template-updated',
    batchId,
    targetKind: 'recurrence_template',
    targetId: templateId,
    payload: {
      templateId,
      title,
      rule: { freq: 'weekly', interval: 2 },
      nextAnchorMode: 'extend',
      startsOn: '2026-09-01',
    },
  })
}

function revoke(batchId: string, targetBatchId: string, id = nextId()): Event {
  return event({
    id,
    type: REVOKE_TYPE,
    batchId,
    payload: { targetBatchId },
  })
}

function anchor(batchId: string, id = nextId()): Event {
  return event({
    id,
    type: ANCHOR_TYPE,
    batchId,
    payload: { sourceFile: 'backup.json', overwrittenCount: 3, previousHeadId: null },
  })
}

function settingsUpdated(
  batchId: string,
  payload: { timeZone: string; dayStartHour: number },
  id = nextId(),
): Event {
  return event({
    id,
    type: 'settings/updated',
    batchId,
    occurredAt: '2026-09-22T09:00:00+08:00',
    payload,
  })
}

function titles(projection: Projection): string[] {
  return projection.templates.map((template) => template.title)
}

describe('project() 是纯函数（ADR-010 §4 硬约束）', () => {
  it('同一流水两次重放结果逐字段一致', () => {
    const events = [
      templateCreated('b1', 't1', '每天喝水'),
      templateCreated('b1', 't2', '每周复盘'),
      templateUpdated('b2', 't1', '每天喝八杯水'),
    ]
    expect(project(events)).toEqual(project(events))
  })

  it('输入顺序无关（同一份事件集必得同一状态）', () => {
    const events = [
      templateCreated('b1', 't1', 'A'),
      templateCreated('b1', 't2', 'B'),
      templateUpdated('b2', 't1', 'A2'),
      revoke('b3', 'b1'),
    ]
    const forward = project(events)
    const backward = project([...events].reverse())
    const shuffled = project([events[2]!, events[0]!, events[3]!, events[1]!])
    expect(backward).toEqual(forward)
    expect(shuffled).toEqual(forward)
  })

  it('不修改入参：冻结的数组与事件对象也能重放', () => {
    const events = Object.freeze([
      Object.freeze(templateCreated('b1', 't1', 'A')),
      Object.freeze(templateCreated('b1', 't2', 'B')),
    ])
    expect(() => project(events)).not.toThrow()
    expect(titles(project(events))).toEqual(['A', 'B'])
  })

  it('不读时钟：系统时间相差一年，结果相同', () => {
    vi.useFakeTimers()
    try {
      const events = [templateCreated('b1', 't1', 'A')]
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
      const first = project(events)
      vi.setSystemTime(new Date('2021-06-15T12:34:56Z'))
      const second = project(events)
      expect(second).toEqual(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('不读时钟：重放过程一次都没有调用 Date.now()', () => {
    const spy = vi.spyOn(Date, 'now')
    try {
      project([templateCreated('b1', 't1', 'A'), anchor('b2')])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('空流水 → 空投影；设置是 null 而不是「默认值」', () => {
    // 填默认值就得读服务端时区（`serverTimeZone()`），`project()` 当场不再是纯函数。
    // 「缺设置时用哪个时区」属于读取方（`loadAccountSettings`）的回落策略。
    expect(project([])).toEqual({ templates: [], settings: null })
  })
})

describe('设置投影（ADR-010 §3 的 Projection.settings）', () => {
  it('settings/updated 折叠成 settings 键，updatedAt 取自事件的 occurredAt', () => {
    const setting = settingsUpdated('b1', { timeZone: 'Asia/Shanghai', dayStartHour: 4 })
    expect(project([setting]).settings).toEqual({
      accountId: ACCOUNT,
      timeZone: 'Asia/Shanghai',
      dayStartHour: 4,
      updatedAt: '2026-09-22T09:00:00+08:00',
    })
  })

  it('没有设置事件时是 null（不编造）', () => {
    const created = templateCreated('b1', 't1', 'A')
    expect(project([created]).settings).toBeNull()
  })

  it('多条设置事件按 id 序折叠，后者整行覆盖前者', () => {
    const early = settingsUpdated('b1', { timeZone: 'Asia/Shanghai', dayStartHour: 4 }, '00000001-0000-7000-8000-000000000000')
    const late = settingsUpdated('b2', { timeZone: 'America/New_York', dayStartHour: 0 }, '00000002-0000-7000-8000-000000000000')
    expect(project([late, early]).settings).toEqual({
      accountId: ACCOUNT,
      timeZone: 'America/New_York',
      dayStartHour: 0,
      updatedAt: '2026-09-22T09:00:00+08:00',
    })
  })

  it('设置事件不产生模板行', () => {
    expect(titles(project([settingsUpdated('b1', { timeZone: 'Asia/Shanghai', dayStartHour: 4 })]))).toEqual([])
  })

  /**
   * 覆盖面**包含了设置事件**：ADR-004 的语义是「锚点之前的全部事件视同没发生过」，
   * 设置事件也在这条线的前面，于是锚点之后 settings 键为 null。
   *
   * 这不是 bug，是覆盖面语义的直接推论，但它有一条**必须传给阶段 5 的后果**：
   * 覆盖导入的文件若不含设置事件，重建后设置行会消失，读取回落默认值
   * （服务端时区 + DEFAULT_DAY_START_HOUR）——即覆盖导入必须把设置事件一并导出/导入，
   * 否则「换机迁移后时区被重置」会以「看不出哪一步错了」的形式浮现。
   */
  it('锚点之前的设置事件不参与折叠（覆盖面语义，代价见上方注释）', () => {
    const setting = settingsUpdated('b1', { timeZone: 'Asia/Shanghai', dayStartHour: 4 })
    const anchorEvent = anchor('b2')
    const after = settingsUpdated('b3', { timeZone: 'UTC', dayStartHour: 0 })
    expect(project([setting, anchorEvent, after]).settings).toMatchObject({ timeZone: 'UTC' })
    expect(project([setting, anchorEvent]).settings).toBeNull()
  })
})

describe('排序键唯一地是 id（ADR-001 §2）', () => {
  it('同一模板的两次更新，id 大者胜出——与数组顺序、批次顺序无关', () => {
    const created = templateCreated('b1', 't1', '原名')
    const earlier = templateUpdated('b2', 't1', '早的更新')
    const later = templateUpdated('b9', 't1', '晚的更新')
    expect(titles(project([created, later, earlier]))).toEqual(['晚的更新'])
    expect(titles(project([later, created, earlier]))).toEqual(['晚的更新'])
  })

  it('batch_id 不参与排序：批次标识逆序也得到同一结果', () => {
    const created = templateCreated('b-zzzz', 't1', '原名')
    const update = templateUpdated('b-aaaa', 't1', '更新后')
    expect(titles(project([created, update]))).toEqual(['更新后'])
  })
})

/**
 * 覆盖面（ADR-004 / ADR-010 §4）。
 *
 * ⚠️ **不要把「锚点所在批次可被撤销」当成 bug 去修**（ADR-006 §3）：
 * 覆盖面与撤销在重放层**共用「先扫描出待跳过集合、再 fold」的实现**（本文件第 1 步的两段扫描），
 * 但在文档与界面上是两件事，**不得互相替代**——覆盖面是导入模式的固有语义，
 * 撤销是用户对任一动作的补救。锚点所在批次可以像任何批次一样被撤销：
 * 撤销的是「那次覆盖导入」这个**动作**，而覆盖面的消失应走**再覆盖一次**（带新快照），
 * 不是靠撤销去「恢复旧数据」——被覆盖的事件从未离开流水，只是不参与折叠。
 */
describe('第 1 步：覆盖面（ADR-004 / ADR-010 §4）', () => {
  it('只折叠最后一条锚点之后的事件，锚点自身也不参与折叠', () => {
    const before = templateCreated('b1', 't1', '锚点前')
    const anchorEvent = anchor('b2')
    const after = templateCreated('b2', 't2', '锚点后')
    expect(titles(project([before, anchorEvent, after]))).toEqual(['锚点后'])
  })

  it('多条锚点时取 id 最大的那条，而不是数组里的最后一条', () => {
    const first = templateCreated('b1', 't1', '第一纪元')
    const anchor1 = anchor('b2')
    const second = templateCreated('b3', 't2', '第二纪元')
    const anchor2 = anchor('b4')
    const third = templateCreated('b5', 't3', '第三纪元')

    // 顺序打乱：anchor1 排在数组最后，但 id 小于 anchor2
    const projection = project([first, second, anchor2, third, anchor1])
    expect(titles(projection)).toEqual(['第三纪元'])
  })

  it('锚点之前的事件物理保留在输入里（只是不参与折叠）', () => {
    const before = templateCreated('b1', 't1', '锚点前')
    const events = [before, anchor('b2')]
    expect(events).toHaveLength(2)
    expect(titles(project(events))).toEqual([])
  })
})

describe('第 1 步：撤销（ADR-006 / ADR-010 §4）', () => {
  it('被撤销批次内的事件被跳过', () => {
    const created = templateCreated('b1', 't1', '将被撤销')
    const kept = templateCreated('b2', 't2', '保留')
    const revokeEvent = revoke('b3', 'b1')
    expect(titles(project([created, kept, revokeEvent]))).toEqual(['保留'])
  })

  it('撤销事件本身不可被撤销：指向撤销所在批次的 revoke 无效', () => {
    const created = templateCreated('b-x', 't1', '目标')
    const revokeX = revoke('b-r', 'b-x')
    const revokeR = revoke('b-q', 'b-r') // 试图撤销「撤销 b-x」这件事
    expect(titles(project([created, revokeX, revokeR]))).toEqual([])
  })

  it('revoke 不参与撤销集合的构建：自指不会无限递归，且被它指向的批次仍被跳过', () => {
    const created = templateCreated('b-self', 't1', '同批次')
    const selfRevoke = revoke('b-self', 'b-self')
    expect(titles(project([created, selfRevoke]))).toEqual([])
  })

  it('指向不存在批次的 revoke 是无害的空操作', () => {
    const created = templateCreated('b1', 't1', '保留')
    expect(titles(project([created, revoke('b2', 'no-such-batch')]))).toEqual(['保留'])
  })

  it('revoke 的 apply 是空操作：撤销本身不产生投影行', () => {
    const created = templateCreated('b1', 't1', 'A')
    expect(project([created, revoke('b2', 'b1')]).templates).toHaveLength(0)
  })
})

describe('系统事件（ADR-010 §7）', () => {
  it('两类系统事件都不写投影表', () => {
    const events = [anchor('b1'), revoke('b2', 'b3')]
    expect(project(events)).toEqual({ templates: [], settings: null })
  })

  it('系统事件已登记（否则 §2 的「未登记拒绝写入」与 §4 的边界扫描会互相打死）', () => {
    expect(listRegisteredTypes()).toContain(ANCHOR_TYPE)
    expect(listRegisteredTypes()).toContain(REVOKE_TYPE)
  })
})

describe('未登记类型与跨账号输入', () => {
  it('未登记的类型在重放时抛错（它无法被重放）', () => {
    const alien = event({ id: nextId(), type: 'task/created', batchId: 'b1' })
    expect(() => project([alien])).toThrow(/未登记的事件类型/)
  })

  it('混入第二个账号的事件时抛错，而不是静默产出跨账号状态', () => {
    const mine = templateCreated('b1', 't1', 'A')
    const theirs = { ...templateCreated('b2', 't2', 'B'), accountId: OTHER_ACCOUNT }
    expect(() => project([mine, theirs])).toThrow(/单个账号/)
  })
})

describe('模板数组的规范化顺序', () => {
  it('无论折叠顺序如何，templates 一律按模板 id 升序（增量与全量才可逐字段比对）', () => {
    const first = templateCreated('b1', 't-zzz', '后创建的')
    const second = templateCreated('b1', 't-aaa', '先创建的')
    expect(project([first, second]).templates.map((t) => t.id)).toEqual(['t-aaa', 't-zzz'])
  })
})
