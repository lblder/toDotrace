import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * 密码哈希：node:crypto 的 scrypt（ADR-008 §4）。
 *
 * 存储格式自带参数，便于日后提高开销而不破坏旧记录：
 *   scrypt$N$r$p$<base64 salt>$<base64 hash>
 */

/** ADR-008 §4 定稿参数：N=2^15, r=8, p=1，随机 16 字节 salt。 */
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1 } as const
const SALT_BYTES = 16
const KEY_BYTES = 32

/**
 * scrypt 的内存开销是 128 * N * r 字节（此处 32 MiB），**超过 Node 默认 maxmem（32 MiB）**，
 * 不显式放宽会直接抛 "memory limit exceeded"。留一倍余量。
 */
function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: maxmemFor(N, r) }, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = DEFAULT_PARAMS
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt, N, r, p)
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/** 解析存储串；格式非法返回 null（不抛，交由调用方当作校验失败）。 */
function parse(stored: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  if (N < 2 || r < 1 || p < 1 || N > 2 ** 20 || r > 32 || p > 16) return null
  let salt: Buffer
  let hash: Buffer
  try {
    salt = Buffer.from(parts[4]!, 'base64')
    hash = Buffer.from(parts[5]!, 'base64')
  } catch {
    return null
  }
  if (salt.length === 0 || hash.length === 0) return null
  return { N, r, p, salt, hash }
}

/** 恒定时间校验：长度不同直接返回 false，长度相同走 timingSafeEqual。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored)
  if (!parsed) return false
  const candidate = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p)
  // 重新派生后长度应与存储一致；长度不等时 timingSafeEqual 会抛，先判长度。
  if (candidate.length !== parsed.hash.length) return false
  return timingSafeEqual(candidate, parsed.hash)
}

/**
 * 用户名不存在时用来抹平响应时间的假哈希（防用户名枚举的时序侧信道）。
 * 值本身无意义，只是让「账号不存在」的路径也付一次同等开销的派生。
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
