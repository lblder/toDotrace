/**
 * 重复规则的可读文案（`RecurrenceRule` → 中文）。
 *
 * 只在**展示**处使用：编辑用的是结构化控件（选择 `freq` / `interval` / `by*`），
 * 不从这段文字反解规则——从文案反解就是第二套解析器。
 */
import type { RecurrenceRule } from '@shared/recurrence'

/** `0 = 周一 … 6 = 周日`（ADR-011 的唯一口径，**不是** `Date.getUTCDay()` 的 0=周日） */
export function weekdayText(index: number): string {
  return ['一', '二', '三', '四', '五', '六', '日'][index] ?? '?'
}

export const WEEKDAY_OPTIONS: readonly { readonly index: number; readonly label: string }[] = [
  { index: 0, label: '一' },
  { index: 1, label: '二' },
  { index: 2, label: '三' },
  { index: 3, label: '四' },
  { index: 4, label: '五' },
  { index: 5, label: '六' },
  { index: 6, label: '日' },
]

/**
 * 编辑器的频率选项。
 *
 * ⚠️ **`byDayOfWeek` / `byMonthDay` 只在对应的 `freq` 下可选**（ADR-011 §2）：
 * 「每周三」不是「每月 + 星期几」。界面因此不给一个「星期几」的多选摆在那里
 * 让用户以为是通用的——它在别的频率下会被服务端的 `validateRule` 拒绝。
 */
export const FREQ_OPTIONS: readonly { readonly value: RecurrenceRule['freq']; readonly label: string }[] =
  [
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每周' },
    { value: 'monthly', label: '每月' },
    { value: 'yearly', label: '每年' },
  ]

/** `每天` / `每 2 周周一` / `每月31 号` —— 措辞与 ADR-014 §7 的表格逐条对应 */
export function describeRule(rule: RecurrenceRule): string {
  const every = rule.interval === 1 ? '每' : `每 ${rule.interval} `
  switch (rule.freq) {
    case 'daily':
      return `${every}天`
    case 'weekly': {
      const days = rule.byDayOfWeek
      if (days === undefined || days.length === 0) return `${every}周`
      return `${every}周${days.map(weekdayText).join('、')}`
    }
    case 'monthly': {
      const days = rule.byMonthDay
      // 间隔为 1 时「每月」是固定词，不写成「每个月」（后者读起来像「每一个月」的强调）
      const unit = rule.interval === 1 ? '每月' : `${every}个月`
      if (days === undefined || days.length === 0) return unit
      return `${unit}${days.map((day) => (day === -1 ? '月末' : `${day} 号`)).join('、')}`
    }
    case 'yearly':
      // `yearly` 没有 `BY*` 时命中日取 `startsOn` 的月日（ADR-011 §2），
      // 故「哪一天」不由规则表达，而是由 `startsOn` 表达——这里只说到「年」为止。
      return `${every}年`
  }
}
