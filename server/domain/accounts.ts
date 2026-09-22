import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { appendEvents } from '../events/append.js'
import { initialSettingsDraft } from '../events/settings.js'
import { conflict, inviteInvalid, invalidCredentials, locked } from '../lib/errors.js'
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password.js'
import { isExpired, isoAfterMsUtc, nowIsoUtc, toIsoUtc } from '../lib/time.js'
import { generateSecret, hashSecret } from '../lib/token.js'
import { uuidv7 } from '../lib/uuid.js'
import type { LoginThrottle } from './login-throttle.js'
import { findInviteByCodeHash, insertInvite, markInviteUsed } from '../repo/invites.js'
import { insertSession, deleteSessionByTokenHash } from '../repo/sessions.js'
import {
  findUserById,
  findUserByUsername,
  insertUser,
  ownerExists,
  toPublicUser,
  touchLastSeen,
  type PublicUser,
  type UserRow,
} from '../repo/users.js'

/**
 * 账号域逻辑：首启引导、登录、登出、凭邀请码注册、签发邀请码。
 *
 * 路由层保持薄——这里不碰 req / res，只接收已经过 zod 校验的入参。
 */

export interface AuthSuccess {
  user: PublicUser
  token: string
}

/**
 * 令牌明文只在此处产生、只在签发响应里出现一次；库中只存 SHA-256（ADR-008 §4）。
 *
 * 时间列一律 **UTC 口径**（ADR-010 §1 收窄后的账号域口径）：`sessions` 只记
 * 「什么时候建的、什么时候到期」，都是绝对时刻，没有归属日可言。
 */
function issueSession(db: Db, config: Config, user: UserRow): { token: string; expiresAt: string } {
  const token = generateSecret()
  const now = nowIsoUtc()
  const expiresAt = isoAfterMsUtc(config.sessionTtlMs)
  insertSession(db, {
    id: uuidv7(),
    userId: user.id,
    tokenHash: hashSecret(token),
    createdAt: now,
    expiresAt,
  })
  return { token, expiresAt }
}

/** 唯一约束冲突的兜底识别：并发或「有 member 无 owner」的库形态下，把 500 变成 409。 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  )
}

/**
 * 首启引导建 owner（ADR-008 §2）：**仅当库中无 owner 时可用**。
 * 检查在事务内双重执行——并发的两个引导请求只会成功一个。
 *
 * ownerExists 只闸「有没有 owner」，不闸「这个用户名是否已被 member 占着」：
 * 库形态为「有 member、无 owner」时（例如 owner 被删、或从别处拷来的库），
 * 用已存在的用户名引导会撞 users.username 的 UNIQUE。此时必须兜底成 409，
 * 口径与 registerWithInvite 一致，而不是把约束错误漏成 500。
 */
export async function createOwner(
  db: Db,
  config: Config,
  input: { username: string; password: string; displayName: string },
): Promise<AuthSuccess> {
  // 慢哈希放在事务外：不把 ~50ms 的 CPU 时间按在写锁上。
  const passwordHash = await hashPassword(input.password)
  const id = uuidv7()
  // 一个瞬间，两种口径——**它们不能共用一个串**（ADR-010 §1）：
  //   - `users.created_at` 是账号域列 → UTC（`toIsoUtc`）；
  //   - 同一事务里那条 `settings/updated` 事件行的 `occurred_at` → 账号时区，且必须
  //     与该行自己的 `timezone` 列同源（由 `initialSettingsDraft` 内部渲染，这里只传时刻）。
  // 曾经这里是同一个 `nowIso()` 串喂两处：进程时区一变，事件行的 `occurred_at` 偏移
  // 就与它的 `timezone` 列对不上，四列不再自洽。
  const now = new Date()
  const createdAt = toIsoUtc(now)

  const create = db.transaction((): UserRow => {
    if (ownerExists(db)) {
      throw conflict('conflict/owner-exists', '已完成初始化，不能重复创建所有者')
    }
    insertUser(db, {
      id,
      username: input.username,
      displayName: input.displayName,
      role: 'owner',
      passwordHash,
      createdAt,
    })
    // 账号的初始化设置事件（ADR-010 §6/§7）：`settings` 表的唯一来源。
    // 与用户创建**同一个事务**——否则会留下一个没有任何设置事实的账号。
    appendEvents(db, id, [initialSettingsDraft(now)])
    const created = findUserById(db, id)
    if (!created) throw new Error('创建所有者后读取失败')
    return created
  })

  let user: UserRow
  try {
    user = create()
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('conflict/username-taken', '用户名已被占用')
    }
    throw error
  }

  const { token } = issueSession(db, config, user)
  return { user: toPublicUser(user), token }
}

/**
 * 登录（含防爆破，ADR-008 §5）。
 * 用户名不存在时也走一次同等开销的假校验，抹平「账号是否存在」的时序差异。
 */
export async function login(
  db: Db,
  config: Config,
  throttle: LoginThrottle,
  input: { username: string; password: string },
): Promise<AuthSuccess> {
  const lockedForMs = throttle.lockedForMs(input.username)
  if (lockedForMs !== null) {
    throw locked(Math.ceil(lockedForMs / 1000))
  }

  const user = findUserByUsername(db, input.username)
  let ok = false
  if (user) {
    ok = await verifyPassword(input.password, user.password_hash)
  } else {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH)
  }

  if (!user || !ok) {
    throttle.recordFailure(input.username)
    throw invalidCredentials()
  }

  throttle.recordSuccess(input.username)

  // last_seen_at 是账号域列 → UTC 口径（ADR-010 §1）。
  touchLastSeen(db, user.id, nowIsoUtc())

  const { token } = issueSession(db, config, user)
  return { user: toPublicUser(user), token }
}

/**
 * 凭邀请码注册（架构文档 §3.2 注册闸门）。
 * 邀请码有效性先于用户名冲突检查——没有有效邀请码的人不该能探测用户名是否被占用。
 */
export async function registerWithInvite(
  db: Db,
  config: Config,
  input: { username: string; password: string; displayName: string; inviteCode: string },
): Promise<AuthSuccess> {
  const codeHash = hashSecret(input.inviteCode)
  const invite = findInviteByCodeHash(db, codeHash)
  if (!invite) throw inviteInvalid()
  if (invite.used_by !== null) throw conflict('conflict/invite-used', '邀请码已被使用')
  // 「不存在」与「已过期」必须同一文案（ADR-008 §8 补遗 8）：错误码本就同为一个
  // invite/invalid，文案差异却泄露「该码曾经存在」——成为探测邀请码的手段。
  if (isExpired(invite.expires_at)) throw inviteInvalid()

  const passwordHash = await hashPassword(input.password)
  const id = uuidv7()
  // 同 createOwner：一个瞬间两种口径——`users.created_at` 与 `invites.used_at`（账号域）走 UTC，
  // 同事务里的 `settings/updated` 事件行由 `initialSettingsDraft` 按账号时区渲染。
  const now = new Date()
  const createdAt = toIsoUtc(now)

  const create = db.transaction((): UserRow => {
    // 事务内复核：并发使用时只有一个能占住邀请码。
    const fresh = findInviteByCodeHash(db, codeHash)
    if (!fresh) throw inviteInvalid()
    if (fresh.used_by !== null) throw conflict('conflict/invite-used', '邀请码已被使用')
    if (isExpired(fresh.expires_at)) throw inviteInvalid()

    if (findUserByUsername(db, input.username)) {
      throw conflict('conflict/username-taken', '用户名已被占用')
    }

    insertUser(db, {
      id,
      username: input.username,
      displayName: input.displayName,
      role: 'member',
      passwordHash,
      createdAt,
    })
    if (!markInviteUsed(db, fresh.id, id, createdAt)) {
      throw conflict('conflict/invite-used', '邀请码已被使用')
    }
    // 同 createOwner：设置事件与用户创建同事务（ADR-010 §6/§7）。
    appendEvents(db, id, [initialSettingsDraft(now)])
    const created = findUserById(db, id)
    if (!created) throw new Error('创建成员后读取失败')
    return created
  })

  let user: UserRow
  try {
    user = create()
  } catch (error) {
    // 并发下用户名唯一约束兜底（UNIQUE 冲突 → 409，而不是 500）。
    if (isUniqueConstraintError(error)) {
      throw conflict('conflict/username-taken', '用户名已被占用')
    }
    throw error
  }

  const { token } = issueSession(db, config, user)
  return { user: toPublicUser(user), token }
}

/** 登出：立即删除该会话行（ADR-008 §5）。 */
export function logout(db: Db, token: string): void {
  deleteSessionByTokenHash(db, hashSecret(token))
}

export interface IssuedInvite {
  id: string
  code: string
  expiresAt: string
}

/**
 * 签发邀请码：明文 code 只在本次响应出现一次，库中只存 SHA-256（ADR-008 §4）。
 *
 * 时间列一律 **UTC 口径**（ADR-010 §1 账号域口径）：`invites` 的 `created_at` / `expires_at`
 * 只参与绝对时刻比较（`isExpired` 走 `Date.parse`），偏移只是渲染——渲染成 UTC。
 */
export function issueInvite(db: Db, config: Config, ownerId: string, expiresInDays?: number): IssuedInvite {
  const code = generateSecret()
  const id = uuidv7()
  const createdAt = nowIsoUtc()
  const expiresAt = isoAfterMsUtc(
    expiresInDays === undefined ? config.inviteTtlMs : expiresInDays * 24 * 60 * 60 * 1000,
  )
  insertInvite(db, {
    id,
    codeHash: hashSecret(code),
    issuedBy: ownerId,
    createdAt,
    expiresAt,
  })
  return { id, code, expiresAt }
}
