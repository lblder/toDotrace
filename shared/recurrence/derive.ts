/**
 * `deriveRounds` —— 给定模板、其完成事件、今天，算出该模板当前应存在的轮次（ADR-011 §4）。
 *
 * **纯函数**：不读时钟、不读库、不写库（ADR-007 §3 / ADR-010 §4）。「今日待办」因此
 * 仍是一条查询：可重复执行、无并发问题、服务长期不运行也不会欠生成轮次。
 *
 * 三条推导规则（§4）：
 *
 * 1. **已完成轮次**：来自 `completions`，**原样返回、永不重算**（ADR-007 §4）。
 *    它们是事实，模板被改被删都不影响（§7）——所以本函数**不校验**它们的日期是否
 *    仍落在当前规则的命中集合里，也**不**据当前规则改写它们；
 * 2. **待完成轮次至多一个**：以最近一次完成固化的 `nextAnchorDate` 为推进起点
 *    （无完成记录时用 `starts_on`），逐次前进，取**最后一个 ≤ `today`** 的日期；
 *    起点就在今天之后则没有待完成轮次。
 *    §4 已论证：展开成「30 天没做 → 30 条逾期」会让待办列表不可用，且与锚点②
 *    「追赶到今天之后」的意图直接冲突。「哪些天漏了」是阶段 6 统计与热力图的职责。
 * 3. **`count` / `until` 约束**：基准一律用**落库日**（由 `hitSequence` 统一施加，见 `hits.ts`）。
 */
import { compareDayKey, isDayKey } from '@shared/time'
import type { DayKey } from '@shared/time'

import { hitSequence } from './hits'
import { assertValidTemplate } from './rule'
import { AnchorInvariantError } from './types'
import type { RecurrenceTemplate, Round, RoundCompletion } from './types'

/**
 * 推导该模板当前应存在的轮次。
 *
 * 返回 = 已完成轮次（**按传入顺序原样**）+ 至多一条待完成轮次（追加在末尾）。
 */
export function deriveRounds(
  template: RecurrenceTemplate,
  completions: readonly RoundCompletion[],
  today: DayKey,
): Round[] {
  assertValidTemplate(template)
  if (!isDayKey(today)) {
    throw new RangeError(`today 必须是 'YYYY-MM-DD' 且真实存在的日历日，实得 '${String(today)}'`)
  }

  // 加载方必须填好 accountId（从事件行的 account_id 列取，ADR-010 §1）。
  // 漏填的后果是**静默**的：过滤会把每一条记录都判为「别人的」→ 历史轮次全部消失、
  // 只剩今天一条待办，而没有任何报错。按 §4 规则 4 / §4.1 的纪律（抛错而非静默），
  // 这里把它变成一声响。类型上该字段是必填的，但 JS 调用方与 `as` 断言挡不住
  // （与 `nextAnchorDate` 的 mode 守卫同理）。
  for (const completion of completions) {
    if (typeof completion.accountId !== 'string' || completion.accountId.length === 0) {
      throw new TypeError(
        `完成记录缺少 accountId（templateId='${String(completion.templateId)}'、` +
          `原计划日期='${String(completion.originalPlannedDate)}'）：加载方须从事件行的 account_id 列填。` +
          '放任为空会让账号过滤把该记录静默丢弃，表现为「历史轮次全部消失」而非报错。',
      )
    }
  }

  // 一条完成记录属于本模板，当且仅当 **templateId 与 accountId 同时相等**。
  //
  // 两个条件缺一不可：§1 的模板表主键是 `(account_id, id)`，**id 只在账号内唯一**——
  // ADR-005 允许「B 导入 A 导出的同一份文件」，两个账号会各持一份**同 id** 的模板副本。
  // 只比 templateId 的话，账号 B 的完成记录会被算进账号 A 的轮次，**且不报错**（账号隔离
  // 被破坏，正是 02 §3.2 要防的那类失败）。故 accountId 随记录一起流到这里、做**结构**过滤，
  // 而不是靠「调用方记得先按账号过滤」这种约定（主控 2026-09-22 裁决）。
  const mine = completions.filter(
    (completion) => completion.templateId === template.id && completion.accountId === template.accountId,
  )

  // 已完成轮次原样返回：字段照抄，**顺序也照传**（§4 规则 1）。
  // ADR 要求调用方按事件 id 序传入（§4「最近一次完成」的判据），故输出即重放序。
  const completed: Round[] = mine.map((completion) => ({
    templateId: completion.templateId,
    originalPlannedDate: completion.originalPlannedDate,
    status: 'completed' as const,
    completedDayKey: completion.completedDayKey,
    title: template.title, // 取自模板当前值，非快照（§4 / §7）
  }))

  // 「最近一次完成」= 事件 id 最大的那条（ADR-001 §2 的排序键）。
  // **不是**按 completedDayKey、更不是按数组顺序：跨设备合并与导入之后，
  // 「按事件 id 序」与「按完成日序」会给出不同答案，只有前者与重放排序一致。
  // 调用方须按该序传入，这里**再取一次最大值以防误用**（§4 明文要求）。
  //
  // ⚠️ 这行字符串比较依赖一个**跨模块的隐式性质**：id 的字符串形态必须可直接排序，
  // 即规范的 UUIDv7 小写连字符形式、定长 36 字符，使得「字典序 === 时间序」。
  // 若 id 变成变长 / 带前缀 / 大写，此处会**静默反向**（取到最早一次而非最近一次）
  // 且不报错。该性质已写进 ADR-001 的「约束」节并要求由生成器一侧的测试固化
  // （生成器在 server/lib/uuid.ts，不在本模块的文件边界内）；本模块这一侧由
  // derive.test.ts 的「UUIDv7 形态的 id」用例钉住。
  const head = mine.reduce<RoundCompletion | null>(
    (latest, completion) => (latest === null || completion.eventId > latest.eventId ? completion : latest),
    null,
  )

  if (head === null) {
    return pendingRoundFrom(template, template.startsOn, null, today, completed)
  }

  const start = head.nextAnchorDate
  // null = 规则已终止（达到 count / 越过 until），没有下一轮（§4）
  if (start === null) return completed

  // 固化值的自洽性：§5 的**锚点不变式**——锚点恒为尚不存在的轮次，严格晚于本轮计划日。
  // 不成立即说明载荷被写坏：典型来源是 §5 点名的那类标量加减缺陷（`P + I` 算出
  // `2026-02-31`），或上游把撞键的锚点写进了事件。§4.1 登记为 500，不得吞掉。
  if (compareDayKey(start, head.originalPlannedDate) <= 0) {
    throw new AnchorInvariantError(head.originalPlannedDate, start)
  }

  // 已完成轮次里**最大**的原计划日期：待完成轮次必须严格晚于它。
  // 依据是实例键 =（模板标识 + 原计划日期）（§4）——一条轮次不能既已完成又待完成，
  // 否则界面上会把刚做完的那一轮又列成待办。
  // 正常情形下 `start` 已经晚于它；只有在**补记历史**（head 是最近写入、但轮次很旧）
  // 时二者才会分叉，此时以下界较大者为准。
  const latestCompleted = mine.reduce<DayKey | null>(
    (max, completion) =>
      max === null || compareDayKey(completion.originalPlannedDate, max) > 0
        ? completion.originalPlannedDate
        : max,
    null,
  )

  return pendingRoundFrom(template, start, latestCompleted, today, completed)
}

/**
 * 从 `start` 起推进，取 `[start, today]` 内**严格晚于 `floor`** 的最后一个命中日，
 * 作为待完成轮次；没有则原样返回已完成轮次。
 */
function pendingRoundFrom(
  template: RecurrenceTemplate,
  start: DayKey,
  floor: DayKey | null,
  today: DayKey,
  completed: readonly Round[],
): Round[] {
  let pending: DayKey | null = null
  for (const hit of hitSequence(template.rule, template.startsOn)) {
    if (floor !== null && compareDayKey(hit, floor) <= 0) continue
    if (compareDayKey(hit, start) < 0) continue
    if (compareDayKey(hit, today) > 0) break
    pending = hit
  }
  if (pending === null) return [...completed]
  return [
    ...completed,
    {
      templateId: template.id,
      originalPlannedDate: pending,
      status: 'pending',
      title: template.title, // 取自模板当前值，非快照（§4 / §7）
    },
  ]
}
