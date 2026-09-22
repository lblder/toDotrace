import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** 到目前为止捕获的服务端 stdout/stderr（失败时由 serverLogOnFailure 挂出去） */
  serverLog(): string
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

async function stopStack(child: ChildProcess, dir: string, state: StackState): Promise<void> {
  // 已经退出就不要再等了。**被信号杀死时 `exitCode` 仍是 null**，只有 `signalCode` 有值——
  // 只看 exitCode 会把「早就没了」当成「还在跑」，而 exit 事件不会来第二次，
  // 于是这里的 await 永不返回：teardown 挂死，连带临时目录也留了下来。
  if (child.exitCode === null && child.signalCode === null) {
    // 先立旗再杀：否则下面的 exit 钩子会把一次正常收工报成「意外退出」
    state.stopping = true
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(force)
  }
  rmSync(dir, { recursive: true, force: true })
}

/** 一套栈的运行时状态：日志缓冲区 + 「是不是我们主动停的」 */
interface StackState {
  readonly logs: string[]
  stopping: boolean
}

/**
 * 产物指纹：`dist/index.html` 的 sha256 前 12 位。
 *
 * 全部测试共用的可写资源只有 `dist/` 一个——并发的另一次 `vite build`
 * 会在脚下把产物换掉，而这类事情的现场特征是「谁都说不清当时跑的是哪份产物」。
 * 指纹随日志一起留下（见 serverLogOnFailure），于是「两次运行拿到的是不是同一份产物」
 * 从推测变成可对照的事实。
 */
function distFingerprint(): string {
  try {
    return createHash('sha256').update(readFileSync(path.join(DIST, 'index.html'))).digest('hex').slice(0, 12)
  } catch {
    return '（读不到 dist/index.html）'
  }
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

    const state: StackState = { logs: [], stopping: false }
    const logs = state.logs
    logs.push(`[harness] 前端产物 dist/index.html sha256=${distFingerprint()}\n`)
    child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
    child.stderr?.on('data', (chunk) => logs.push(String(chunk)))

    /*
     * 进程中途死掉也要在日志里留一条。
     * 没有这一条时，「服务端崩了」与「服务端什么都没说」在日志里长得一模一样——
     * 而连接被拒的报错出现在浏览器那一侧，看的人只会以为是前端的问题。
     */
    child.once('exit', (code, signal) => {
      logs.push(
        state.stopping
          ? `[harness] 服务端已停止（${signal ?? `code=${code}`}）\n`
          : `[harness] ⚠️ 服务端进程**意外退出**：code=${code} signal=${signal}\n`,
      )
    })

    try {
      await waitReady(child, baseUrl, logs)
      return {
        baseUrl,
        dbPath,
        apiPort,
        serverLog: () => logs.join(''),
        stop: () => stopStack(child, dir, state),
      }
    } catch (error) {
      lastFailure = error
      await stopStack(child, dir, state)
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure))
}

/**
 * 用例失败时，把已捕获的服务端日志**吐出来**（终端 + test-results/ 附件）。
 *
 * 起因是一次真实的失败现场：界面里是服务端的错误信封 `{"error":{"code":"server/internal-error"}}`，
 * 而服务端那一侧什么都没留下——「那个 500 是哪个请求、它当时在干什么」于是无从查起。
 * 日志其实一直在收（startStack 把 stdout/stderr 收进 logs），只是从前**只在启动失败时**才抛出。
 * 服务端每个请求都会打一行 `方法 路径 状态 耗时`（server/app.ts 的请求日志），
 * 所以只要把这段日志拿在手上，500 就不再是黑盒。
 *
 * 两处都写：终端里直接看得见（list reporter 会转发用例的 stdout），
 * 同时挂成该用例的附件落到 test-results/ 下，与截图、trace 放在一起。
 *
 * 一个文件里多条用例失败时，只有第一条会把日志完整打一遍（附件则每条都有）——
 * 同一份日志刷十遍会把真正要看的那一行淹掉。
 *
 * **必须在文件或 describe 的作用域里调用**（与 useStack 同样的限制）：它注册的是 afterEach 钩子。
 */
export function serverLogOnFailure(getStacks: () => readonly (Stack | undefined)[]): void {
  let printed = false

  test.afterEach(async ({}, testInfo) => {
    // skipped 不算：serial 里被前面拖累而跳过的用例没有自己的失败现场
    if (testInfo.status !== 'failed' && testInfo.status !== 'timedOut') return

    const stacks = getStacks().filter((candidate): candidate is Stack => candidate !== undefined)
    if (stacks.length === 0) return

    const many = stacks.length > 1
    const reports = stacks.map((stack, index) => ({
      name: many ? `server-${index + 1}.log` : 'server.log',
      log: stack.serverLog(),
    }))

    // 落盘一份到该用例的产物目录（test-results/<用例>/），与截图、trace 摆在一起。
    // 附件只带 body 时 Playwright 不会把它写成文件（list reporter 是把它打在终端上的），
    // 所以这一步单独做——不然「写进 test-results/」只是句空话。
    for (const report of reports) writeFileSync(testInfo.outputPath(report.name), report.log)

    await Promise.all(
      reports.map((report) =>
        testInfo.attach(report.name, { body: report.log, contentType: 'text/plain' }),
      ),
    )

    if (printed) {
      console.log('[harness] 服务端日志同上（已挂到 test-results/ 的附件里）')
      return
    }
    printed = true

    const rule = '─'.repeat(72)
    const blocks = stacks.map(
      (stack, index) => `${many ? `── 栈 #${index + 1} ${stack.baseUrl} ──\n` : ''}${stack.serverLog()}`,
    )
    console.log(`\n${rule}\n[harness] 用例失败：${testInfo.title}\n[harness] 服务端日志\n${rule}\n${blocks.join('\n')}${rule}\n`)
  })
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

  // 失败时带上服务端日志（见上）
  serverLogOnFailure(() => [stack])

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
