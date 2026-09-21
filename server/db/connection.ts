import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * 数据库连接工厂——**全进程唯一开连接的地方**（ADR-003 §1 / ADR-008 §3）。
 *
 * 两条纪律在这里一次性落实，任何模块都不得自行 `new Database(...)` 绕过：
 *   1. `journal_mode = WAL`：读不阻塞写（架构文档 §10 要求统计即时响应）；
 *   2. `foreign_keys = ON`：**每个连接建立时即开启**，不依赖建表时的声明
 *      （架构文档 §11 教训 3：外键声明了但从未开启，级联删除全部失效）。
 *
 * 本文件之外出现 `new Database(` 即为违规，可用
 *   grep -rn "new Database(" server --include=*.ts
 * 核对（应只有本文件一处）。
 */

export type Db = Database.Database

/** 建立连接并施加连接级 PRAGMA。导出仅为测试与运维脚本使用；应用代码请用 getDb()。 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new Database(dbPath)
  // 连接即开外键：每个连接都要设，这是连接级开关，不是库级属性。
  db.pragma('foreign_keys = ON')
  // WAL 是库级持久属性，但对每个新连接执行一次是幂等且自证的。
  db.pragma('journal_mode = WAL')
  // 单进程服务：写等待用忙等重试兜底（快照 / 备份与本进程并发时）。
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  return db
}

let instance: Db | null = null

/** 进程级单例连接。所有数据访问模块经由它取连接。 */
export function getDb(): Db {
  if (instance === null) {
    throw new Error('数据库尚未初始化：请先调用 initDb()（见 server/db/index.ts）')
  }
  return instance
}

export function initDb(dbPath: string): Db {
  if (instance !== null) return instance
  instance = openDatabase(dbPath)
  return instance
}

export function closeDb(): void {
  if (instance !== null) {
    instance.close()
    instance = null
  }
}

/** 供测试使用：断言连接级纪律确实生效。 */
export function assertConnectionDiscipline(db: Db): { journalMode: string; foreignKeys: number } {
  return {
    journalMode: String(db.pragma('journal_mode', { simple: true })),
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
  }
}
