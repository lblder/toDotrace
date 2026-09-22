import { EVENT_DEFINITIONS } from './definitions/index.js'
import type { RegisteredDefinition } from './types.js'

/**
 * 事件类型注册表（ADR-010 §2）。
 *
 * **它是唯一的事件类型清单**：未登记的 `type` 一律拒绝写入——它无法被重放，
 * 写进去就是对「投影必然等于重放结果」这条不变式的破坏。
 *
 * 注册表在模块加载时由 `definitions/index.ts` 的显式清单一次性建成：
 * - 不做「各模块自行注册」的隐式副作用（那会让「登记了什么」取决于 import 顺序）；
 * - 重复登记**当场抛错**（同一个 type 两个定义 = 重放结果取决于查表顺序，必须拒绝）；
 * - Map 私有、只暴露查询函数，外部无法在运行期往注册表里塞东西。
 */

/**
 * 由清单建注册表。**导出是为了让重复登记这条守卫可被测试真的跑到**——
 * 一个只在模块加载时执行、外部无法触发分支的守卫，与「文档里写了」没有区别
 * （架构文档 §4 的教训：声明了的机制必须真的生效）。
 */
export function buildRegistry(definitions: readonly RegisteredDefinition[]): Map<string, RegisteredDefinition> {
  const built = new Map<string, RegisteredDefinition>()
  for (const definition of definitions) {
    if (built.has(definition.type)) {
      throw new Error(
        `事件类型重复登记：'${definition.type}'。同一个 type 只能有一个定义——` +
          '否则重放结果取决于查表顺序（ADR-010 §2）。',
      )
    }
    built.set(definition.type, definition)
  }
  return built
}

/** 阶段 2 的注册表：整个进程里唯一的一份。 */
const registry = buildRegistry(EVENT_DEFINITIONS)

/** 事件类型是否已登记 */
export function isRegisteredType(type: string): boolean {
  return registry.has(type)
}

/**
 * 取某 type 的定义。**未登记即抛错**——这是「未登记的 type 一律拒绝写入」的落点：
 * 写入路径（append）与重放路径（project）都必须先过这一关。
 */
export function getEventDefinition(type: string): RegisteredDefinition {
  const definition = registry.get(type)
  if (definition === undefined) {
    throw new Error(
      `未登记的事件类型 '${type}'：它无法被重放，写入即破坏「投影 = 重放结果」不变式` +
        '（ADR-010 §2）。请在 server/events/definitions/ 中登记后再写入。',
    )
  }
  return definition
}

/** 全部已登记的类型（升序，便于断言与呈现） */
export function listRegisteredTypes(): readonly string[] {
  return Object.freeze([...registry.keys()].sort())
}
