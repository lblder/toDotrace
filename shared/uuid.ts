/**
 * UUIDv7（RFC 9562）生成器，零依赖。
 *
 * ## 本文件是 `shared/` 里**唯一一个非纯模块**（ADR-017 §5.1 的显式例外）
 *
 * `shared/` 的纪律是纯函数：不读时钟、不读全局状态、不写存储。本文件三条全破——
 * 读 `Date.now()`、读随机源、**还有模块级可变状态**（`lastMs` / `seq`，
 * 用于同毫秒单调与时钟回拨兜底）。允许破例的理由只有一条：
 * **生成器不参与重放**。事件一旦写入，其 id 就是既成事实，
 * `project()` 从不调用本函数，因此「同一事件集合重放必得同一状态」
 * （那才是纯函数纪律真正要保的东西）不受影响。**除本文件外的 `shared/` 模块仍是纯的。**
 *
 * 反过来说，**不得**因为「反正不纯」就改用 `crypto.randomUUID()`（v4）：
 * ADR-001 §1 规定所有实体主标识是 UUIDv7，且有代码依赖「id 序 === 时间序」——
 * `RoundCompletion` 的「最近一次完成」判定与 ADR-015 §2 的「取最后一条完成事件」
 * 都是**字符串比较**（见 `shared/recurrence/types.ts`：规范 UUIDv7、小写、定长 36
 * ⇒ 字典序 === 时间序）。浏览器若发 v4 id，这条性质对任务 id 会**静默失效**，
 * 而失效点不会报错。
 *
 * ## 两端通吃（ADR-017 §5.1 ①）
 *
 * 随机源用 `globalThis.crypto.getRandomValues`（Node 22 与浏览器都有），
 * 字节缓冲用 `Uint8Array`——**不用 `Buffer`**：`Buffer` 是 `Uint8Array` 的子类，
 * 反向不成立，故 `Uint8Array` 两端通吃。本文件因此对 Node 内建**零依赖**
 * （`Buffer` 与 `node:crypto` 在浏览器里都不存在）。
 *
 * ## 单调性做法（ADR-001 §1）
 *
 * 48 位毫秒时间戳 + 12 位计数器（rand_a 位域）：
 * - 同一毫秒内每生成一个，计数器 +1；
 * - 计数器溢出（4096/ms）则自旋等到下一毫秒；
 * - 系统时钟回拨时沿用上一次的时间戳并继续递增计数器，仍保持严格递增
 *   （宁可让 id 的时间戳略微超前，也不产生逆序 id）。
 *
 * 这三条是「id 可以当排序键」的**全部依据**，由 `shared/uuid.test.ts` 逐条钉住。
 */

/** 12 位计数器（rand_a 位域）的上界 */
const MAX_SEQ = 0xfff

let lastMs = -1
let seq = 0

/** 16 字节 → 32 位小写十六进制（不用 `Buffer.toString('hex')`，浏览器没有 `Buffer`） */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function uuidv7(): string {
  let ms = Date.now()
  if (ms > lastMs) {
    lastMs = ms
    seq = 0
  } else {
    // 同一毫秒（或时钟回拨）：递增计数器，必要时等到下一毫秒。
    if (seq >= MAX_SEQ) {
      do {
        ms = Date.now()
      } while (ms <= lastMs)
      lastMs = ms
      seq = 0
    } else {
      seq += 1
    }
  }

  const bytes = new Uint8Array(16)
  // 48 位毫秒时间戳，大端。分两段写，避免 32 位移位在 > 2^32 的毫秒值上失真。
  const high = Math.floor(lastMs / 0x1_0000_0000)
  const low = lastMs - high * 0x1_0000_0000
  bytes[0] = (high >>> 8) & 0xff
  bytes[1] = high & 0xff
  bytes[2] = (low >>> 24) & 0xff
  bytes[3] = (low >>> 16) & 0xff
  bytes[4] = (low >>> 8) & 0xff
  bytes[5] = low & 0xff
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f) // version 7 + 计数器高 4 位
  bytes[7] = seq & 0xff // 计数器低 8 位

  const tail = new Uint8Array(8)
  globalThis.crypto.getRandomValues(tail)
  bytes[8] = 0x80 | (tail[0]! & 0x3f) // variant 10 + 随机 6 位
  for (let i = 1; i < 8; i += 1) bytes[8 + i] = tail[i]! // 随机 56 位

  const hex = toHex(bytes)
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value)
}
