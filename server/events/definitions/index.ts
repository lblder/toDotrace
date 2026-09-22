import type { RegisteredDefinition } from '../types.js'
import { checkinEventDefinitions } from './checkin.js'
import { recurrenceEventDefinitions } from './recurrence.js'
import { settingsEventDefinitions } from './settings.js'
import { systemEventDefinitions } from './system.js'

/**
 * 阶段 2/3 登记的全部事件类型（ADR-010 §2 / §6 / §7、ADR-011 §6、ADR-012 §1）。
 *
 * **注册表只从这里建**：显式清单而非「各模块自行注册」的副作用，
 * 使「登记了哪些类型」一眼可查、与 import 顺序无关。
 * 后续阶段登记自己的类型时，往这个数组里追加即可（不在别处注册）。
 */
export const EVENT_DEFINITIONS: readonly RegisteredDefinition[] = Object.freeze([
  ...systemEventDefinitions,
  ...recurrenceEventDefinitions,
  ...settingsEventDefinitions,
  ...checkinEventDefinitions,
])
