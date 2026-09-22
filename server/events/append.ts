import { z } from 'zod'
import type { Db } from '../db/connection.js'
import { isDayKey, toDayKey } from '@shared/time'
import { invalidInput } from '../lib/errors.js'
import { toIsoInZone } from '../lib/time.js'
import { isUuidV7, uuidv7 } from '../lib/uuid.js'
import { isBoundaryEventType } from './definitions/system.js'
import { findEvent, insertEvents, readMaxEventId, readRevokedBatchIds } from './event-store.js'
import { canonicalizeProjection } from './project.js'
import { readProjection, writeProjection } from './projection-store.js'
import { rebuildProjection } from './rebuild.js'
import { getEventDefinition, isRegisteredType } from './registry.js'
import { loadAccountSettings, timeContextOf, type AccountSettings } from './settings.js'
import { assertInTransaction } from './transaction.js'
import type { Event, EventDraft, RegisteredDefinition } from './types.js'

/**
 * 追加事件（ADR-010 §3）。
 *
 * ```ts
 * appendEvents(db, accountId, drafts: EventDraft[]): Event[]
 * ```
 *
 * 三条纪律：
 *
 * 1. **调用方必须已在事务内**（ADR-002 §1）：事件写入与投影更新在同一事务里提交，
 *    否则会留下「事件已写、投影未更新」的洞。不在事务内直接抛错，不替你开事务。
 * 2. **未登记的 type 一律拒绝写入**（ADR-010 §2）：它无法重放，写进去即破坏
 *    「投影 = 重放结果」这条不变式。
 * 3. **整批校验先行**：任一条草稿不合法就抛错，且**一个字都不写**。
 *    一次用户动作是一个事务，「部分成功」正是 ADR-002 §1 要杜绝的中间态。
 * 4. **标识落点由事件定义派生**（ADR-010 §2）：声明了 `target` 的类型，
 *    其 `target_kind` / `target_id` 从载荷取，调用方无从写错（见 `deriveTarget`）。
 *
 * 返回值是**本次真正新增**的事件（按 id 升序）；同一 id 已存在且内容一致的草稿被
 * 幂等跳过（「同一文件导入两次 = 0 新增」，ADR-010 §1 / 需求 FR3），不计入返回值。
 */
export function appendEvents(db: Db, accountId: string, drafts: readonly EventDraft[]): Event[] {
  assertInTransaction(db, 'appendEvents')
  if (drafts.length === 0) return []

  const settings = loadAccountSettings(db, accountId)
  const context: PrepareContext = {
    accountId,
    settings,
    // `appended_at` 是服务端接收时刻（绝对时刻），偏移按**账号时区**渲染：
    // ADR-010 §1 要求进程时区不进入任何持久化数据，而这一列就落在事件行上。
    // （逐条草稿可用 `timezone` 覆盖行上的时区，但 `appended_at` 是一批一个值，
    //  取账号设置——它解释的是「服务端何时收到」，不是「这条事件属于哪个时区」。）
    appendedAt: toIsoInZone(new Date(), settings.timeZone),
    // 一次调用 = 一个批次（ADR-006 §1）：未显式给出 batchId 的草稿共用它。
    // 导入的事件各自携带原 batchId（ADR-010 §3），故允许逐条覆盖。
    defaultBatchId: uuidv7(),
  }

  // ── 整批校验（先于任何写入）────────────────────────────────────────
  const prepared = drafts.map((draft, index) => prepareEvent(draft, index, context))

  // ── 幂等判定：同 id 且同内容 → 跳过；同 id 不同内容 → 拒绝 ──────────
  const previousMaxId = readMaxEventId(db, accountId)
  const inserted: Event[] = []
  for (const event of prepared) {
    const existing = findEvent(db, accountId, event.id)
    if (existing !== undefined) {
      assertSameEvent(existing, event)
      continue
    }
    inserted.push(event)
  }

  if (inserted.length === 0) return inserted

  insertEvents(db, inserted)
  maintainProjection(db, accountId, inserted, previousMaxId)
  return inserted
}

// ─────────────────────────────────────────────────────────────────────
// 校验与折算
// ─────────────────────────────────────────────────────────────────────

const ISO_INSTANT = z.iso.datetime({ offset: true })

interface PrepareContext {
  accountId: string
  settings: AccountSettings
  appendedAt: string
  defaultBatchId: string
}

/** 把一条草稿补全成完整事件：校验 + 生成 id/批次 + 折算并固化 dayKey。 */
function prepareEvent(draft: EventDraft, index: number, context: PrepareContext): Event {
  const where = `第 ${index + 1} 条事件草稿`
  if (typeof draft?.type !== 'string' || draft.type.length === 0) {
    throw invalidInput(`${where}：type 不能为空`)
  }
  if (!isRegisteredType(draft.type)) {
    // 「未登记即拒绝」——这里给出面向用户的说法，注册表内部另有一道同名断言。
    throw invalidInput(
      `${where}：未登记的事件类型 '${draft.type}'。未登记的类型无法被重放（ADR-010 §2）。`,
    )
  }
  const definition = getEventDefinition(draft.type)

  const parsed = definition.schema.safeParse(draft.payload)
  if (!parsed.success) {
    throw invalidInput(`${where}（${draft.type}）载荷不合法：${describeIssue(parsed.error)}`)
  }

  const occurredAtCheck = ISO_INSTANT.safeParse(draft.occurredAt)
  if (!occurredAtCheck.success) {
    throw invalidInput(
      `${where}（${draft.type}）：occurredAt 必须是带时区偏移的 ISO 8601 时刻，实得 '${String(draft.occurredAt)}'`,
    )
  }

  const id = draft.id ?? uuidv7()
  if (!isUuidV7(id)) {
    throw invalidInput(`${where}（${draft.type}）：id 必须是 UUIDv7，实得 '${id}'`)
  }
  const batchId = draft.batchId ?? context.defaultBatchId
  if (!isUuidV7(batchId)) {
    throw invalidInput(`${where}（${draft.type}）：batchId 必须是 UUIDv7，实得 '${batchId}'`)
  }

  // dayKey / dayStartHour：导入时原样保留（已固化、永不重算），否则写入时折算。
  // 二者必须成对给出——只给 dayKey 会让事件记下一个与它无关的 dayStartHour，
  // 「这天为什么归到这天」就再也解释不了（ADR-001 §4）。
  const hasDayKey = draft.dayKey !== undefined
  const hasDayStartHour = draft.dayStartHour !== undefined
  if (hasDayKey !== hasDayStartHour) {
    throw invalidInput(
      `${where}（${draft.type}）：dayKey 与 dayStartHour 必须成对出现（它们是同一份固化事实的两半）。`,
    )
  }

  const dayStartHour = hasDayStartHour ? draft.dayStartHour! : context.settings.dayStartHour
  if (!Number.isInteger(dayStartHour) || dayStartHour < 0 || dayStartHour > 23) {
    throw invalidInput(`${where}（${draft.type}）：dayStartHour 必须是 0–23 的整数`)
  }

  const timezone = draft.timezone ?? context.settings.timeZone
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw invalidInput(`${where}（${draft.type}）：timezone 不能为空`)
  }

  const dayKey = hasDayKey ? draft.dayKey! : toDayKey(new Date(draft.occurredAt), {
    timeZone: timezone,
    dayStartHour,
  })
  if (!isDayKey(dayKey)) {
    throw invalidInput(`${where}（${draft.type}）：dayKey 不是合法的 'YYYY-MM-DD'，实得 '${dayKey}'`)
  }

  const target = deriveTarget(draft, definition, parsed.data, where)

  return {
    id,
    accountId: context.accountId,
    type: definition.type,
    occurredAt: draft.occurredAt,
    timezone,
    dayKey,
    dayStartHour,
    targetKind: target.kind,
    targetId: target.id,
    batchId,
    payload: parsed.data as unknown,
    appendedAt: context.appendedAt,
  }
}

/**
 * `target_kind` / `target_id` 两列的取值（ADR-010 §2）。
 *
 * 声明了 `target` 的事件类型，两列**从载荷派生**——调用方无从写错，也无从漏写；
 * 未声明的类型（系统事件、设置事件）两列为 NULL，「不针对特定对象」（ADR-010 §1）。
 *
 * 显式给出时**必须与派生值一致**：不一致意味着「同一条事件两份内容」，
 * 与 `assertSameEvent` 是同一类事——导入文件被改写。静默取其一正是最难查的失真。
 */
function deriveTarget(
  draft: EventDraft,
  definition: RegisteredDefinition,
  payload: unknown,
  where: string,
): { kind: string | null; id: string | null } {
  const explicitKind = draft.targetKind ?? null
  const explicitId = draft.targetId ?? null

  const target = definition.target
  if (target === undefined) {
    if ((explicitKind === null) !== (explicitId === null)) {
      throw invalidInput(
        `${where}（${draft.type}）：target_kind 与 target_id 必须同时给出或同时为空` +
          '（为 NULL 表示不针对特定对象，ADR-010 §1）。',
      )
    }
    return { kind: explicitKind, id: explicitId }
  }

  const id = target.fromPayload(payload)
  if (typeof id !== 'string' || id.length === 0) {
    // 定义自身的缺陷，不是调用方的输入错误 —— 故是内部错误而不是 400。
    throw new Error(
      `事件类型 '${definition.type}' 的 target.fromPayload 未返回非空标识。` +
        '这是事件定义自身的缺陷（ADR-010 §2），不是调用方的输入问题。',
    )
  }
  if (explicitKind !== null && explicitKind !== target.kind) {
    throw invalidInput(
      `${where}（${draft.type}）：target_kind 由载荷派生为 '${target.kind}'，与给出的 '${explicitKind}' 不符。` +
        '落点由事件定义决定，调用方不必也不得改写（ADR-010 §2）。',
    )
  }
  if (explicitId !== null && explicitId !== id) {
    throw invalidInput(
      `${where}（${draft.type}）：target_id 由载荷派生为 '${id}'，与给出的 '${explicitId}' 不符——` +
        '同一条事件不能有两个落点（ADR-010 §2）。',
    )
  }
  return { kind: target.kind, id }
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return '未知错误'
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `${path}: ${issue.message}`
}

/**
 * 同一 `id` 必须指同一事件（ADR-001：标识全局唯一）。
 * 逐字段比对**除 `appended_at` 以外**的全部列：`appended_at` 是本地接收时刻，
 * 同一份文件导入两次必然不同，把它算进去会让幂等性当场失效。
 */
function assertSameEvent(existing: Event, incoming: Event): void {
  const same =
    existing.type === incoming.type &&
    existing.occurredAt === incoming.occurredAt &&
    existing.timezone === incoming.timezone &&
    existing.dayKey === incoming.dayKey &&
    existing.dayStartHour === incoming.dayStartHour &&
    existing.targetKind === incoming.targetKind &&
    existing.targetId === incoming.targetId &&
    existing.batchId === incoming.batchId &&
    canonicalJson(existing.payload) === canonicalJson(incoming.payload)

  if (!same) {
    throw invalidInput(
      `事件 id '${incoming.id}' 在本账号内已存在，但内容不同。` +
        '同一个 id 在任何地方都指同一个事件（ADR-001 §1）——' +
        '这条不符意味着导入文件被改写或 id 发生碰撞，故拒绝写入而不是静默跳过。',
    )
  }
}

/** 键序无关的 JSON 序列化：只用于比较两份载荷是否等价。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

// ─────────────────────────────────────────────────────────────────────
// 增量投影路径
// ─────────────────────────────────────────────────────────────────────

/**
 * 追加之后维护投影——**与事件写入同事务**（ADR-010 §5）。
 *
 * 平时走增量：读当前投影 → 按 id 序 apply 新事件 → 写回。
 * 下列三种情形必须退化为全量重建，否则增量得到的不是重放结果：
 *
 * 1. **批次含边界事件**（`system/overwrite-anchor` / `system/revoke`）：
 *    边界会改变**已有**事件的取舍（覆盖面之前的不再参与折叠、被撤销批次要恢复），
 *    而 `apply` 只增不减，无法回退——重建是唯一正确的路径
 *    （ADR-010 §5 已把「覆盖导入后的重建」列为全量重放的用途之一）；
 * 2. **不是尾部追加**（新事件 id 小于流水中已有的最大 id）：折叠顺序是 id 序，
 *    把更早的事件补在末尾会让「后者覆盖前者」的语义倒挂。合并导入正是这种情形；
 * 3. **批次已被撤销**：被撤销批次的事件不参与折叠，增量却无从知道这一点。
 *
 * 判据本身抽成 `classifyMaintenance`，供测试直接断言「走的是哪条路」。
 */
function maintainProjection(
  db: Db,
  accountId: string,
  inserted: readonly Event[],
  previousMaxId: string | null,
): void {
  if (classifyMaintenance(db, accountId, inserted, previousMaxId) === 'rebuild') {
    rebuildProjection(db, accountId)
    return
  }

  const projection = readProjection(db, accountId)
  for (const event of [...inserted].sort(compareById)) {
    getEventDefinition(event.type).apply(projection, event)
  }
  canonicalizeProjection(projection)
  writeProjection(db, accountId, projection)
}

/** 增量路径的判据（导出仅为让测试断言分支被真的走到，不是域能力）。 */
export function classifyMaintenance(
  db: Db,
  accountId: string,
  inserted: readonly Event[],
  previousMaxId: string | null,
): 'incremental' | 'rebuild' {
  for (const event of inserted) {
    if (isBoundaryEventType(event.type)) return 'rebuild'
  }
  if (previousMaxId !== null && inserted.some((event) => event.id < previousMaxId)) {
    return 'rebuild'
  }
  const revoked = readRevokedBatchIds(db, accountId)
  for (const event of inserted) {
    if (revoked.has(event.batchId)) return 'rebuild'
  }
  return 'incremental'
}

/** 与 `project()` 内部同一把键：事件 id 升序（码元比较，不用 localeCompare）。 */
function compareById(a: Event, b: Event): number {
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}
