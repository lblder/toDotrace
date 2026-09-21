import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CONTENT_SECURITY_POLICY } from '../middleware/security.js'
import {
  api,
  createMemberAccount,
  createOwnerAccount,
  startTestServer,
  type Account,
  type TestContext,
} from './helpers.js'

/**
 * 阶段 1 验收（开发文档 §3）：两个账号可注册登录；A 在任何入口拿不到 B 的数据；无令牌请求一律被拒。
 * 全部经真实 HTTP 端口 + 真实 SQLite 库，不打桩。
 */

let ctx: TestContext
let alice: Account
let bob: Account

beforeAll(async () => {
  ctx = await startTestServer()
  alice = await createOwnerAccount(ctx)
  bob = await createMemberAccount(ctx, alice.token, 'bob')
})

afterAll(async () => {
  await ctx.close()
})

/** 需要令牌的入口清单（ADR-008 §2）。新增受保护路由后这里必须同步扩展。 */
const PROTECTED_ROUTES: Array<[string, string]> = [
  ['POST', '/api/auth/logout'],
  ['GET', '/api/auth/me'],
  ['POST', '/api/invites'],
  ['GET', '/api/invites'],
  ['GET', '/api/members'],
]

const OWNER_ONLY: Array<[string, string]> = [
  ['POST', '/api/invites'],
  ['GET', '/api/invites'],
  ['GET', '/api/members'],
]

describe('首启引导', () => {
  it('无 owner 时 needsOwner = true；建成后 false；重复引导 409', async () => {
    const fresh = await startTestServer()
    try {
      const before = await api(fresh, 'GET', '/api/setup/status')
      expect(before.status).toBe(200)
      expect(before.body).toEqual({ needsOwner: true })

      const created = await api(fresh, 'POST', '/api/setup/owner', {
        body: { username: 'zoe', password: 'zoe-password-1', displayName: '佐伊' },
      })
      expect(created.status).toBe(200)
      expect(created.body.user.role).toBe('owner')
      expect(typeof created.body.token).toBe('string')

      const after = await api(fresh, 'GET', '/api/setup/status')
      expect(after.body).toEqual({ needsOwner: false })

      const again = await api(fresh, 'POST', '/api/setup/owner', {
        body: { username: 'zoe2', password: 'zoe-password-2', displayName: '佐伊2' },
      })
      expect(again.status).toBe(409)
      expect(again.body.error.code).toBe('conflict/owner-exists')
    } finally {
      await fresh.close()
    }
  })
})

describe('无令牌请求一律被拒（验收标准 3）', () => {
  it.each(PROTECTED_ROUTES)('%s %s 无令牌 → 401', async (method, path) => {
    const res = await api(ctx, method, path, method === 'POST' ? { body: {} } : {})
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('auth/missing-token')
  })

  it.each(PROTECTED_ROUTES)('%s %s 伪造令牌 → 401', async (method, path) => {
    const res = await api(ctx, method, path, {
      token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ...(method === 'POST' ? { body: {} } : {}),
    })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('auth/invalid-token')
  })

  it('方案名大小写不敏感（RFC 7235），令牌本身无效才算无效', async () => {
    // ADR-008 §8 补遗 6：`bearer` / `BEARER` 与 `Bearer` 等价。
    // 这里必须直接发原始头——helpers.api 的 token 参数会自动加 `Bearer ` 前缀。
    const rawMe = async (authorization: string) => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Authorization: authorization } })
      return { status: res.status, body: await res.json() }
    }
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const ok = await rawMe(`${scheme} ${bob.token}`)
      expect(ok.status, scheme).toBe(200)
      expect(ok.body.user.id).toBe(bob.id)
    }
    // 方案名之外的形态仍应被拒
    const forged = await rawMe('bearer ' + 'A'.repeat(43))
    expect(forged.status).toBe(401)
    expect(forged.body.error.code).toBe('auth/invalid-token')
    expect((await rawMe('Basic ' + bob.token)).status).toBe(401)
  })

  it('OPTIONS 不产生写副作用：既不续期会话也不动 last_seen_at（补遗 10）', async () => {
    const login = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'bob', password: 'member-password-1' },
    })
    const token = login.body.token as string
    const { createHash } = await import('node:crypto')
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')

    // 把两个时间戳推到 2000 年：若 OPTIONS 真的写了库，同一秒内也能判定出来
    const PAST = '2000-01-01T00:00:00+08:00'
    ctx.db.prepare('UPDATE users SET last_seen_at = ? WHERE username = ?').run(PAST, 'bob')
    ctx.db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(PAST, tokenHash)
    const snapshot = () => ({
      seen: (
        ctx.db.prepare('SELECT last_seen_at FROM users WHERE username = ?').get('bob') as {
          last_seen_at: string
        }
      ).last_seen_at,
      session: ctx.db
        .prepare('SELECT last_used_at FROM sessions WHERE token_hash = ?')
        .get(tokenHash) as { last_used_at: string },
    })
    const before = snapshot()
    expect(before.seen).toBe(PAST)
    expect(before.session.last_used_at).toBe(PAST)

    // 有效令牌 + 不存在的路径：仍是 404，但一个字都不许写
    const res = await api(ctx, 'OPTIONS', '/api/nope', { token })
    expect(res.status).toBe(404)
    expect(snapshot()).toEqual(before)

    // 同一令牌走真实入口时才应当续期与 touch
    expect((await api(ctx, 'GET', '/api/auth/me', { token })).status).toBe(200)
    expect(snapshot().seen).not.toBe(PAST)
    expect(snapshot().session.last_used_at).not.toBe(PAST)
  })

  it('OPTIONS 不得免鉴权：无令牌 401、有令牌 404，且都不带 Allow（ADR-008 §8 补遗 5）', async () => {
    for (const path of ['/api/auth/logout', '/api/auth/me', '/api/members', '/api/invites']) {
      const noToken = await api(ctx, 'OPTIONS', path)
      expect(noToken.status, path).toBe(401)
      expect(noToken.body.error.code).toBe('auth/missing-token')
      expect(noToken.headers.get('allow'), path).toBeNull()

      const withToken = await api(ctx, 'OPTIONS', path, { token: alice.token })
      expect(withToken.status, path).toBe(404)
      expect(withToken.body.error.code).toBe('not-found')
      expect(withToken.headers.get('allow'), path).toBeNull()
    }
  })
})

describe('登录与登出', () => {
  it('错误口令 401，错误口令不泄露账号是否存在', async () => {
    const wrongPassword = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'alice', password: 'not-the-password' },
    })
    const noSuchUser = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'nobody-here', password: 'not-the-password' },
    })
    expect(wrongPassword.status).toBe(401)
    expect(noSuchUser.status).toBe(401)
    expect(wrongPassword.body).toEqual(noSuchUser.body)
    expect(wrongPassword.body.error.code).toBe('auth/invalid-credentials')
  })

  it('正确口令签发令牌，/me 返回自己的身份', async () => {
    const res = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'alice', password: 'alice-password-1' },
    })
    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id: alice.id,
      username: 'alice',
      displayName: '爱丽丝',
      role: 'owner',
    })
    const me = await api(ctx, 'GET', '/api/auth/me', { token: res.body.token })
    expect(me.status).toBe(200)
    expect(me.body.user.id).toBe(alice.id)
    // 响应体只给前端真正需要的字段
    expect(Object.keys(me.body.user).sort()).toEqual(['displayName', 'id', 'role', 'username'])
  })

  it('登录成功后清零失败计数（此前失败过也不影响）', async () => {
    const fresh = await startTestServer()
    try {
      const owner = await createOwnerAccount(fresh, 'erin', 'erin-password-1', '艾琳')
      for (let i = 0; i < 4; i += 1) {
        await api(fresh, 'POST', '/api/auth/login', {
          body: { username: 'erin', password: 'wrong-password' },
        })
      }
      const ok = await api(fresh, 'POST', '/api/auth/login', {
        body: { username: 'erin', password: 'erin-password-1' },
      })
      expect(ok.status).toBe(200)
      // 清零后重新计数：再失败 4 次仍不该锁定
      for (let i = 0; i < 4; i += 1) {
        const res = await api(fresh, 'POST', '/api/auth/login', {
          body: { username: 'erin', password: 'wrong-password' },
        })
        expect(res.status).toBe(401)
      }
      expect(owner.token).toBeTypeOf('string')
    } finally {
      await fresh.close()
    }
  })

  it('登出返回 204 且令牌立即失效', async () => {
    const session = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'bob', password: 'member-password-1' },
    })
    const token = session.body.token
    expect((await api(ctx, 'GET', '/api/auth/me', { token })).status).toBe(200)

    const logout = await api(ctx, 'POST', '/api/auth/logout', { token })
    expect(logout.status).toBe(204)
    expect(logout.body).toBeNull()

    const after = await api(ctx, 'GET', '/api/auth/me', { token })
    expect(after.status).toBe(401)
  })

  it('滑动续期：每次成功鉴权刷新 expires_at；过期即 401 并清理会话行', async () => {
    const session = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'bob', password: 'member-password-1' },
    })
    const token = session.body.token as string
    const { createHash } = await import('node:crypto')
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
    const sessionRow = () =>
      ctx.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
        | { expires_at: string; last_used_at: string }
        | undefined

    const before = sessionRow()
    expect(before).toBeDefined()

    // 手动把该会话推到「10 秒后过期」，再访问一次 → 应被续成 30 天后
    const forced = new Date(Date.now() + 10_000).toISOString()
    ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(forced, tokenHash)

    expect((await api(ctx, 'GET', '/api/auth/me', { token })).status).toBe(200)
    const renewed = sessionRow()
    expect(renewed).toBeDefined()
    expect(Date.parse(renewed!.expires_at)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000)
    expect(renewed!.expires_at).not.toBe(forced)

    // 过期令牌 → 401，且会话行被删除
    ctx.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .run(new Date(Date.now() - 1000).toISOString(), tokenHash)
    const expired = await api(ctx, 'GET', '/api/auth/me', { token })
    expect(expired.status).toBe(401)
    expect(expired.body.error.code).toBe('auth/invalid-token')
    expect(sessionRow()).toBeUndefined()
  })
})

describe('防爆破（ADR-008 §5）', () => {
  it('连续 5 次失败后第 6 次返回 429，且正确口令在此期间也被拒', async () => {
    const fresh = await startTestServer()
    try {
      await createOwnerAccount(fresh, 'frank', 'frank-password-1', '弗兰克')
      for (let i = 1; i <= 5; i += 1) {
        const res = await api(fresh, 'POST', '/api/auth/login', {
          body: { username: 'frank', password: 'wrong-password' },
        })
        expect(res.status).toBe(401)
      }
      const locked = await api(fresh, 'POST', '/api/auth/login', {
        body: { username: 'frank', password: 'frank-password-1' },
      })
      expect(locked.status).toBe(429)
      expect(locked.body.error.code).toBe('auth/locked')
      // 锁定只针对该用户名，不影响其他账号
      const other = await api(fresh, 'POST', '/api/auth/login', {
        body: { username: 'alice', password: 'alice-password-1' },
      })
      expect(other.status).toBe(401) // 本库中没有 alice
    } finally {
      await fresh.close()
    }
  })
})

describe('邀请码（owner 专属，明文只出现一次）', () => {
  it('签发返回明文 code；列表不含 code；重复使用 409', async () => {
    const created = await api(ctx, 'POST', '/api/invites', { token: alice.token, body: {} })
    expect(created.status).toBe(200)
    const { id, code, expiresAt } = created.body.invite
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
    expect(created.body.invite.id).toBe(id)

    const list = await api(ctx, 'GET', '/api/invites', { token: alice.token })
    expect(list.status).toBe(200)
    const entry = list.body.invites.find((i: { id: string }) => i.id === id)
    expect(entry).toBeDefined()
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'usedAt', 'usedBy'])
    expect(JSON.stringify(list.body)).not.toContain(code)

    const first = await api(ctx, 'POST', '/api/auth/register', {
      body: { username: 'carol', password: 'carol-password-1', displayName: '卡罗尔', inviteCode: code },
    })
    expect(first.status).toBe(200)
    expect(first.body.user.role).toBe('member')

    const second = await api(ctx, 'POST', '/api/auth/register', {
      body: { username: 'dave', password: 'dave-password-1', displayName: '戴夫', inviteCode: code },
    })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('conflict/invite-used')
  })

  it('无效邀请码 400；用户名已被占用（持有效邀请码）409', async () => {
    const invalid = await api(ctx, 'POST', '/api/auth/register', {
      body: {
        username: 'erin2',
        password: 'erin-password-2',
        displayName: '艾琳',
        inviteCode: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('invite/invalid')

    const invite = await api(ctx, 'POST', '/api/invites', { token: alice.token, body: {} })
    const taken = await api(ctx, 'POST', '/api/auth/register', {
      body: {
        username: 'bob',
        password: 'bob-password-9',
        displayName: '另一个鲍勃',
        inviteCode: invite.body.invite.code,
      },
    })
    expect(taken.status).toBe(409)
    expect(taken.body.error.code).toBe('conflict/username-taken')
  })
})

describe('隔离：A 在任何入口拿不到 B 的数据（验收标准 2）', () => {
  it.each(PROTECTED_ROUTES)('member 身份访问 %s %s 不泄露任何他人身份', async (method, path) => {
    // 每个入口用一条独立会话，避免 logout 用例注销掉后续断言要用的令牌。
    const login = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'bob', password: 'member-password-1' },
    })
    const res = await api(ctx, method, path, {
      token: login.body.token,
      ...(method === 'POST' ? { body: {} } : {}),
    })
    // 要么是 owner 专属（403），要么只回自己的数据——绝不能出现 alice 的任何标识
    expect([200, 204, 403]).toContain(res.status)
    expect(JSON.stringify(res.body)).not.toContain(alice.id)
    expect(JSON.stringify(res.body)).not.toContain('alice')
    expect(JSON.stringify(res.body)).not.toContain('爱丽丝')
  })

  it.each(OWNER_ONLY)('member 访问 owner 专属 %s %s → 403（已认证但角色不足）', async (method, path) => {
    const res = await api(ctx, method, path, {
      token: bob.token,
      ...(method === 'POST' ? { body: {} } : {}),
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('auth/forbidden')
  })

  it('owner 的成员列表只有身份与活跃时间，没有任何成员的数据内容', async () => {
    const res = await api(ctx, 'GET', '/api/members', { token: alice.token })
    expect(res.status).toBe(200)
    const member = res.body.members.find((m: { username: string }) => m.username === 'bob')
    expect(member).toBeDefined()
    expect(Object.keys(member).sort()).toEqual([
      'createdAt',
      'displayName',
      'id',
      'lastSeenAt',
      'role',
      'username',
    ])
    expect(JSON.stringify(res.body)).not.toMatch(/password|token|hash/i)
  })

  it('令牌只映射到自己的账号（拿 A 的令牌永远得到 A）', async () => {
    const aliceMe = await api(ctx, 'GET', '/api/auth/me', { token: alice.token })
    const bobMe = await api(ctx, 'GET', '/api/auth/me', { token: bob.token })
    expect(aliceMe.body.user.id).toBe(alice.id)
    expect(bobMe.body.user.id).toBe(bob.id)
    expect(aliceMe.body.user.id).not.toBe(bobMe.body.user.id)
    expect(bobMe.body.user.role).toBe('member')
  })
})

describe('错误信封与状态码约定（ADR-008 §1）', () => {
  it('所有错误响应都是 { error: { code, message } } 且只有这两个键', async () => {
    const responses = [
      await api(ctx, 'POST', '/api/auth/login', { body: { username: 'x' } }), // 400
      await api(ctx, 'GET', '/api/auth/me'), // 401
      await api(ctx, 'GET', '/api/members', { token: bob.token }), // 403
      await api(ctx, 'GET', '/api/nope'), // 404
      await api(ctx, 'POST', '/api/invites', { token: bob.token, body: {} }), // 403
    ]
    for (const res of responses) {
      expect(Object.keys(res.body)).toEqual(['error'])
      expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message'])
      expect(typeof res.body.error.code).toBe('string')
      expect(typeof res.body.error.message).toBe('string')
    }
    expect(responses.map((r) => r.status)).toEqual([400, 401, 403, 404, 403])
  })

  it('zod 拒绝的入口一律 400，不进入域逻辑', async () => {
    const cases: Array<[string, unknown]> = [
      ['/api/auth/login', { username: '', password: '' }],
      ['/api/auth/login', { username: 'alice' }],
      ['/api/auth/login', { username: 42, password: 'x'.repeat(9) }],
      ['/api/auth/register', { username: 'newbie', password: 'short', displayName: 'x', inviteCode: 'y' }],
      ['/api/auth/register', { username: 'a b', password: 'longenough1', displayName: 'x', inviteCode: 'y' }],
      ['/api/setup/owner', { username: 'ok_name', password: 'longenough1' }],
    ]
    for (const [path, body] of cases) {
      const res = await api(ctx, 'POST', path, { body })
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400)
      expect(res.body.error.code).toBe('validation/invalid-input')
    }
  })

  it('请求体不是合法 JSON → 400', async () => {
    const res = await api(ctx, 'POST', '/api/auth/login', { rawBody: '{not json' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation/invalid-input')
  })

  it('未知路由 404（含 /api 下的按标识路径，不泄露资源是否存在）', async () => {
    for (const path of ['/api/nope', `/api/members/${bob.id}`, `/api/auth/me/extra`]) {
      const res = await api(ctx, 'GET', path, { token: alice.token })
      expect(res.status, path).toBe(404)
      expect(res.body.error.code).toBe('not-found')
    }
  })

  it('响应头：Content-Type 与 CSP（ADR-008 §6）', async () => {
    const res = await api(ctx, 'GET', '/api/setup/status')
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-powered-by')).toBeNull()
  })
})

describe('独立验证后的补遗条款（ADR-008 §8 补遗 1–9）', () => {
  it('防爆破按用户名原样分桶：锁死 ALICE 不影响 alice（补遗 3）', async () => {
    const fresh = await startTestServer()
    try {
      const owner = await createOwnerAccount(fresh, 'casey', 'casey-password-1', '凯西')
      await createMemberAccount(fresh, owner.token, 'ALICE', 'alice-upper-pw-1', '大写')
      await createMemberAccount(fresh, owner.token, 'alice', 'alice-lower-pw-1', '小写')

      for (let i = 1; i <= 5; i += 1) {
        const res = await api(fresh, 'POST', '/api/auth/login', {
          body: { username: 'ALICE', password: 'wrong-password' },
        })
        expect(res.status, `第 ${i} 次`).toBe(401)
      }
      const locked = await api(fresh, 'POST', '/api/auth/login', {
        body: { username: 'ALICE', password: 'alice-upper-pw-1' },
      })
      expect(locked.status).toBe(429)

      const other = await api(fresh, 'POST', '/api/auth/login', {
        body: { username: 'alice', password: 'alice-lower-pw-1' },
      })
      expect(other.status).toBe(200)
      expect(other.body.user.username).toBe('alice')
    } finally {
      await fresh.close()
    }
  })

  it('拒绝纯空白口令，但不 trim 的语义不变（补遗 7）', async () => {
    const fresh = await startTestServer()
    try {
      const blank = await api(fresh, 'POST', '/api/setup/owner', {
        body: { username: 'owner1', password: ' '.repeat(8), displayName: '主' },
      })
      expect(blank.status).toBe(400)
      expect(blank.body.error.code).toBe('validation/invalid-input')

      const owner = await createOwnerAccount(fresh, 'owner2', 'owner2-password-1', '主')
      const invite = await api(fresh, 'POST', '/api/invites', { token: owner.token, body: {} })
      const code = invite.body.invite.code

      const blankRegister = await api(fresh, 'POST', '/api/auth/register', {
        body: { username: 'blanky', password: '\t  \n\t  \n', displayName: '空白', inviteCode: code },
      })
      expect(blankRegister.status).toBe(400)
      expect(blankRegister.body.error.code).toBe('validation/invalid-input')

      // 被拒的注册不消耗邀请码
      const retry = await api(fresh, 'POST', '/api/auth/register', {
        body: { username: 'blanky', password: 'pass word 1234', displayName: '正常', inviteCode: code },
      })
      expect(retry.status).toBe(200)

      // 口令里的空格是有效字符（不 trim）：必须按原样比对
      expect(
        (
          await api(fresh, 'POST', '/api/auth/login', {
            body: { username: 'blanky', password: 'pass word 1234' },
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await api(fresh, 'POST', '/api/auth/login', {
            body: { username: 'blanky', password: 'password1234' },
          })
        ).status,
      ).toBe(401)
    } finally {
      await fresh.close()
    }
  })

  it('邀请码「不存在」与「已过期」文案与错误码完全一致（补遗 8）', async () => {
    const absent = await api(ctx, 'POST', '/api/auth/register', {
      body: {
        username: 'probe9',
        password: 'password-1234',
        displayName: '探针',
        inviteCode: 'NOPE-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE-NOP',
      },
    })
    expect(absent.status).toBe(400)

    const invite = await api(ctx, 'POST', '/api/invites', { token: alice.token, body: {} })
    ctx.db
      .prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00+08:00', invite.body.invite.id)
    const expired = await api(ctx, 'POST', '/api/auth/register', {
      body: {
        username: 'probe9',
        password: 'password-1234',
        displayName: '探针',
        inviteCode: invite.body.invite.code,
      },
    })

    expect(expired.status).toBe(400)
    expect(expired.body.error.code).toBe('invite/invalid')
    expect(expired.body).toEqual(absent.body) // 文案不得有差异，否则泄露「该码曾经存在」
  })

  it('库中「有 member、无 owner」时用已存在的用户名引导 → 409 而不是 500（补遗：与注册对齐）', async () => {
    const fresh = await startTestServer()
    try {
      const owner = await createOwnerAccount(fresh, 'harry', 'harry-password-1', '哈利')
      await createMemberAccount(fresh, owner.token, 'iris', 'iris-password-1', '艾里斯')
      // 造出「有 member、无 owner」的库形态
      fresh.db.prepare("DELETE FROM users WHERE role = 'owner'").run()
      expect((await api(fresh, 'GET', '/api/setup/status')).body).toEqual({ needsOwner: true })

      const res = await api(fresh, 'POST', '/api/setup/owner', {
        body: { username: 'iris', password: 'another-password-1', displayName: '重复' },
      })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict/username-taken')
    } finally {
      await fresh.close()
    }
  })

  it('请求日志记录完整路径（补遗 9），且不含令牌与口令', async () => {
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    const fresh = await startTestServer({}, { logRequests: true })
    try {
      const owner = await createOwnerAccount(fresh, 'loggy', 'loggy-password-1', '日志')
      await api(fresh, 'GET', '/api/members', { token: owner.token })
      await api(fresh, 'GET', '/api/invites', { token: owner.token })
      await api(fresh, 'POST', '/api/auth/logout', { token: owner.token })
      await api(fresh, 'GET', '/api/auth/me', { token: owner.token })
    } finally {
      await fresh.close()
      spy.mockRestore()
    }
    const text = logged.join('\n')
    // 关键：成功请求也必须带完整挂载前缀（原实现在 finish 里读 req.path，全被剥成 "/"）
    expect(text).toContain('GET /api/members 200')
    expect(text).toContain('GET /api/invites 200')
    expect(text).toContain('POST /api/auth/logout 204')
    expect(text).not.toMatch(/^GET \/ 200$/m)
    expect(text).not.toMatch(/^GET \/me 200$/m)
    expect(text).not.toContain('loggy-password-1')
    expect(text).not.toMatch(/Bearer /)
  })
})

describe('令牌存储形态', () => {
  it('库中只有令牌的 SHA-256，没有明文', async () => {
    const session = await api(ctx, 'POST', '/api/auth/login', {
      body: { username: 'alice', password: 'alice-password-1' },
    })
    const token = session.body.token as string
    const rows = ctx.db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>
    const hashes = rows.map((r) => r.token_hash)
    expect(hashes).not.toContain(token)
    const { createHash } = await import('node:crypto')
    expect(hashes).toContain(createHash('sha256').update(token, 'utf8').digest('hex'))
  })

  it('用户表不含明文口令，且 password_hash 是 scrypt 参数化串', () => {
    const rows = ctx.db.prepare('SELECT username, password_hash FROM users').all() as Array<{
      username: string
      password_hash: string
    }>
    for (const row of rows) {
      expect(row.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/)
    }
    expect(JSON.stringify(rows)).not.toContain('alice-password-1')
    expect(JSON.stringify(rows)).not.toContain('member-password-1')
  })
})
