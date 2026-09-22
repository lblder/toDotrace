import fs from 'node:fs'
import path from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import { LoginThrottle } from './domain/login-throttle.js'
import { createRequireAuth, requireOwner } from './middleware/auth.js'
import { notFound } from './lib/errors.js'
import { createErrorHandler, notFoundHandler } from './middleware/error.js'
import { securityHeaders } from './middleware/security.js'
import { authRoutes } from './routes/auth.js'
import { checkinRoutes } from './routes/checkin.js'
import { inviteRoutes } from './routes/invites.js'
import { memberRoutes } from './routes/members.js'
import { setupRoutes } from './routes/setup.js'

export interface AppOptions {
  db: Db
  config: Config
  /** 防爆破计数器；测试可注入自己的实例。 */
  throttle?: LoginThrottle
  /** 错误日志出口；测试可静音。 */
  logError?: (message: string, detail: unknown) => void
  /** 请求日志开关；测试可关掉以获得干净输出。 */
  logRequests?: boolean
}

/**
 * 组装 Express 应用。
 *
 * 顺序即安全边界：
 *   安全响应头 → API 解析与路由 → /api 未命中即 404（绝不落到静态）→
 *   生产态静态资源 → SPA 回退 → 统一错误信封。
 *
 * dev 态**只提供 API**：前端由 vite dev server 提供（开发文档 §8），
 * 服务端不猜前端的开发地址、也不做任何转发。
 */
export function createApp(options: AppOptions): Express {
  const { db, config } = options
  const throttle = options.throttle ?? new LoginThrottle({
    maxFailures: config.loginMaxFailures,
    lockMs: config.loginLockMs,
  })

  const app = express()
  app.disable('x-powered-by')
  app.disable('etag')
  app.use(securityHeaders())

  // 请求日志：只记录方法、路径、状态、耗时——**永不记录请求体/令牌**（架构文档 §9 必做 1）。
  if (options.logRequests !== false) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const startedAt = process.hrtime.bigint()
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
        // 必须用 originalUrl 而不是 path：finish 回调里 Express 仍处在挂载的路由器内部，
        // req.path 已被剥掉挂载前缀，`GET /api/members` 会记成 `GET /`——这条日志是
        // 「无令牌请求一律被拒」的取证依据（ADR-008 §8 补遗 9），路径失真即证据失效。
        // 只取路径部分：查询串本阶段无用，且可能被用来夹带敏感值，一律不记。
        const pathOnly = req.originalUrl.split('?')[0] || '/'
        console.log(`${req.method} ${pathOnly} ${res.statusCode} ${ms.toFixed(1)}ms`)
      })
      next()
    })
  }

  const requireAuth = createRequireAuth(db, config)
  // OPTIONS 关口专用：只读鉴权，不续期、不 touch（ADR-008 §8 补遗 10）。
  const requireAuthReadOnly = createRequireAuth(db, config, { readOnly: true })

  app.use('/api', (_req, res, next) => {
    // 令牌在响应体里，任何中间缓存都不该留存。
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  // OPTIONS 一律不得免鉴权（ADR-008 §8 补遗 5）：Express 的路由级默认 OPTIONS 处理器
  // 会在未鉴权时返回 `200 Allow: ...`，字面违反「无令牌请求一律被拒」——而验收标准
  // 一旦需要「除了……之外」的注解就不再可机械核对。在路由挂载前先拦下：
  // 无令牌 → 401，有令牌 → 404（本阶段没有任何 OPTIONS 入口），响应里不带 Allow。
  // 放在这里也意味着路由器根本收不到 OPTIONS，默认处理器没有触发机会。
  // 用只读鉴权（补遗 10）：OPTIONS 一律不写库——否则一个 404 会顺带续期会话、
  // 把「最近活跃」顶到当前时间；无令牌 401 / 有令牌 404 / 伪造令牌 401 三者不变。
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'OPTIONS') {
      next()
      return
    }
    requireAuthReadOnly(req, res, (error?: unknown) => {
      next(error ?? notFound())
    })
  })

  app.use('/api', express.json({ limit: '64kb' }))

  app.use('/api/setup', setupRoutes(db, config))
  app.use('/api/auth', authRoutes(db, config, throttle, requireAuth))
  app.use('/api/invites', inviteRoutes(db, config, requireAuth, requireOwner))
  app.use('/api/members', memberRoutes(db, requireAuth, requireOwner))
  app.use('/api/checkin', checkinRoutes(db, requireAuth))
  app.use('/api', notFoundHandler)

  if (config.isProduction) {
    mountStatic(app, config)
  }

  app.use(createErrorHandler(options.logError ? { log: options.logError } : {}))
  return app
}

/** 生产态：托管 dist/ 静态资源并做 SPA 回退（index.html 之外的路径交给前端路由）。 */
function mountStatic(app: Express, config: Config): void {
  const indexHtml = path.join(config.staticDir, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    console.warn(`[warn] 生产态未找到前端产物：${indexHtml}（仅提供 API）`)
    return
  }
  app.use(express.static(config.staticDir, { index: ['index.html'] }))
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }
    if (req.path.startsWith('/api/')) {
      next()
      return
    }
    res.sendFile(indexHtml)
  })
}
