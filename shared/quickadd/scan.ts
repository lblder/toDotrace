/**
 * 阶段 0（整串引号）与阶段 1（转义 + 最左最长扫描） —— ADR-014 §2。
 *
 * ```
 * 阶段 0  整串引号        text 首尾同为 " 且 length ≥ 2 → 剥引号、quoted=true、结束
 * 阶段 1  转义 + 扫描     左到右，每点取「最长匹配」，产出全部 token + escapeOffsets
 * ```
 *
 * 本文件**不读时钟**：`today` 由 `parseQuickAdd` 经 `today(timeContext, now)` 派生后
 * 作为 `ScanEnv` 的一部分传进来；`resolveQuickAdd` 也不再读时钟（它取 `parse.today`）。
 */
import { today } from '@shared/time'

import { longestMatchAt } from './lexicon'
import type { ScanEnv } from './lexicon'
import { MAX_TAGS } from './types'
import type { QuickAddContext, QuickAddParse, QuickAddToken } from './types'

/**
 * 阶段 0 的判据（逐字照 FR2.3）：`text.length >= 2 && text[0] === '"' && text[len-1] === '"'`。
 *
 * 只认**半角** `"`：全角 `“…”` 在中文正文里是**引号**（引用别人的话），
 * 把它也征用为转义符，会让「引用」与「转义」在同一串字符上冲突。
 *
 * 已知副作用（接受，且被测试固化）：`"a" "b"` 首尾同为 `"` 且长度 ≥ 2，故**会**触发，
 * 标题 = `a" "b`。这是 FR2.3 给定判据的直接推论，不为它加特例——
 * 特例会让「哪些串是逃生舱」变得不可预测。
 */
function isFullyQuoted(text: string): boolean {
  return text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"'
}

/** 阶段 1：转义（层②）与最左最长扫描 */
export function scanTokens(text: string, env: ScanEnv): {
  tokens: QuickAddToken[]
  escapeOffsets: number[]
} {
  const tokens: QuickAddToken[] = []
  const escapeOffsets: number[] = []
  // 标签的计数只在**真正产出 token** 时递增：被转义、被认领但未产出的 `@` 都不占额度
  let tagCount = 0
  let i = 0

  while (i < text.length) {
    if (text[i] === '\\') {
      // 转义只保护它命中的那一个片段：`\明天` 保护 `明天`（2 字），`\明天开会` 只保护 `明天`；
      // 未命中任何规则的 `\` 是普通字符（`C:\path` 的反斜杠会原样留在标题里）
      const hit = longestMatchAt(text, i + 1, env)
      if (hit !== null) {
        escapeOffsets.push(i)
        i = hit.end
        continue
      }
      i += 1
      continue
    }

    const hit = longestMatchAt(text, i, env)
    if (hit === null) {
      i += 1
      continue
    }

    const token = hit.token
    if (token !== null) {
      if (token.kind !== 'tag') {
        tokens.push(token)
      } else if (tagCount < MAX_TAGS) {
        // 第 21 个及以后**不识别**（ADR-017 §3 的 20 个上限，§6 的处置表）。
        // 跨度仍被认领，于是它的原文一个字都不动地留在标题里，且不会被二次匹配。
        tagCount += 1
        tokens.push(token)
      }
    }
    i = hit.end
  }

  return { tokens, escapeOffsets }
}

/**
 * 阶段 0 + 阶段 1。
 *
 * `today` 由 `now` 与 `timeContext` 在模块内部派生并**随结果固化**（§1）——
 * 若 `today` 是入参，它就有了第二个来源：调用方可以在别处、用别的时钟算出「今天」，
 * 而本模块无从发现；同一次解析里两个碎片按两个「今天」折算，正是本仓反复禁止的
 * 「同一概念两个名字」。改成派生值之后，`now` 与 `timeContext` 是唯一输入。
 *
 * **调用方一条义务**：`now` 必须在**每次解析时**取当前时刻（而不是在组件挂载时取一次）。
 * `dayStartHour` 默认 4，归属日在**凌晨 4 点**翻页；挂着不动的 `now` 会让预览在 4 点后
 * 继续按昨天折算「明天」。
 */
export function parseQuickAdd(text: string, ctx: QuickAddContext): QuickAddParse {
  const todayKey = today(ctx.timeContext, ctx.now)

  if (isFullyQuoted(text)) {
    // 命中则七个字段全空、`\` 也不处理——「全部不解析」就是这一层的全部语义
    return { text, today: todayKey, tokens: [], escapeOffsets: [], quoted: true }
  }

  const { tokens, escapeOffsets } = scanTokens(text, { today: todayKey, projects: ctx.projects })
  return { text, today: todayKey, tokens, escapeOffsets, quoted: false }
}
