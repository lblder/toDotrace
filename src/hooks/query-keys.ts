/** React Query 的键集中在此，避免各处拼字符串导致失效范围对不上。 */

import type { TaskListQuery } from '../lib/api-client'

/**
 * 任务列表的查询键（阶段 4）。
 *
 * 判别联合的每一个分支都被显式列出来，**不靠 `JSON.stringify`**：
 * 后者会把键的顺序变成缓存身份的一部分，而对象字面量的键序在重构中随时会变
 * ——那会表现为「改了无关代码，缓存开始每次都 miss」。
 */
function taskListKey(query: TaskListQuery): readonly string[] {
  switch (query.scope) {
    case 'range':
      return ['range', query.from, query.to]
    case 'project':
      return ['project', query.projectId]
    default:
      return [query.scope]
  }
}

export const queryKeys = {
  /** 首启状态：是否需要创建 owner */
  setupStatus: ['setup', 'status'] as const,
  /** 当前会话：GET /api/auth/me 的结果，或登录/注册/首启成功后直接写入 */
  session: ['auth', 'session'] as const,
  /** 本账号签发过的邀请码（owner 专属，不含明文 code） */
  invites: ['invites', 'list'] as const,
  /** 成员列表（owner 专属，只为把邀请码的 usedBy 翻成显示名） */
  members: ['members', 'list'] as const,
  /** 今日打卡状态：GET /api/checkin/today 的结果（{ day, streak }） */
  checkinToday: ['checkin', 'today'] as const,

  /* --- 阶段 4（ADR-017） ------------------------------------------------ */

  /** 任务列表的**根**：失效时用它，一次把全部 scope 的缓存作废 */
  tasks: ['tasks', 'list'] as const,
  /** 某一个 scope 的列表；响应里的 `today` 也挂在它下面（服务端回带，ADR-015 §6） */
  taskList: (query: TaskListQuery) => ['tasks', 'list', ...taskListKey(query)] as const,
  taskDetail: (taskId: string) => ['tasks', 'detail', taskId] as const,
  /** 项目列表与当前项目（ADR-016） */
  projects: ['projects', 'list'] as const,
  /** 设置：timeZone / dayStartHour / affectsFrom（ADR-017 §7） */
  settings: ['settings'] as const,
  /** 某一天的备注（ADR-017 §1.4，**与到达无关**） */
  dayNote: (dayKey: string) => ['checkin', 'note', dayKey] as const,
} as const
