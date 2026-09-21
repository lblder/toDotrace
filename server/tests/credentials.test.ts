import { describe, expect, it } from 'vitest'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password.js'
import { generateSecret, hashSecret, parseBearerToken } from '../lib/token.js'
import { LoginThrottle } from '../domain/login-throttle.js'
import { isExpired, toIso } from '../lib/time.js'
import { uuidv7 } from '../lib/uuid.js'

describe('密码哈希（scrypt，ADR-008 §4）', () => {
  it('存储格式为 scrypt$N$r$p$salt$hash，参数为 2^15/8/1', async () => {
    const stored = await hashPassword('correct horse battery staple')
    const parts = stored.split('$')
    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe('scrypt')
    expect(Number(parts[1])).toBe(32768)
    expect(Number(parts[2])).toBe(8)
    expect(Number(parts[3])).toBe(1)
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16) // 16 字节 salt
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(32)
  })

  it('正确口令通过校验，错误口令不通过', async () => {
    const stored = await hashPassword('alice-password-1')
    await expect(verifyPassword('alice-password-1', stored)).resolves.toBe(true)
    await expect(verifyPassword('alice-password-2', stored)).resolves.toBe(false)
    await expect(verifyPassword('', stored)).resolves.toBe(false)
  })

  it('同一口令两次哈希不同（salt 随机）', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    await expect(verifyPassword('same-password', a)).resolves.toBe(true)
    await expect(verifyPassword('same-password', b)).resolves.toBe(true)
  })

  it('存储串被破坏时返回 false 而不是抛异常', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('x', 'scrypt$0$0$0$AAAA$AAAA')).resolves.toBe(false)
    await expect(verifyPassword('x', '')).resolves.toBe(false)
  })

  it('不存在账号用的假哈希也是合法 scrypt 串（时序抹平用）', async () => {
    await expect(verifyPassword('anything', DUMMY_PASSWORD_HASH)).resolves.toBe(false)
  })
})

describe('令牌与邀请码（ADR-008 §4）', () => {
  it('32 字节 CSPRNG，base64url 编码，明文不可预测', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('哈希为 SHA-256 hex，库内只存哈希', () => {
    const secret = generateSecret()
    const hash = hashSecret(secret)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(secret)
    expect(hashSecret(secret)).toBe(hash) // 确定性，才能按哈希查表
    expect(hashSecret(generateSecret())).not.toBe(hash)
  })

  it('Bearer 头解析：方案名大小写不敏感，令牌本身区分大小写', () => {
    expect(parseBearerToken('Bearer abc')).toBe('abc')
    expect(parseBearerToken('Bearer   abc  ')).toBe('abc')
    // RFC 7235：scheme 比较大小写无关（ADR-008 §8 补遗 6）
    expect(parseBearerToken('bearer abc')).toBe('abc')
    expect(parseBearerToken('BEARER abc')).toBe('abc')
    expect(parseBearerToken('BeArEr abc')).toBe('abc')
    // 令牌本身仍然区分大小写：原样返回，不做归一
    expect(parseBearerToken('Bearer AbC')).toBe('AbC')
    expect(parseBearerToken(undefined)).toBeNull()
    expect(parseBearerToken('')).toBeNull()
    expect(parseBearerToken('abc')).toBeNull()
    expect(parseBearerToken('Basic abc')).toBeNull()
    expect(parseBearerToken('Bearer ')).toBeNull()
    expect(parseBearerToken('Bearerbearer abc')).toBeNull()
  })
})

describe('登录防爆破（ADR-008 §5）', () => {
  it('连续 5 次失败后锁定 15 分钟，成功登录清零', () => {
    const throttle = new LoginThrottle({ maxFailures: 5, lockMs: 15 * 60 * 1000 })
    const t0 = 1_000_000
    for (let i = 0; i < 4; i += 1) {
      expect(throttle.recordFailure('alice', t0)).toBe(false)
      expect(throttle.lockedForMs('alice', t0)).toBeNull()
    }
    expect(throttle.recordFailure('alice', t0)).toBe(true)
    expect(throttle.lockedForMs('alice', t0)).toBe(15 * 60 * 1000)
    expect(throttle.lockedForMs('alice', t0 + 14 * 60 * 1000)).toBeGreaterThan(0)
    // 窗口到期自动失效
    expect(throttle.lockedForMs('alice', t0 + 15 * 60 * 1000 + 1)).toBeNull()

    throttle.recordFailure('bob', t0)
    throttle.recordSuccess('bob')
    expect(throttle.peek('bob')).toBeUndefined()
  })

  it('分桶键 = trim 后的原样用户名：首尾空白同桶、大小写各计各的', () => {
    const throttle = new LoginThrottle({ maxFailures: 2, lockMs: 1000 })
    // 首尾空白被 trim 掉 → 与 'Alice' 同一个桶（登录入口本来也 trim）
    throttle.recordFailure(' Alice ', 0)
    expect(throttle.recordFailure('Alice', 0)).toBe(true)
    expect(throttle.lockedForMs('Alice', 0)).toBe(1000)
    // 只差大小写是两个账号（登录查询大小写敏感）→ 各自独立计数，绝不互相牵连
    expect(throttle.lockedForMs('alice', 0)).toBeNull()
    expect(throttle.recordFailure('ALICE', 0)).toBe(false)
    expect(throttle.lockedForMs('ALICE', 0)).toBeNull()
  })
})

describe('时间与标识', () => {
  it('ISO 8601 带时区偏移，与 ADR 示例同形', () => {
    const iso = toIso(new Date('2026-09-21T14:03:00+08:00'))
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    // 本机时区偏移下往返解析一致（不假设具体时区）
    expect(Date.parse(iso)).toBe(Date.parse('2026-09-21T14:03:00+08:00'))
  })

  it('到期判断：无法解析视为已到期', () => {
    expect(isExpired('2000-01-01T00:00:00+08:00')).toBe(true)
    expect(isExpired('2999-01-01T00:00:00+08:00')).toBe(false)
    expect(isExpired('garbage')).toBe(true)
  })

  it('UUIDv7：版本位、变体位、同一毫秒内单调递增', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7())
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids) // 单调递增：按 id 排序即按生成顺序
  })
})
