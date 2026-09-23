import type { Db } from '../db/connection.js'
import { toIsoInZone, today as accountToday } from '@shared/time'
import type { DayKey } from '@shared/time'
import { appendEvents } from '../events/append.js'
import { NOTE_UPDATED_TYPE } from '../events/definitions/notes.js'
import { readProjection } from '../events/projection-store.js'
import { loadAccountSettings, timeContextOf } from '../events/settings.js'
import { assertInTransaction } from '../events/transaction.js'

/**
 * 每日备注（ADR-017 §6，ADR-012 §1 的推迟项）。
 *
 * ## 两条不变的语义
 *
 * 1. **无到达也可以备注**（§6 的裁决）：FR1 有「休息日」，而人恰恰在没去实验室的日子
 *    才更需要写一句（「发烧在家」「外出开会」）。**要求先打卡才能备注，等于把这个功能
 *    从最需要它的场景里拿掉**。故备注落在**独立的 `day_notes` 表**，`days` 一行都不建
 *    ——两条不变式（「无行 ⇔ 无到达」与「有备注」）各自成立、互不干扰；
 * 2. **`text` 为空串即清除**（§6，与 ADR-013 §1「能用一个值表示的状态不要用两个」一致）：
 *    不引入 `null`，重放时空串即删除该行。
 *
 * ## 备注是「关于某一天」的，不是「某一天写的」
 *
 * 载荷里的 `dayKey` 是**被备注的那一天**（可以是过去任意一天）；而**事件行**的
 * `day_key` 是这次写入动作的归属日（今天）——两者是不同的东西，故事件行的两列由
 * 本模块按账号设置折算后显式给出，**不拿载荷里的 `dayKey` 去当归属日**。
 */

/** 对外的备注形态（ADR-017 §1.4）。无备注 = 空串，不是 `null`。 */
export interface DayNote {
  dayKey: DayKey
  text: string
}

/** `GET /api/checkin/days/:dayKey/note` —— **没有备注时返回空串**（不是 404：空备注是一个状态，不是缺失）。 */
export function getNote(db: Db, accountId: string, dayKey: DayKey): DayNote {
  const row = readProjection(db, accountId).dayNotes.find((note) => note.dayKey === dayKey)
  return { dayKey, text: row === undefined ? '' : row.text }
}

/**
 * `PUT /api/checkin/days/:dayKey/note` —— 设置或清除。
 *
 * **不因为「文本没变」而跳过写入**：`PUT` 的语义是「把它设成这个值」，
 * 而备注的 `updatedAt` 正是「最后一次确认」的时刻——它与勾选（`toggleStep`
 * 在状态一致时不写事件）不同：那里记的是**布尔状态的变化**，这里记的是**一次赋值的发生**。
 */
export function putNote(
  db: Db,
  accountId: string,
  now: Date,
  dayKey: DayKey,
  text: string,
): DayNote {
  assertInTransaction(db, '每日备注')
  const settings = loadAccountSettings(db, accountId)
  const occurredAt = toIsoInZone(now, settings.timeZone)

  appendEvents(db, accountId, [
    {
      type: NOTE_UPDATED_TYPE,
      occurredAt,
      payload: { dayKey, text },
      // 事件行的归属日 = **这次写入**的归属日（今天），不是被备注的那一天
      // ——ADR-001 §4 的「归属日写入时确定并固化」，对整条流水是同一个口径。
      dayKey: accountToday(timeContextOf(settings), now),
      dayStartHour: settings.dayStartHour,
    },
  ])

  return getNote(db, accountId, dayKey)
}
