import type { RegisteredDefinition } from '../types.js'
import { checkinEventDefinitions } from './checkin.js'
import { noteEventDefinitions } from './notes.js'
import { projectEventDefinitions } from './projects.js'
import { settingsEventDefinitions } from './settings.js'
import { systemEventDefinitions } from './system.js'
import { taskEventDefinitions } from './tasks.js'

/**
 * 阶段 2/3/4 登记的全部事件类型（ADR-010 §2 / §6 / §7、ADR-012 §1、
 * ADR-013 §4、ADR-016 §5、ADR-017 §6）。
 *
 * **注册表只从这里建**：显式清单而非「各模块自行注册」的副作用，
 * 使「登记了哪些类型」一眼可查、与 import 顺序无关。
 * 后续阶段登记自己的类型时，往这个数组里追加即可（不在别处注册）。
 *
 * ⚠️ **ADR-011 §6 的四类 `recurrence/*` 已移除**（ADR-013 §4 的取代）：
 * 它们不在这个数组里，因此**未登记即拒绝写入**——存量库里若有这类事件，
 * v4 迁移会在事件层前置检查处中止（`server/db/schema.ts` 的 `assertNoLegacyRecurrenceEvents`），
 * 而不是让账号在升级后静默写不进东西。
 */
export const EVENT_DEFINITIONS: readonly RegisteredDefinition[] = Object.freeze([
  ...systemEventDefinitions,
  ...settingsEventDefinitions,
  ...checkinEventDefinitions,
  ...noteEventDefinitions,
  ...taskEventDefinitions,
  ...projectEventDefinitions,
])
