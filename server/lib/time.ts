/**
 * 时间戳格式化的唯一出口。
 *
 * ADR-008 §1：全部时间戳为 ISO 8601 带时区偏移的字符串（如 2026-09-21T14:03:00+08:00）。
 * 秒精度、不带毫秒——与 ADR 正文示例逐字符同形。
 *
 * 时刻比较一律走 Date.parse 得到的毫秒数，**不用字符串比较**：
 * 带偏移的 ISO 串只在偏移恒定时才字典序可比，跨 DST 换偏移就会出错。
 *
 * ## 三个渲染口径，别用错（ADR-010 §1）
 *
 * §1 的判据是**这一行是否需要「可复算的归属日」**——据此把持久化列分成两类，各有各的口径：
 *
 * - `toIsoInZone(date, timeZone)`：**事件列一律用它**，偏移取自该行 `timezone` 列。
 *   事件行需要归属日（`day_key` + `day_start_hour` 必须能由 `occurred_at` + `timezone` 复算）。
 *   **定义在 `shared/time`（ADR-009 §9），本文件只是转发**——服务端各处仍从这里 import，
 *   为的是让「服务端的渲染出口」有唯一一个可审计的位置；实现全模块只有那一份；
 * - `toIsoUtc(date)`：**账号域列一律用它**（`users` / `sessions` / `invites` 的全部时间列）。
 *   账号域只记「某瞬间发生过某事」，没有归属日可言，因而取 UTC——它不是「另一种时区选择」，
 *   而是无歧义的那一个：绝对时刻本身，与运行环境、与任何设置都无关；
 * - `toIso(date)`：进程本机时区。**不得用于任何持久化列**——进程时区一旦落进库里，
 *   这一列就随部署环境漂移，「为什么是这个值」不可复算。仅留给日志/内存态/测试对照。
 */

// ADR-009 §9：「瞬间 → 某时区墙钟」全模块**唯一落点**在 `shared/time`。
// 曾经的临时越界（暂借 `@shared/time/internal` 的 `offsetMsAt`、在本文件里渲染）已撤除：
// 现在这里是**转发**，不是第二份实现——本文件不再拥有任何时区知识，
// 连「墙钟分量怎么算」都不再自己拼（ADR-009 §1「任何一侧不得复制实现」）。
import { toIsoInZone } from '@shared/time'

export { toIsoInZone }

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * 把 Date 格式化为带**本机时区**偏移的 ISO 8601（秒精度）。
 *
 * ⚠️ **不得用于任何持久化列**（ADR-010 §1：进程时区不进入持久化数据）——事件行用
 * `toIsoInZone(date, 该行 timezone 列)`，账号域列用 `toIsoUtc(date)`。
 * 本函数只剩两类用途：日志/内存态这类不落库的值，以及测试里**当对照物**
 * （`checkin-service.test.ts` 用它证明事件偏移确实没跟着进程走）。
 * 它曾经是「当前时刻」的通用渲染器（`nowIso()` / `isoAfterMs()`），那对入口已随
 * 账号域改 UTC 一并删除：**没有调用方，就没有下次误用的机会**。
 */
export function toIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  )
}

/**
 * 把 Date 格式化为 **UTC 口径**的 ISO 8601（秒精度，偏移写 `+00:00` 而不是 `Z`）。
 *
 * ADR-010 §1（阶段 3 独立验证后的收窄）：**账号域列一律 UTC**——`users` / `sessions` /
 * `invites` 的时间列只表达绝对时刻，没有归属日，故不需要（也不该）绑任何时区。
 * 判据同 §1：该行是否需要「可复算的归属日」。
 *
 * 实现上**复用 `toIsoInZone` 而不是另写一份**：渲染只有一份，
 * 省得「UTC 那版」和「时区那版」在某个边界上悄悄分叉（ADR-009 §1 的同一条道理）。
 * 走一次 `offsetMsAt(.., 'UTC')` 的开销可以忽略——写入路径本来就在等磁盘。
 * 越界（年域 0001–9999 之外、或 Invalid Date）由它按 §9 抛 `RangeError`。
 */
export function toIsoUtc(date: Date): string {
  return toIsoInZone(date, 'UTC')
}

/** 当前时刻的 ISO 8601，**UTC 口径**。账号域时间列用它（ADR-010 §1）。 */
export function nowIsoUtc(): string {
  return toIsoUtc(new Date())
}

/** 当前时刻 + n 毫秒的 ISO 8601，**UTC 口径**。 */
export function isoAfterMsUtc(ms: number): string {
  return toIsoUtc(new Date(Date.now() + ms))
}

/** 给定的 ISO 串是否已到期（无法解析视为已到期，宁可要求重新登录）。 */
export function isExpired(iso: string, nowMs: number = Date.now()): boolean {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return true
  return parsed <= nowMs
}
