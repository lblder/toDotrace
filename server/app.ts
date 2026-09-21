import fs from 'node:fs'
import path from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import type { Config } from './config.js'
import type { Db } from './db/index.js'
import { LoginThrottle } from './domain/login-throttle.js'
import { createRequireAuth, requireOwner } from './middleware/auth.js'
import { createErrorHandler, notFoundHandler } from './middleware/error.js'
import { securityHeaders } from './middleware/security.js'
import { authRoutes } from './routes/auth.js'
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
        // req.path 不含查询串；本阶段路由无查询参数，令牌只走请求头。
        console.log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`)
      })
      next()
    })
  }

  const requireAuth = createRequireAuth(db, config)

  app.use('/api', (_req, res, next) => {
    // 令牌在响应体里，任何中间缓存都不该留存。
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use('/api', express.json({ limit: '64kb' }))

  app.use('/api/setup', setupRoutes(db, config))
  app.use('/api/auth', authRoutes(db, config, throttle, requireAuth))
  app.use('/api/invites', inviteRoutes(db, config, requireAuth, requireOwner))
  app.use('/api/members', memberRoutes(db, requireAuth, requireOwner))
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
