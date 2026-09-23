import { z } from 'zod'
import { isDayKey } from '@shared/time'
import { defineEvent, type EventDefinition, type RegisteredDefinition } from '../types.js'

/**
 * `note/updated` —— 每日备注（ADR-017 §6，ADR-012 §1 的推迟项，阶段 4 登记）。
 *
 * | type | 载荷 | 施加到投影 |
 * |---|---|---|
 * | `note/updated` | `{ dayKey, text }` | upsert `day_notes` 行；`text === ''` 即删除该行 |
 *
 * ## 为什么是独立表，而不是 `days` 上的一列
 *
 * ADR-012 §1 当初删掉每日备注，反对的是「在 `days` 表上加一列 `note`」——那会让备注
 * **独立于到达**存在，从而建出一行「有备注、无到达」的 `days` 行，当场推翻 §2 的
 * 「**无行 ⇔ 无到达**」不变式（FR1 的休息日判定与 ADR-002 §3 的「打卡天数 = COUNT(*)」
 * 都建立在它上面）。
 *
 * **该理由不适用于独立表**：`days` 的行只由 `checkin/arrived` 建，`day_notes` 一行都不建，
 * 两条不变式各自成立、互不干扰。
 *
 * ## 为什么「无到达也可以备注」（ADR-017 §6 的裁决）
 *
 * FR1 有「休息日」，而人恰恰在没去实验室的日子才更需要写一句（「发烧在家」「外出开会」）。
 * **要求先打卡才能备注，等于把这个功能从最需要它的场景里拿掉**。
 *
 * ## 空串即清除
 *
 * `text` 为**空串即清除备注**（与 ADR-013 §1「能用一个值表示的状态不要用两个」一致，
 * 不引入 `null`）。重放时空串即删除该行，与 `settings` 的 `null` 处置同形——
 * 因而 `Projection.dayNotes` 里**不存在** `text` 为空串的元素。
 *
 * ## 无 `target`
 *
 * 载荷里的 `dayKey` 是**归属日**（一个日期值），不是某个实体的标识；
 * 打卡事件同样不声明 `target`（ADR-012 §1）——两者同源：这一天本身就是主键的一半，
 * 再往 `target_id` 里写一份就是同一事实的两个来源（ADR-010 §1 / §2）。
 */

export const NOTE_UPDATED_TYPE = 'note/updated'

export const noteUpdatedPayloadSchema = z
  .object({
    dayKey: z.string().refine(isDayKey, '必须是真实存在的日历日（零填充定宽 YYYY-MM-DD）'),
    text: z.string(),
  })
  .strict()

export type NoteUpdatedPayload = z.infer<typeof noteUpdatedPayloadSchema>

export const noteUpdatedDefinition: EventDefinition<NoteUpdatedPayload> = defineEvent({
  type: NOTE_UPDATED_TYPE,
  schema: noteUpdatedPayloadSchema,
  apply(projection, event) {
    const { dayKey, text } = event.payload
    const at = projection.dayNotes.findIndex(
      (note) => note.accountId === event.accountId && note.dayKey === dayKey,
    )

    if (text === '') {
      // 清除：删行。**事件本身保留**（撤销该批次后备注原样回来）——
      // 删除的是投影行，不是事实。
      if (at >= 0) projection.dayNotes.splice(at, 1)
      return
    }

    if (at >= 0) {
      const note = projection.dayNotes[at]!
      // 同一归属日再来一条备注：按 id 序折叠，**后者胜**（与所有事件的「后来者覆盖」一致）。
      note.text = text
      note.updatedAt = event.occurredAt
      return
    }
    projection.dayNotes.push({
      accountId: event.accountId,
      dayKey,
      text,
      updatedAt: event.occurredAt,
    })
  },
})

/** 阶段 4 登记的每日备注事件定义 */
export const noteEventDefinitions: readonly RegisteredDefinition[] = [noteUpdatedDefinition]
