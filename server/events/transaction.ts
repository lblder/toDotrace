import type { Db } from '../db/connection.js'

/**
 * 事务纪律（ADR-002 §1）：
 *
 * > 一次用户动作的全部事件与全部投影更新，在**同一 SQLite 事务**内提交；
 * > 事务由服务端在请求处理层开启，域逻辑不自行管理事务边界。
 *
 * 这条纪律若只写在文档里就是空头承诺——「事件已写、投影未更新」的中间态不会被
 * 平时的查询发现，只在下次重放时以「数字对不上」的形式浮现（架构文档 §4）。
 * 因此这里把它变成**可执行的断言**：`appendEvents` 与投影写入在调用方未开事务时直接抛错。
 *
 * 反例（阶段 1 的教训同源：声明了的机制必须真的生效）：写作
 * `appendEvents(db, id, drafts); db.transaction(() => writeProjection(...))()`
 * —— 两步各自都在事务里，合起来却不是。`db.inTransaction` 的不变量正是为它设的。
 */

/** 断言当前处在事务内。不在事务内即抛错，绝不「顺手开一个」。 */
export function assertInTransaction(db: Db, what: string): void {
  if (!db.inTransaction) {
    throw new Error(
      `${what} 必须在调用方开启的事务内执行（ADR-002 §1：事件写入与投影更新同事务）。` +
        '请把调用包在 db.transaction(...) 中——本函数不会替你开事务，' +
        '否则「一批次一事务」的边界就不再由调用方掌握。',
    )
  }
}

/**
 * 在事务内执行；已在事务内时直接执行（不叠加 SAVEPOINT）。
 * 只给 `rebuildProjection` 这类**自身有原子性要求**的兜底路径使用：
 * ADR-010 §5 规定它「全程一个事务」，而它也可能被已经开着事务的调用方（增量兜底）调用。
 */
export function runInTransaction<T>(db: Db, fn: () => T): T {
  if (db.inTransaction) return fn()
  return db.transaction(fn)()
}
