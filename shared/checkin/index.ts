/**
 * 打卡口径纯函数 —— ADR-012 §6。
 *
 * 放在 `shared/` 而非 `server/`，因为前端也要用，且阶段 6 的坚持度 P 会复用同一口径
 * （ADR-012 §6）。零依赖、纯函数、不读时钟（`today` 显式传入）——与 `shared/time` 同一套纪律。
 *
 * **一切日期运算经 `@shared/time`（`addDays` / `compareDayKey`），本模块不写日期折算。**
 *
 * ## `dayKeys` 的契约（ADR-012 §6 / §3）
 *
 * > 该账号**有到达记录**的日子，**已升序、已去重**。
 *
 * 唯一被保证的来源是 `SELECT day_key FROM days WHERE account_id = ? ORDER BY day_key`
 * （ADR-012 §2：每行必有 `arrived_at`，故「有行 ⇔ 有到达」；§3：`/api/checkin/days`
 * 返回 `dayKey` 升序）。
 *
 * **本实现不依赖顺序与去重**：三个函数都不读数组顺序，重复日按「一天算一天」计。
 * 因此该前置条件对本模块**不是正确性条件**，而是性能与来源说明——
 * 契约被违反时结果依然正确，只是调用方该去修上游。数组中的非法值一律**忽略**
 * （契约外输入不抛错：这些是读路径，写路径的保证由 §2 的结构约束守住，
 * 见 ADR-012 §2「把不变式做成结构」）。
 *
 * **标量参数**（`today` / `dk` / `from` / `to`）则一律把关：非法 DayKey 抛 `RangeError`，
 * 区间反向（`from > to`）同样抛 `RangeError`——标量错了是调用方的**语义错**，
 * 而数组里混进脏值是**脏数据**，两者处置不同（ADR-011 §4.1 的分类法）。
 */
import { addDays, compareDayKey, isDayKey } from '@shared/time'
import type { DayKey } from '@shared/time'

function assertDayKey(value: DayKey, name: string): void {
  if (!isDayKey(value)) {
    throw new RangeError(`${name} 不是合法 DayKey：'${String(value)}'`)
  }
}

/**
 * 当前连续打卡天数（ADR-012 §6 定义的口径）：
 *
 * - 今天**已**打卡 → 从今天往回数连续有记录的天数；
 * - 今天**未**打卡 → 从**昨天**往回数（今天还没过完，不该算断）；
 * - 昨天也没有 → `0`。
 *
 * 与 01 FR4.3「宽容式，断几天不毁掉全部」一致：否则每天零点一过 streak 就归零一次，
 * 界面会闪（ADR-012 §6 的理由）。
 *
 * @param dayKeys 有到达记录的日子，**已升序、已去重**（见模块头注释）
 * @param today 今日归属日，由调用方经 `shared/time` 折算后传入
 */
export function currentStreak(dayKeys: readonly DayKey[], today: DayKey): number {
  assertDayKey(today, 'today')
  const recorded = new Set<DayKey>(dayKeys)

  let cursor = today
  if (!recorded.has(cursor)) {
    cursor = addDays(today, -1)
    if (!recorded.has(cursor)) return 0
  }

  let streak = 0
  while (recorded.has(cursor)) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

/**
 * 该归属日是否为休息日。
 *
 * 口径是**结构性的**（ADR-002 §3 / ADR-012 §5）：该 `dayKey` 下**没有到达记录** ⇔ 休息日。
 *
 * **未来日期一律返回 `false`**（ADR-012 §6）：未来日不是「休息」，是**尚未到达**。
 * 因此 `false` **不是**「那天将是工作日」的断言，而是「现在无法断言」——
 * 它同时覆盖「有记录」与「尚未到达」两种情形（同一个返回值、两种含义）。
 * 要区分**空白 / 未到 / 休息**这三态，由**调用方自己拿 `today` 比对**。
 *
 * @param dayKeys 有到达记录的日子，**已升序、已去重**（见模块头注释）
 * @param dk 待判定的归属日
 * @param today 今日归属日，由调用方经 `shared/time` 折算后传入；晚于它的 `dk` 不予判定
 */
export function isRestDay(dayKeys: readonly DayKey[], dk: DayKey, today: DayKey): boolean {
  assertDayKey(dk, 'dk')
  assertDayKey(today, 'today')
  if (compareDayKey(dk, today) > 0) return false // 未来日：尚未到达，无法断言
  return !dayKeys.includes(dk)
}

/**
 * 闭区间 `[from, to]` 内的打卡天数（与 SQL `BETWEEN` 同口径，两端都含）。
 *
 * **`from > to` 抛 `RangeError`**，不返回 `0`：ADR-012 §3 点名要避免
 * 「静默返回空会让调用方以为那段时间没打卡」。返回 `0` 时，路由层一旦漏检，
 * 那个 `0` 就会冒充「那段时间没打卡」；抛错使**这条路径根本不存在**，
 * 路由层的 `400` 因此不再是这条不变式的唯一守卫。
 *
 * 按 ADR-011 §4.1 的分类，标量参数非法属**编程 / 输入错误**，
 * 用内建类型抛错、不入域错误表——与非法 DayKey 同类。
 *
 * @param dayKeys 有到达记录的日子，**已升序、已去重**（见模块头注释）
 * @param from 区间起点（含）
 * @param to 区间终点（含）
 * @throws RangeError 当 `from > to`（闭区间为空）
 */
export function countCheckins(dayKeys: readonly DayKey[], from: DayKey, to: DayKey): number {
  assertDayKey(from, 'from')
  assertDayKey(to, 'to')
  if (compareDayKey(from, to) > 0) {
    throw new RangeError(`from (${from}) 晚于 to (${to})：闭区间为空，不是「这段时间没打卡」`)
  }

  const seen = new Set<DayKey>()
  let count = 0
  for (const dk of dayKeys) {
    if (seen.has(dk)) continue // 契约保证已去重；此处再兜一层，使「一天算一天」与另两个函数一致
    seen.add(dk)
    if (!isDayKey(dk)) continue // 契约外元素：忽略，不参与计数也不抛错
    if (compareDayKey(dk, from) >= 0 && compareDayKey(dk, to) <= 0) count += 1
  }
  return count
}
