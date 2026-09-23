/**
 * 项目周期与三层归属 —— ADR-016 的 `shared/` 层。
 *
 * 两个文件分工（ADR-015 §后果 说明了它与 `shared/tasks/` 的分工，不是重复）：
 * - `ownership.ts`：**这条任务归在哪一层**（由锚点派生，不落库）；
 * - `project.ts`：**项目这个自建区间怎么算**（闭区间、DayKey 坐标、可重叠）。
 *
 * 零依赖、纯函数：只经 `@shared/time` 取日期原语，本模块不写日期折算、
 * 不读时钟（`today` 显式传入）、不做时刻 ↔ 日期折算（见 `./project` 文件头）。
 */
export type { Anchors, OwnershipLevel } from './ownership'
export { ownershipLevelOf } from './ownership'

export type { ProjectInterval, ProjectWithId } from './project'
export {
  covers,
  daysOfProject,
  daysOfWeekInProject,
  projectState,
  projectsOfDay,
  weeksOfProject,
} from './project'
