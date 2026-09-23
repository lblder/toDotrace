/**
 * 项目周期（自建区间）的运算 —— ADR-016 §2 的六个原语。
 *
 * 位置：`shared/` 而不是 `server/` 或 `src/`，理由同 ADR-009 / ADR-011：
 * 服务端（项目进度统计、FR4.2 的「区间 = 项目」）与前端（项目视图、周标注）
 * 用的是同一份区间算术，两边各写一份就是两个真相——「同一口径不存在于两处」。
 *
 * 本模块是 ADR-009 最后一节「留待阶段 4」所指的那次定义（ADR-016 承接），
 * **但它不是第二份时间口径模块**：全部运算留在 `DayKey` 坐标上
 * （`compareDayKey` / `addDays` / `diffDays` / `weekStart`），
 * **不做任何时刻 ↔ 日期折算**。需要瞬间的地方（导出 iCalendar、
 * 与打卡时刻比）由调用方折，且必须按半开写（ADR-016 §8）。
 *
 * ## 两条口径，违反即整整差一天（ADR-016 §2 / §8）
 *
 * 1. **区间是闭区间 `[startsOn, endsOn]`，含两端**：用户输入「起止日期」的直觉
 *    就是含端点；起止同日 = 1 天项目，合法（FR2.8「长短完全自定义」）。
 *    `daysOfProject` 里那个 `+1` 是最容易漏的一处。
 * 2. **不绕道瞬间**：ADR-009 §7 已定 `dayEndInstant(dk)` 是**排他上界**，
 *    它返回的是**次日** `dayStartHour:00`。把上界瞬间反解回 DayKey 会得到
 *    `addDays(endsOn, 1)`——区间整整多出一天；反过来按包含式理解又会少一天。
 *    故本模块**不导入也不引用** `dayStartInstant` / `dayEndInstant` / `toDayKey`：
 *    这里没有瞬间这个坐标，也就不存在半开/闭区间的选择。
 *
 * ## 多个项目可以重叠（ADR-016 §2，明确允许）
 *
 * 一个人同时做两个课题是常态，禁止重叠会逼用户把日期改到不真实的位置。
 * 代价（如实记录）：重叠时「这个任务 / 这天属于哪个项目」**没有唯一答案**，
 * 因此系统不回答那个问题——它回答「属于哪些项目」，所以 `projectsOfDay` 返回**数组**。
 * 任何「取第一个 / 取最近一个」的规则都会在重叠时静默丢掉一个项目。
 */
import { addDays, compareDayKey, diffDays, weekStart as weekStartOf } from '@shared/time'
import type { DayKey } from '@shared/time'

/** 项目区间。**闭区间**：起止两端都算在项目内 */
export interface ProjectInterval {
  startsOn: DayKey
  /** 含。`endsOn < startsOn` 不可表达（`projects` 表的 CHECK 也是 `ends_on >= starts_on`） */
  endsOn: DayKey
}

/**
 * 带标识的项目行。
 *
 * 本模块只要求「区间 + id」两样，故 `ProjectWithId` 可以接收投影里字段更多的行
 * （结构子类型：`{ id, startsOn, endsOn, name, isCurrent, … }` 直接可传）。
 * `id` 参与 `projectsOfDay` 的排序，使它成为**全序**而非「大致有序」。
 */
export interface ProjectWithId extends ProjectInterval {
  readonly id: string
}

/**
 * 区间合法性：反向区间（起晚于止）抛 `RangeError`。
 *
 * 与 `@shared/checkin` 同一处置：**标量错了是调用方的语义错**，
 * 而反向区间在这里会安静地算出负数天数、空周列表一类无意义的结果。
 * 该状态在结构上也不可达（`projects` 表的 `CHECK (ends_on >= starts_on)`），
 * 所以这里只可能被「绕过了写入路径的数据」或调用方的拼接错误触发。
 * 顺带地，非法 DayKey 文本由 `compareDayKey` / `parseDayKey` 抛 `RangeError`。
 */
function assertInterval(p: ProjectInterval): void {
  if (compareDayKey(p.startsOn, p.endsOn) > 0) {
    throw new RangeError(
      `项目区间反向：startsOn '${p.startsOn}' 晚于 endsOn '${p.endsOn}'（区间是闭区间 [startsOn, endsOn]）`,
    )
  }
}

/**
 * 区间天数（**闭区间，含两端**）：`diffDays(startsOn, endsOn) + 1`
 * ——那个 `+1` 是最容易漏的一处（ADR-016 §2）。
 *
 * 起止同日 → 1，合法：FR2.8 说长短完全自定义，没有理由替用户划一条他不需要的下界。
 */
export function daysOfProject(p: ProjectInterval): number {
  assertInterval(p)
  return diffDays(p.startsOn, p.endsOn) + 1
}

/** 该日是否落在区间内（含两端）。边界：`covers(p, startsOn)` 与 `covers(p, endsOn)` 均为真 */
export function covers(p: ProjectInterval, dk: DayKey): boolean {
  assertInterval(p)
  return compareDayKey(p.startsOn, dk) <= 0 && compareDayKey(dk, p.endsOn) <= 0
}

/**
 * `(startsOn, id)` 的比较器。**是全序**（同 id 不可能出现两条），
 * 故结果与输入顺序无关——这正是「增量维护 == 全量重建」可以逐字段断言的前提。
 */
function compareByStartThenId(a: ProjectWithId, b: ProjectWithId): number {
  const byStart = compareDayKey(a.startsOn, b.startsOn)
  if (byStart !== 0) return byStart
  // id 是 ASCII 的规范 UUIDv7，码元序 === 字典序（与「id 序 === 时间序」同一套比较）
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * 该日属于的全部项目；按 `(startsOn, id)` **稳定排序**，使增量与全量重建结果可逐字段断言。
 *
 * 返回数组而非单个项目：项目区间允许重叠，重叠时「属于哪个项目」没有唯一答案
 * （理由见文件头）。**不返回 `undefined` / 不抛错**：没有项目覆盖该日就是空数组，
 * 那是一个正常状态，不是异常。
 *
 * 纯函数：不修改传入的数组（`filter` 已经产生新数组，`sort` 只作用于它）。
 */
export function projectsOfDay(ps: readonly ProjectWithId[], dk: DayKey): ProjectWithId[] {
  return ps.filter((p) => covers(p, dk)).sort(compareByStartThenId)
}

/**
 * 项目覆盖到的自然周（**周一的列表，升序**）。
 *
 * 首尾**通常是不完整的周**——这不是缺陷，是「周是固定格、项目是自建区间」的
 * 必然结果（ADR-016 §3）。故这些周只作**查询窗口与标注**，**不承担任何分母职责**：
 * 进度口径里没有「周」这个单位，首周只含 5 天时「算 1 周」会让分母虚高，
 * 「按 5/7 计」会引入用户无法从界面核对的分数。
 *
 * 用 `weekStart` / `addDays` 前进，**不绕道瞬间**：与 `@shared/time` 的自然周口径
 * 逐字一致（周一至周日，全系统唯一口径）。
 */
export function weeksOfProject(p: ProjectInterval): DayKey[] {
  assertInterval(p)
  const last = weekStartOf(p.endsOn)
  const weeks: DayKey[] = []
  for (let w = weekStartOf(p.startsOn); compareDayKey(w, last) <= 0; w = addDays(w, 7)) {
    weeks.push(w)
  }
  return weeks
}

/** 「周一」这一前置条件在此把关：非周一抛 `RangeError`，**不静默折算** */
function assertWeekStart(dk: DayKey): void {
  const monday = weekStartOf(dk) // 非法 DayKey 文本在这里抛 RangeError
  if (monday !== dk) {
    throw new RangeError(
      `weekStart 必须是周一（自然周口径，ADR-009 §5），实得 '${dk}'（所在周的周一是 '${monday}'）`,
    )
  }
}

/**
 * 该周有多少天落在项目区间内（**0–7**）。返回 7 即为完整的周。
 *
 * `weekStart` 必须是**周一**（`weeksOfProject` 的返回值就是）；
 * 给一个周中的日子会抛 `RangeError` 而不是按「它所在的那一周」静默折算——
 * 折算会让「本周」的含义取决于调用方是否记得先折周一，
 * 而这类静默差别正是本项目反复栽的形态。
 *
 * 逐日在 DayKey 坐标上判 `covers`（闭区间），**不折瞬间**：ADR-016 §8 已列明
 * `dayEndInstant` 是排他上界，折过去会把周与区间的交集整整算错一天。
 */
export function daysOfWeekInProject(p: ProjectInterval, weekStart: DayKey): number {
  assertInterval(p)
  assertWeekStart(weekStart)
  let count = 0
  for (let offset = 0; offset < 7; offset += 1) {
    if (covers(p, addDays(weekStart, offset))) count += 1
  }
  return count
}

/**
 * 派生状态，不落库（02 §4：派生量不作为可编辑数据存储）。
 *
 * `ended ⇔ today > endsOn`（ADR-016 §4）。**提前结束 / 延期 = 改 `endsOn`**，
 * 一条 `project/updated` 即可，不引入 `endedAt` / `archived` 之类的新字段——
 * 那会造出「endsOn 说 9/25、archived 说 9/10 结束」的第二真相。
 *
 * 边界：`today === startsOn` 与 `today === endsOn` 都是 `active`（闭区间）。
 */
export function projectState(p: ProjectInterval, today: DayKey): 'upcoming' | 'active' | 'ended' {
  assertInterval(p)
  if (compareDayKey(today, p.startsOn) < 0) return 'upcoming'
  if (compareDayKey(today, p.endsOn) > 0) return 'ended'
  return 'active'
}
