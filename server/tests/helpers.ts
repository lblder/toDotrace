import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Express } from 'express'
import { createApp } from '../app.js'
import type { Config } from '../config.js'
import { openMigratedDatabase, type Db } from '../db/index.js'
import type { LoginThrottle } from '../domain/login-throttle.js'

/** 测试专用配置：短锁定窗口以外的取值与生产一致。 */
export function testConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    dbPath,
    staticDir: path.join(path.dirname(dbPath), 'dist'),
    isProduction: false,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
    loginMaxFailures: 5,
    loginLockMs: 15 * 60 * 1000,
    ...overrides,
  }
}

export interface TestContext {
  db: Db
  config: Config
  app: Express
  server: Server
  baseUrl: string
  dir: string
  throttle: LoginThrottle
  close: () => Promise<void>
}

/** 每个测试文件一个独立临时库 + 一个真实监听（端口 0）的服务实例。 */
export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoagent-test-'))
  const dbPath = path.join(dir, 'app.db')
  const db = openMigratedDatabase(dbPath)
  const config = testConfig(dbPath, overrides)
  const { LoginThrottle } = await import('../domain/login-throttle.js')
  const throttle = new LoginThrottle({
    maxFailures: config.loginMaxFailures,
    lockMs: config.loginLockMs,
  })
  const app = createApp({ db, config, throttle, logError: () => {}, logRequests: false })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const address = server.address() as AddressInfo
  return {
    db,
    config,
    app,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dir,
    throttle,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export interface ApiResponse {
  status: number
  headers: Headers
  body: any
}

export async function api(
  ctx: TestContext,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`
  let body: string | undefined
  if (options.rawBody !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = options.rawBody
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const res = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body })
  const text = await res.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: res.status, headers: res.headers, body: parsed }
}

export interface Account {
  id: string
  username: string
  token: string
}

/** 建 owner（走首启引导），返回账号与令牌。 */
export async function createOwnerAccount(
  ctx: TestContext,
  username = 'alice',
  password = 'alice-password-1',
  displayName = '爱丽丝',
): Promise<Account> {
  const res = await api(ctx, 'POST', '/api/setup/owner', { body: { username, password, displayName } })
  if (res.status !== 200) throw new Error(`创建 owner 失败：${res.status} ${JSON.stringify(res.body)}`)
  return { id: res.body.user.id, username, token: res.body.token }
}

/** 签发邀请码并用它注册一个 member，返回账号与令牌。 */
export async function createMemberAccount(
  ctx: TestContext,
  ownerToken: string,
  username: string,
  password = 'member-password-1',
  displayName = '成员',
): Promise<Account> {
  const invite = await api(ctx, 'POST', '/api/invites', { token: ownerToken, body: {} })
  if (invite.status !== 200) throw new Error(`签发邀请码失败：${invite.status}`)
  const res = await api(ctx, 'POST', '/api/auth/register', {
    body: { username, password, displayName, inviteCode: invite.body.invite.code },
  })
  if (res.status !== 200) throw new Error(`注册失败：${res.status} ${JSON.stringify(res.body)}`)
  return { id: res.body.user.id, username, token: res.body.token }
}
