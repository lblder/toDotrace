/**
 * 阶段 2 —— 取舍 + 落点 + 拼标题（ADR-014 §2 阶段 2 / §6 的落点表）。
 *
 * 纯函数，**不再读时钟**（`today` 取自 `parse`）。
 *
 * ## 四条按顺序做的事
 *
 * 1. `suppressed` 中的偏移若命中某个 token 的 `start`，该 token 从候选集中移除
 *    （**忽略不存在的偏移**，不抛错——文本可编辑，抑制集是「用户意图的近似」）；
 * 2. 剩下的候选按 `start` 升序处理，**同一去向字段出现多个时，最后一个胜出**；
 * 3. 胜出者进 `adopted`，落选者进 `released`；
 * 4. `title` = 原文删除「`adopted` 的跨度」与「`escapeOffsets` 处的 `\`」后，走规范化。
 *
 * ## 为什么取舍要用「采纳集」而不是就地修改
 *
 * `×`（层③）取消一个碎片时，若只是把它的文本塞回标题，标题会变成碎片顺序重排过的样子。
 * 而按上面的定义，**取消 = 从采纳集里去掉一个 token 再重算**，被取消的碎片
 * **自动回到它原来的位置**；更进一步，若它当初是被另一个同字段碎片覆盖掉的
 * （如 `明天 … 周五`），取消 `周五` 会让 `明天` **自动重新生效**——
 * 这不是副作用，是采纳集模型的直接结果，`×` 因此不需要任何专门代码。
 *
 * 一条配套约束（由调用方负责）：抑制集以**原文偏移**为键，文本一变坐标即失效，
 * 故**文本被编辑时清空抑制集**。不清空的话，旧偏移可能恰好落在新文本的某个 token 上，
 * 静默取消一个用户没点过的碎片。
 */
import { matchRecurrenceFragment } from './lexicon'
import type { QuickAddParse, QuickAddResult, QuickAddToken, Importance, RecurrenceSpec } from './types'

/**
 * 冲突分组 = 「去向字段」（§2 阶段 2 第 2 条）。
 *
 * ⚠️ **`date` 与 `plannedWeek` 同组，这不是笔误**：两者落的是**不同的列**
 * （`plannedDate` / `plannedWeek`），但 ADR-013 §5 有一条 CHECK——
 * 二者**永不同时非空**。若让它们各自胜出，`明天 下周 写报告` 会同时填两列，
 * 服务端以一个用户看不出原因的 `400` 拒掉（§6 的上限表与 §后果 的测试矩阵
 * 都要求「二者永不同时非空」）。故它们共用「计划锚点」这一个去向，
 * 由 §4.4 的「后到者胜」决定谁拿这一格。
 */
const CONFLICT_GROUP: Readonly<Record<QuickAddToken['kind'], string | null>> = {
  date: 'day-anchor',
  plannedWeek: 'day-anchor',
  dueDate: 'due-date',
  importance: 'importance',
  tag: null, // 标签是累加的，不参与竞争（去重保序，§6）
  project: 'project',
  recurrence: 'recurrence',
}

/**
 * 标题规范化（`title` 的唯一生成处）：**trim 两端 + 内部连续空白折叠为单个半角空格**。
 *
 * 理由：剔除碎片后常留下双空格（`明天  写报告` → ` 写报告`）；
 * 代价是用户**故意**打的多个空格会丢——这是呈现层规范化，不涉及「不丢弃文本」那条
 * （丢的是空白，不是内容）。
 */
function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** 删除采纳碎片的跨度与转义反斜杠，再规范化 */
function buildTitle(
  text: string,
  adopted: readonly QuickAddToken[],
  escapeOffsets: readonly number[],
): string {
  const removed = new Set<number>()
  for (const token of adopted) {
    for (let i = token.start; i < token.end; i += 1) removed.add(i)
  }
  for (const offset of escapeOffsets) removed.add(offset)

  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    if (!removed.has(i)) out += text[i] ?? ''
  }
  return normalizeTitle(out)
}

/**
 * 标签去重、**保持首次出现顺序**、**不折叠大小写**（§6）。
 *
 * ⚠️ **登记为重复实现（§8 明写要登记）**：ADR-014 §8 要求这条规范化做成 `shared/` 里的一个
 * 纯函数、由 `shared/quickadd` 与 `server/` **共同导入**（「两处各写一份就是两个真相」），
 * 并注明「在它落地之前，这处重复实现登记在此」。写这一版时它**还不存在**
 * （`grep -rn 'normalizeTags' shared/ server/ src/` 无结果）。故此处是那一份「被登记的重复」：
 * 提交侧（ADR-017 §3）落地时必须并入同一份纯函数，**不得各写一份**。
 */
function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/**
 * 按**真正的 `D₀`** 重算 `startsOn`（§7）。
 *
 * 相位原点依赖 `D₀`，而 `D₀ = 裸日期片段 ?? today` 只有采纳集定了才知道；
 * 扫描阶段只能按 `today` 出一版初值。重算走**同一张规则表的同一批匹配器**，
 * 作用在 `token.text`（不可变的原文快照）上——不引入第二套匹配逻辑，
 * 也没有「文本已改所以匹配到别处」的风险（那正是 §2 禁止重匹配的语境）。
 */
function restampStartsOn(token: QuickAddToken & { kind: 'recurrence' }, d0: string): RecurrenceSpec {
  if (token.recurrence.startsOn === d0) return token.recurrence
  const again = matchRecurrenceFragment(token.text, 0, { today: d0, projects: [] })
  if (again !== null && again.token !== null && again.token.kind === 'recurrence') {
    return again.token.recurrence
  }
  // 不可达：`token.text` 就是这段碎片本身，同一匹配器必然再次命中
  return token.recurrence
}

/**
 * 阶段 2：取舍 + 落点 + 拼标题。
 *
 * @param parse 阶段 1 的结果
 * @param suppressed 被 `×` 取消的碎片偏移（按 token 的 `start` 命中；不存在的偏移被忽略）
 */
export function resolveQuickAdd(
  parse: QuickAddParse,
  suppressed: readonly number[] = [],
): QuickAddResult {
  if (parse.quoted) {
    // 层①：`title` = 剥掉首尾引号后的文本（走同一套规范化），七个字段全空
    return {
      today: parse.today,
      title: normalizeTitle(parse.text.slice(1, -1)),
      plannedDate: null,
      plannedWeek: null,
      dueDate: null,
      importance: null,
      tags: [],
      projectId: null,
      recurrence: null,
      adopted: [],
      released: [],
    }
  }

  const suppressedSet = new Set(suppressed)
  // ① 抑制集：候选集 = 全部 token 减去被取消的（`tokens` 已升序）
  const candidates = parse.tokens.filter((token) => !suppressedSet.has(token.start))

  // ② 同去向字段「后到者胜」：`candidates` 升序，故后来者覆盖先到者
  const winners = new Map<string, QuickAddToken>()
  for (const token of candidates) {
    const group = CONFLICT_GROUP[token.kind]
    if (group === null) continue
    winners.set(group, token)
  }

  // ③ 采纳集：非竞争性碎片（标签）全部采纳；竞争性碎片只有胜出者采纳
  const adoptedSet = new Set<QuickAddToken>()
  for (const token of candidates) {
    const group = CONFLICT_GROUP[token.kind]
    if (group === null || winners.get(group) === token) adoptedSet.add(token)
  }

  const recurrenceToken = winners.get('recurrence')
  const repeating = recurrenceToken !== undefined && recurrenceToken.kind === 'recurrence'

  // ④ §6 落点表的**第二列**：`recurrence !== null` 时 `plannedDate` / `plannedWeek` /
  //    `dueDate` **恒为 `null`**（ADR-013 §3.1，服务端 `400` 守卫 + §5 的 CHECK 兜底）。
  //    处置是「退回标题」而不是丢弃：不报错、用户看得见（`released` 里的原文仍在 `title`）。
  if (repeating) {
    for (const token of candidates) {
      if (token.kind === 'plannedWeek' || token.kind === 'dueDate') adoptedSet.delete(token)
    }
  }

  const adopted = candidates.filter((token) => adoptedSet.has(token))
  // 未被采纳的碎片（冲突落选、被 `×` 取消、被 §6 第二列退回）：**它们的原文仍在 `title` 里**
  const released = parse.tokens.filter((token) => !adoptedSet.has(token))

  const dateToken = adopted.find((token) => token.kind === 'date')
  const weekToken = adopted.find((token) => token.kind === 'plannedWeek')
  const dueToken = adopted.find((token) => token.kind === 'dueDate')
  const importanceToken = adopted.find((token) => token.kind === 'importance')
  const projectToken = adopted.find((token) => token.kind === 'project')

  let plannedDate = dateToken !== undefined && dateToken.kind === 'date' ? dateToken.date : null
  let plannedWeek = weekToken !== undefined && weekToken.kind === 'plannedWeek' ? weekToken.weekStart : null
  let dueDate = dueToken !== undefined && dueToken.kind === 'dueDate' ? dueToken.date : null
  const importance: Importance | null =
    importanceToken !== undefined && importanceToken.kind === 'importance' ? importanceToken.importance : null
  const projectId = projectToken !== undefined && projectToken.kind === 'project' ? projectToken.projectId : null
  const tags = dedupeTags(
    adopted.filter((token) => token.kind === 'tag').map((token) => (token.kind === 'tag' ? token.tag : '')),
  )

  let recurrence: RecurrenceSpec | null = null
  if (recurrenceToken !== undefined && recurrenceToken.kind === 'recurrence') {
    // §7：`D₀` = **裸日期片段** ?? `today`。不是 `plannedDate`——重复任务的 `plannedDate`
    // 恒为 `null`（ADR-013 §3.1），那个字段在这条路径上根本不是可读的来源。
    const d0 = dateToken !== undefined && dateToken.kind === 'date' ? dateToken.date : parse.today
    // 展开成新对象：`restampStartsOn` 在不需要重算时会返回 token 上那个 spec 本身，
    // 结果与 token 共享引用会让「改结果」等于「改 token」——纯函数不许有这个暗门
    recurrence = { ...restampStartsOn(recurrenceToken, d0) }
    // 三个日期锚点恒空：上面的第 ④ 步已经退回了对应的碎片，这里是**输出侧的自守**——
    // 服务端会以 400 拒绝，所以本模块的输出必须自己先守住（ADR-013 §3.1）。
    plannedDate = null
    plannedWeek = null
    dueDate = null
  }

  return {
    today: parse.today,
    title: buildTitle(parse.text, adopted, parse.escapeOffsets),
    plannedDate,
    plannedWeek,
    dueDate,
    importance,
    tags,
    projectId,
    recurrence,
    adopted,
    released,
  }
}
