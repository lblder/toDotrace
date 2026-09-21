import { closeDb, getDb, initDb, openDatabase, type Db } from './connection.js'
import { migrate, SCHEMA_VERSION } from './schema.js'

/**
 * 数据层的唯一入口：应用代码只从这里拿连接（ADR-003 §1）。
 * 连接工厂本身在 connection.ts，那里是全进程唯一 `new Database(...)` 的地方。
 */

export { closeDb, getDb, initDb, openDatabase, migrate, SCHEMA_VERSION }
export type { Db }

/** 打开（必要时创建）数据库并完成模式初始化。 */
export function initializeDatabase(dbPath: string): Db {
  const db = initDb(dbPath)
  migrate(db)
  return db
}

/** 测试用：建一个独立的临时库（不占用进程单例）。 */
export function openMigratedDatabase(dbPath: string): Db {
  const db = openDatabase(dbPath)
  migrate(db)
  return db
}
