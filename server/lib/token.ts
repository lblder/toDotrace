import { createHash, randomBytes } from 'node:crypto'

/**
 * 会话令牌与邀请码（ADR-008 §4）：
 * - 均为 32 字节 CSPRNG 随机值，base64url 编码；
 * - 库中**只存 SHA-256**（hex），明文只在签发响应里出现一次；
 * - 256 位随机值已高熵，无需慢哈希——查表按哈希等值匹配即可。
 */

const TOKEN_BYTES = 32

/** 生成明文凭证（令牌 / 邀请码同规格）。 */
export function generateSecret(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** 库内存储形态：SHA-256 的 hex。 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** 从 `Authorization: Bearer <token>` 中取出令牌；缺失或格式不符返回 null。 */
export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim())
  if (!match) return null
  const token = match[1]!
  if (token.length === 0 || token.length > 512) return null
  return token
}
