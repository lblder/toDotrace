import { closeExpiredAttendance } from './checkin/boundary.js'
import { listUsers } from './repo/users.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { closeDb, getDb, initializeDatabase } from './db/index.js'
import { backfillAccountSettings } from './events/data-migration.js'

/**
 * 服务端入口（开发文档 §1：单进程，静态托管与 API 同源）。
 *
 * 启动顺序：读配置 → 开库（连接即开 WAL 与外键）→ 建表/迁移 → **数据迁移** → 起 HTTP。
 * 任何一步失败都直接退出并打印原因，不做「带病启动」。
 */
function main(): void {
  const config = loadConfig()

  initializeDatabase(config.dbPath)
  const db = getDb()

  // 数据迁移（ADR-010 §7）：模式迁移是纯 DDL，补领域事实是事件层的职责，故分两步。
  // 为存量账号补写 settings/updated——时区取**此刻**的服务端本地时区，此后不再重算。
  // 幂等：判据是事件存在性，重复启动不会写出第二条。
  const backfilled = backfillAccountSettings(db)
  if (backfilled.length > 0) {
    console.log(`数据迁移：为 ${backfilled.length} 个存量账号补写了初始化设置事件`)
  }

  const app = createApp({ db, config })
  // Private upgrade rehearsals disable jobs while verifying the untouched backup.
  const boundaryJob = process.env.TODOAGENT_DISABLE_JOBS === '1' ? undefined : setInterval(() => {
    for (const user of listUsers(db)) {
      try { db.transaction(() => closeExpiredAttendance(db, user.id, new Date()))() }
      catch (error) { console.error('日界自动离开失败', error) }
    }
  }, 10_000)
  boundaryJob?.unref()
  let startupFailed = false

  const server = app.listen(config.port, config.host, () => {
    // macOS 上「地址已被占用」的 EADDRINUSE 会在 listening **之后**才异步抛出，
    // 直接把横幅打在 listening 里会先报「已启动」再报错。推迟一拍并检查失败标志。
    setTimeout(() => {
      if (startupFailed) return
      console.log(`TodoAgent 服务已启动：http://${config.host}:${config.port}`)
      console.log(`数据库：${config.dbPath}`)
      console.log(
        config.isProduction
          ? `静态资源：${config.staticDir}`
          : '运行模式：dev（仅提供 API，前端由 vite dev server 提供）',
      )
    }, 100)
  })

  // 端口被占用是「双击启动」最容易踩到的失败：给出可照做的下一步，而不是一段堆栈。
  server.on('error', (error: NodeJS.ErrnoException) => {
    startupFailed = true
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[错误] 端口 ${config.port} 已被其他程序占用，服务未启动。\n` +
          `       换个端口：TODOAGENT_API_PORT=8788 npm start\n` +
          `       （dev 下前端代理读的是同名变量；也可用 lsof -nP -iTCP:${config.port} -sTCP:LISTEN 查看占用者）`,
      )
    } else {
      console.error('[错误] 服务启动失败：', error)
    }
    closeDb()
    process.exit(1)
  })

  const shutdown = (signal: string): void => {
    clearInterval(boundaryJob)
    console.log(`\n收到 ${signal}，正在关闭…`)
    server.close(() => {
      closeDb()
      process.exit(0)
    })
    // 兜底：连接迟迟不释放也不要卡住终端。
    setTimeout(() => {
      closeDb()
      process.exit(0)
    }, 3000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
