/**
 * 任务界面里所有的日期呈现。
 *
 * 两条纪律：
 * 1. **不得自己拼日期串**（ADR-009 §6）：绝对日期一律经 `describeDay` / `describeWeek`
 *    （内部只调 `formatDayKey` / `formatWeek`）；
 * 2. **粒度必须跟着用户给的粒度走**（ADR-014 §4.3）：周级锚点显示成
 *    「计划日 9月28日(周一)」是**用一个错的粒度**回答用户的输入，比不显示更糟。
 *    故 `describeWeek` 与 `describeDay` **不可互相代用**，这里也不给它们做统一包装。
 */
import { diffDays } from '@shared/time'
import type { DayKey } from '@shared/time'
import { describeDay, describeWeek } from '@shared/quickadd'

/**
 * 相对提示词（`(今天)` / `(明天)` / `(3 天后)`）。
 *
 * **它不属于 `describeDay`**：那个函数的输出必须与 `formatWeek` 一样**确定**
 * （不随宿主 locale 变化），而相对词是**调用方的措辞**（ADR-014 §1 的注释）。
 * 两者拼在一起，绝对日期在前、相对词在括号里——用户的裁决 5 要的正是这个形状。
 */
export function relativeHint(dk: DayKey, today: DayKey): string {
  const days = diffDays(today, dk)
  switch (days) {
    case 0:
      return '今天'
    case 1:
      return '明天'
    case 2:
      return '后天'
    case 3:
      return '大后天'
    case -1:
      return '昨天'
    case -2:
      return '前天'
    default:
      return days > 0 ? `${days} 天后` : `${-days} 天前`
  }
}

/** `9月23日(明天)` —— 绝对日期 + 相对提示（相对词与 `today` 同为当年时也照给） */
export function describeDate(dk: DayKey, today: DayKey): string {
  return `${describeDay(dk, today)}(${relativeHint(dk, today)})`
}

/** `计划周 9月28日那一周` 里的那一半（粒度是**周**，不折算成周一那一天） */
export function describePlannedWeek(weekStart: DayKey): string {
  return describeWeek(weekStart)
}


