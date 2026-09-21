import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@playwright/test'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DIST = path.join(REPO_ROOT, 'dist')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

/** 一套「服务端 + 前端产物」的完整栈，监听在一个临时端口上。 */
export interface Stack {
  /** 形如 http://127.0.0.1:53421 —— 前端与 API 同源（生产就是同源，ADR-008 不用 Cookie） */
  readonly baseUrl: string
  /** 临时库路径，只用于断言「没碰 data/app.db」 */
  readonly dbPath: string
  readonly apiPort: number
  stop(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 让内核分配一个空闲端口。绑定 0 拿到端口后立刻释放，紧接着交给服务端用。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (port === 0) reject(new Error('拿不到空闲端口'))
        else resolve(port)
      })
    })
  })
}

async function waitReady(child: ChildProcess, baseUrl: string, logs: string[]): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError = '（还没发出请求）'
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`服务端启动即退出（code=${child.exitCode}）：\n${logs.join('')}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/setup/status`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`服务端 30s 内未就绪（最后错误：${lastError}）：\n${logs.join('')}`)
    }
    await sleep(120)
  }
}

async function stopStack(child: ChildProcess, dir: string): Promise<void> {
  if (child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(force)
  }
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 起一套栈：**临时库 + 临时端口**，生产模式（同源提供 API 与前端产物）。
 *
 * 环境变量是服务端唯一的配置来源（server/config.ts），这里全部显式给到：
 *   NODE_ENV=production       → 服务端托管 dist/，与线上同构
 *   TODOAGENT_API_PORT        → 临时端口
 *   TODOAGENT_DB_PATH         → mktemp 目录下的库文件（绝不碰 data/app.db）
 *   TODOAGENT_STATIC_DIR      → 刚构建好的 dist/
 *
 * 端口偶发被抢占时重试：freePort 到服务端 bind 之间有一瞬窗口。
 */
export async function startStack(): Promise<Stack> {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/index.html 不存在——globalSetup 的构建没跑？')
  }

  let lastFailure: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ta-e2e-'))
    const dbPath = path.join(dir, 'e2e.db')
    const apiPort = await freePort()
    const baseUrl = `http://127.0.0.1:${apiPort}`

    const child = spawn(TSX, ['server/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TODOAGENT_API_PORT: String(apiPort),
        TODOAGENT_DB_PATH: dbPath,
        TODOAGENT_STATIC_DIR: DIST,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const logs: string[] = []
    child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
    child.stderr?.on('data', (chunk) => logs.push(String(chunk)))

    try {
      await waitReady(child, baseUrl, logs)
      return { baseUrl, dbPath, apiPort, stop: () => stopStack(child, dir) }
    } catch (error) {
      lastFailure = error
      await stopStack(child, dir)
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure))
}

/**
 * 每个测试文件一套栈（beforeAll 起、afterAll 停）。
 *
 * Playwright 没有「文件级 fixture」，所以用 beforeAll/afterAll 显式表达：
 * 同一文件的用例按声明顺序共用一套栈（内部可以用 describe.serial 表达依赖），
 * 跨文件则互不影响——临时库是各自新建的。
 *
 * 返回值是个取值函数而不是栈本身：栈在 beforeAll 里才存在。
 */
export function useStack(): () => Stack {
  let stack: Stack | undefined

  test.beforeAll(async () => {
    stack = await startStack()
  })

  test.afterAll(async () => {
    const running = stack
    stack = undefined
    if (running !== undefined) await running.stop()
  })

  return () => {
    if (stack === undefined) {
      throw new Error('服务栈尚未启动：useStack() 的 beforeAll 没跑到（文件里一条用例都没有？）')
    }
    return stack
  }
}
