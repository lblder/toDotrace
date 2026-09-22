import { z } from 'zod'
import { isDayKey } from '@shared/time'
import { validateTemplate, type RoundCompletion } from '@shared/recurrence'
import { defineEvent, type EventDefinition, type Event, type RegisteredDefinition } from '../types.js'
import type { ProjectedTemplate } from '../types.js'

/**
 * 重复任务的四类事件（ADR-011 §6）——阶段 2 登记项。
 *
 * | type | 载荷要点 | 施加到投影 |
 * |---|---|---|
 * | `recurrence/template-created` | 模板全部字段 | 插入 `recurrence_templates` 行 |
 * | `recurrence/template-updated` | 变更后的字段（含 `rule_json`、锚点模式） | 更新该行 |
 * | `recurrence/template-deleted` | **模板快照** | 删除该行 |
 * | `recurrence/round-completed` | 实例键 + 固化锚点 | **不写投影表**——轮次不落库 |
 *
 * 三条贯穿本文件的口径：
 *
 * 1. **载荷命名一律用 `templateId`**：ADR-011 §6 只显式命名了 round-completed 的
 *    `templateId`，其余三类写的是「模板全部字段 / 变更后的字段」，故统一取前者——
 *    同一个概念在四类载荷里两个名字，重放代码迟早会写错其中一个。
 * 2. **更新的载荷是「更新后的整行」而非差量**：差量只有在「创建事件一定先于它」时才
 *    拼得出完整行，而事件集合可能因撤销、合并导入而缺前半截。整行载荷让每一条更新
 *    事件自身就足以决定状态，重放与合并的可交换性都不依赖前置事件。
 * 3. **不写投影表的字段不编造**：`createdAt` / `updatedAt` 取自事件的 `occurred_at`
 *    （创建事件给两者、更新事件只改后者），载荷里不重复携带——表列与事件是同一份事实。
 *
 * 规则的合法性**不在这里重新定义**：结构（类型/形状）由本文件的 zod 把关，
 * 语义（`count`/`until` 互斥、范围、`freq` 相容）交给 `@shared/recurrence` 的
 * `validateRule` / `validateTemplate`——那是唯一一份规则校验（ADR-011 §2）。
 */

/** `target_kind` 常量（ADR-011 §6 要求模板事件同时写入 `target_id`） */
export const RECURRENCE_TEMPLATE_TARGET_KIND = 'recurrence_template'

/**
 * 四类事件共用的标识落点（ADR-010 §2 的 `EventDefinition.target`）。
 *
 * **只此一份**：四类载荷都带 `templateId`，落点规则就是「取它」。
 * 两列由 `appendEvents` 从载荷派生，调用方无从写错（见 `append.ts` 的 `prepareEvent`）——
 * 这正是把落点声明在定义上、而不是让每个调用方自己传 `targetId` 的理由。
 */
const templateTarget = {
  kind: RECURRENCE_TEMPLATE_TARGET_KIND,
  fromPayload: (payload: { templateId: string }): string => payload.templateId,
}

const anchorModeSchema = z.enum(['extend', 'catch_up', 'recompute'])

const ruleShape = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number(),
    byDayOfWeek: z.array(z.number()).optional(),
    byMonthDay: z.array(z.number()).optional(),
    count: z.number().optional(),
    until: z.string().optional(),
  })
  .strict()

/** 把 `@shared/recurrence` 的违规列表搬进 zod 的错误上下文（一处定义，两处使用）。 */
function addRuleIssues(
  value: { templateId: string; rule: unknown; nextAnchorMode: unknown; startsOn: unknown },
  ctx: z.RefinementCtx,
): void {
  const violations = validateTemplate({
    id: value.templateId,
    rule: value.rule,
    nextAnchorMode: value.nextAnchorMode,
    startsOn: value.startsOn,
  })
  for (const violation of violations) {
    ctx.addIssue({ code: 'custom', message: `${violation.path} ${violation.message}` })
  }
}

/** 模板的公共字段（四类载荷中三类共用） */
const templateFieldsShape = {
  templateId: z.string().min(1),
  title: z.string().min(1),
  rule: ruleShape,
  nextAnchorMode: anchorModeSchema,
  startsOn: z.string(),
}

export const templateCreatedPayloadSchema = z
  .object(templateFieldsShape)
  .strict()
  .superRefine(addRuleIssues)

export const templateUpdatedPayloadSchema = z
  .object(templateFieldsShape)
  .strict()
  .superRefine(addRuleIssues)

/**
 * 删除事件携带**模板快照**（ADR-011 §6 末）：§7 承诺「删除模板 → 已完成轮次保留」，
 * 而唯一的读取函数 `deriveRounds(template, completions, today)` 第一个参数就是模板。
 * 不带快照，模板行删掉之后那些「保留」的历史轮次就没有任何可渲染信息了。
 */
export const templateDeletedPayloadSchema = z
  .object(templateFieldsShape)
  .strict()
  .superRefine(addRuleIssues)

/**
 * `recurrence/round-completed` 载荷（ADR-011 §6）。
 *
 * `nextAnchorDate` 为 `null` 表示**规则已终止**（达到 `count` 或越过 `until`）——
 * 该取值由 `@shared/recurrence` 的 `RoundCompletion` 定义，本 schema 与之对齐。
 *
 * **它不写投影表，不是遗漏**（ADR-011 §6 明文）：ADR-007 §4 规定已完成的轮次由
 * **事件**固化而非投影行，这样模板被改被删都不会让历史轮次漂移。
 */
export const roundCompletedPayloadSchema = z
  .object({
    templateId: z.string().min(1),
    originalPlannedDate: z.string(),
    completedDayKey: z.string(),
    nextAnchorDate: z.string().nullable(),
    nextAnchorMode: anchorModeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [field, dayKey] of [
      ['originalPlannedDate', value.originalPlannedDate],
      ['completedDayKey', value.completedDayKey],
      ['nextAnchorDate', value.nextAnchorDate],
    ] as const) {
      if (dayKey === null) continue
      if (!isDayKey(dayKey)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `必须是真实存在的 'YYYY-MM-DD'，实得 '${dayKey}'` })
      }
    }
  })

export type TemplateCreatedPayload = z.infer<typeof templateCreatedPayloadSchema>
export type TemplateUpdatedPayload = z.infer<typeof templateUpdatedPayloadSchema>
export type TemplateDeletedPayload = z.infer<typeof templateDeletedPayloadSchema>
export type RoundCompletedPayload = z.infer<typeof roundCompletedPayloadSchema>

/** 载荷 → 投影行（`createdAt` / `updatedAt` 由调用方按 event.occurredAt 补） */
function toProjectedTemplate(
  payload: TemplateCreatedPayload,
  accountId: string,
  occurredAt: string,
  createdAt: string,
): ProjectedTemplate {
  return {
    id: payload.templateId,
    accountId,
    title: payload.title,
    rule: payload.rule,
    nextAnchorMode: payload.nextAnchorMode,
    startsOn: payload.startsOn,
    createdAt,
    updatedAt: occurredAt,
  }
}

export const templateCreatedDefinition: EventDefinition<TemplateCreatedPayload> = defineEvent({
  type: 'recurrence/template-created',
  schema: templateCreatedPayloadSchema,
  target: templateTarget,
  apply(projection, event) {
    const template = toProjectedTemplate(event.payload, event.accountId, event.occurredAt, event.occurredAt)
    const at = projection.templates.findIndex((candidate) => candidate.id === template.id)
    if (at >= 0) {
      // 同一模板 id 的第二次 created（合并导入、或「创建—删除—再导入」）：
      // 覆盖而不是抛错——重放对任何一条合法流水都必须有定义，不能因为重复创建就崩。
      projection.templates[at] = template
    } else {
      projection.templates.push(template)
    }
  },
})

export const templateUpdatedDefinition: EventDefinition<TemplateUpdatedPayload> = defineEvent({
  type: 'recurrence/template-updated',
  schema: templateUpdatedPayloadSchema,
  target: templateTarget,
  apply(projection, event) {
    const at = projection.templates.findIndex((candidate) => candidate.id === event.payload.templateId)
    // 无对应行（其创建事件的批次被撤销、或更新先于创建到达）：**无操作**。
    // 不插入半行——那会伪造出一个没有创建事实的模板。
    if (at < 0) return
    const current = projection.templates[at]!
    projection.templates[at] = {
      ...current,
      title: event.payload.title,
      rule: event.payload.rule,
      nextAnchorMode: event.payload.nextAnchorMode,
      startsOn: event.payload.startsOn,
      updatedAt: event.occurredAt,
    }
  },
})

export const templateDeletedDefinition: EventDefinition<TemplateDeletedPayload> = defineEvent({
  type: 'recurrence/template-deleted',
  schema: templateDeletedPayloadSchema,
  target: templateTarget,
  apply(projection, event) {
    const at = projection.templates.findIndex((candidate) => candidate.id === event.payload.templateId)
    if (at >= 0) projection.templates.splice(at, 1)
    // 快照不写投影表：删除后该行不存在，历史轮次由事件本身（本事件的快照 + 完成事件）读取。
  },
})

export const roundCompletedDefinition: EventDefinition<RoundCompletedPayload> = defineEvent({
  type: 'recurrence/round-completed',
  schema: roundCompletedPayloadSchema,
  target: templateTarget,
  apply: () => {
    // 空操作：轮次不落库（ADR-011 §6）。该事件是 `deriveRounds` 的输入，不是投影的输入。
  },
})

/**
 * 完成事件 → `RoundCompletion`（ADR-011 §4 的映射式）：
 *
 * ```
 * RoundCompletion = 载荷 + { eventId: event.id, accountId: event.accountId }
 * ```
 *
 * **显式构造，不用类型断言**——这条函数的存在理由就是断言会放过漏字段：
 * `{ ...payload as Omit<RoundCompletion,'eventId'>, eventId }` 这种写法在
 * `RoundCompletion` 新增必填字段时**照样编译通过**，运行期那个字段是 `undefined`。
 * 而对 `accountId` 这种字段，漏掉的后果是 `deriveRounds` 把每一条完成记录都判成
 * 「别的账号的」→ **历史轮次全部静默消失，不报错**（正是 02 §3.2 要防的账号隔离破坏）。
 * 显式逐字段写出来，漏一个就是编译错误。
 *
 * 两个附加字段都取自**事件行**（`account_id` 列、`id` 列），不进 §6 的载荷：
 * 账号与事件标识本来就是事件行的列，同一事实只应有一个来源——与 §2 把 `target`
 * 做成派生式是同一条思路。
 */
export function eventToCompletion(event: Event<RoundCompletedPayload>): RoundCompletion {
  return {
    accountId: event.accountId,
    templateId: event.payload.templateId,
    originalPlannedDate: event.payload.originalPlannedDate,
    completedDayKey: event.payload.completedDayKey,
    nextAnchorDate: event.payload.nextAnchorDate,
    nextAnchorMode: event.payload.nextAnchorMode,
    eventId: event.id,
  }
}

/** 阶段 2 登记的全部重复任务事件定义 */
export const recurrenceEventDefinitions: readonly RegisteredDefinition[] = [
  templateCreatedDefinition,
  templateUpdatedDefinition,
  templateDeletedDefinition,
  roundCompletedDefinition,
]
