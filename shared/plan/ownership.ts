/**
 * 归属层级 —— ADR-016 §1（FR2.8「任务的归属层级创建时选择」的落地）。
 *
 * **层级不是存储字段，而是「哪个锚点非空」的函数。** 三层各有自己的锚点字段，
 * 互不共用（ADR-016 §1 的表）；把它另存成一个判别列就会有两个来源
 * （判别列与锚点），必须靠 CHECK 维持一致，而 CHECK 只挡数据库写入、
 * 还得在 zod 里再写一遍同样的约束——同一条约束写两遍，且两遍都可能漂移。
 * 派生让这条约束**根本不存在**。
 *
 * 位置：`shared/plan/` 而不是 `server/` 或 `src/`，理由同 `@shared/time` /
 * `@shared/recurrence`：服务端写入时要校验、前端渲染时要显示，
 * 两边各写一份就是两个真相。零依赖、纯函数——本文件不引任何东西运行时。
 *
 * ## 两条结构性互斥（**不是**本函数的职责）
 *
 * - `plannedDate` 与 `plannedWeek` **不得同时非空**（一次只排一层）；
 * - `plannedWeek` 若非空，**必须是一个周一**（自然周口径，ADR-009 §5）；
 * - 重复任务的三个锚点恒为 `null`（ADR-013 §3.1 + ADR-016 §7）。
 *
 * 三道都由**载荷 `zod .superRefine` + `tasks` 表的 CHECK** 两道挡住（ADR-016 §1 的表）。
 * 本函数**不做兜底**：`ownershipLevelOf` 是纯派生，按序取第一个非空锚点，
 * 非法组合的拒绝由上面两道负责——在这里再判一次就是第三份规则。
 */
import type { DayKey } from '@shared/time'

/** 01 FR2.8 的「归属层级」。**由锚点派生，不落库** —— 同一事实只有一个来源。 */
export type OwnershipLevel = 'day' | 'week' | 'project' | 'unplaced'

/** 三个锚点。互斥与规范化由载荷 schema + 表 CHECK 保证（见文件头） */
export interface Anchors {
  /** 日锚点：「打算哪天做」（ADR-013 §1）。周级任务恒为 null */
  plannedDate: DayKey | null
  /** 周锚点：「打算哪周做」。若非空，恒为该周周一（`weekStart` 规范化） */
  plannedWeek: DayKey | null
  /** 项目锚点：「属于哪个项目」，至多一个（ADR-013 §1） */
  projectId: string | null
}

/**
 * `unplaced`（未归层）**不是第四层**，它是「三个锚点都还没填」，即收件箱。
 * FR2.8 说的是三层**可选**，不是「必须属于其中一层」；而 ADR-013 §1 早已允许
 * `plannedDate: null`，这个状态本来就在契约里，本函数只是**给它一个名字**，
 * 而不是让它在三格之间二义。
 *
 * 判定次序即本文件顶部的三层表：日 → 周 → 项目 → 未归层。
 */
export function ownershipLevelOf(a: Anchors): OwnershipLevel {
  if (a.plannedDate !== null) return 'day'
  if (a.plannedWeek !== null) return 'week'
  if (a.projectId !== null) return 'project'
  return 'unplaced'
}
