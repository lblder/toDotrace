import { randomBytes } from 'node:crypto'

/**
 * UUIDv7（RFC 9562）生成器，零依赖。
 *
 * ADR-001 §1：所有实体主标识是 UUIDv7，高位是毫秒时间戳，标识本身即时间有序；
 * 同一毫秒内必须保证单调性，否则「按 id 排序 = 按发生顺序排序」不成立。
 *
 * 单调性做法：48 位毫秒时间戳 + 12 位计数器（rand_a 位域）。
 * - 同一毫秒内每生成一个，计数器 +1；
 * - 计数器溢出（4096/ms）则自旋等到下一毫秒；
 * - 系统时钟回拨时沿用上一次的时间戳并继续递增计数器，仍保持严格递增
 *   （宁可让 id 的时间戳略微超前，也不产生逆序 id）。
 */

const MAX_SEQ = 0xfff // 12 位
let lastMs = -1
let seq = 0

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

  const bytes = Buffer.allocUnsafe(16)
  bytes.writeUIntBE(lastMs, 0, 6) // 48 位毫秒时间戳
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f) // version 7 + 计数器高 4 位
  bytes[7] = seq & 0xff // 计数器低 8 位
  const tail = randomBytes(8)
  bytes[8] = 0x80 | (tail[0]! & 0x3f) // variant 10 + 随机 6 位
  tail.copy(bytes, 9, 1, 8) // 随机 56 位

  const hex = bytes.toString('hex')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value)
}
