import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_DAY_START_HOUR, type TimeContext } from '@shared/time'
import {
  canSubmit as canSubmitParse,
  parseQuickAdd,
  resolveQuickAdd,
  type ProjectRef,
  type QuickAddContext,
  type QuickAddResult,
} from '@shared/quickadd'
import { useProjects } from './use-projects'
import { useSettings } from './use-settings'

/**
 * 快速录入的实时预览（ADR-014 全篇）。
 *
 * **解析本身完全在 `@shared/quickadd` 里**，本文件只做三件界面侧的事：
 *
 * 1. 提供 `now` —— ADR-014 §1 明确要求「**每次解析时**取当前时刻（而不是在组件挂载时取一次）」：
 *    `dayStartHour` 默认 4，归属日在凌晨 4 点翻页；挂着不动的 `now` 会让预览在 4 点后
 *    继续按昨天折算「明天」。故这里既在每次输入变化时重取，也带一个只在有文本时运行的分钟级心跳；
 * 2. 持有**层③的抑制集**（`×` 取消的碎片偏移），并遵守 §2 的配套约束：
 *    **文本一变即清空**——否则旧偏移可能恰好落在新文本的某个 token 上，
 *    静默取消一个用户没点过的碎片；
 * 3. 把解析结果里的**绝对日期**交给界面（`describeDay` / `describeWeek`），
 *    粒度必须跟着用户给的粒度走（§4.3）：周级锚点显示成「计划日 9月28日(周一)」是错的。
 */
export interface QuickAddApi {
  readonly text: string
  readonly setText: (next: string) => void
  /** 解析结果（`suppressed` 已应用）。**每次输入变化都是新对象** */
  readonly result: QuickAddResult
  /**
   * 层①（整串引号）是否命中。
   *
   * 它住在 `QuickAddParse` 上而不在 `QuickAddResult` 上，而界面必须能说出
   * 「这一层把整串都当字面了」——否则用户看到「什么都没识别」时会以为解析坏了。
   */
  readonly quoted: boolean
  /** 被 `×` 取消的碎片偏移（供界面标出「已取消」） */
  readonly suppressed: readonly number[]
  /** 层③：取消 / 恢复某个碎片（按 `token.start`） */
  readonly toggleSuppressed: (start: number) => void
  readonly canSubmit: boolean
  /**
   * 设置还没读到时为 `false`。
   *
   * 此时预览仍按「本机时区 + 默认 4 点」算（否则第一下按键没有反馈），
   * 但**提交被禁用**：预览的 `today` 与服务端可能差一个归属日，
   * 而那是 ADR-015 §6 点名要防的静默分叉。设置一到就重解析。
   */
  readonly ready: boolean
  readonly reset: () => void
}

/** 设置未到位时的兜底口径：浏览器时区 + 默认日界（ADR-009 §2） */
function fallbackTimeContext(): TimeContext {
  let timeZone = 'UTC'
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // 拿不到就用 UTC：预览仍可用，且它显示的绝对日期是可见的
  }
  return { timeZone, dayStartHour: DEFAULT_DAY_START_HOUR }
}

/** 心跳：有文本时每 60 秒重算一次，使跨过凌晨 4 点的预览自己纠正过来 */
const TICK_MS = 60_000

export function useQuickAdd(): QuickAddApi {
  const [text, setTextRaw] = useState('')
  const [suppressed, setSuppressed] = useState<readonly number[]>([])
  const [tick, setTick] = useState(0)

  const settings = useSettings()
  const projects = useProjects()

  useEffect(() => {
    if (text.length === 0) return
    const timer = window.setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [text])

  /**
   * 交给解析器的项目词表（ADR-014 §5.6：**只含未删除的项目**）。
   *
   * 「未删除」不是修饰语：把已删除的项目放进来，`#实验` 会解析成一个
   * 服务端归属校验必然拒绝的 `projectId`，用户看到的是一个 400。
   *
   * 这一层过滤**已经在服务端`GET /api/projects` 做过**（它只返回未删除的项目），
   * 故这里不再滤第二遍——`ProjectView` 上没有 `deletedAt` 这一列，
   * 再滤一次会得到空词表，而症状是「`#实验` 突然不识别了」且没有任何报错。
   */
  const projectRefs: ProjectRef[] = useMemo(
    () =>
      projects.projects.map((project) => ({ id: project.projectId, name: project.name })),
    [projects.projects],
  )

  const timeContext: TimeContext = useMemo(
    () =>
      settings.settings === null
        ? fallbackTimeContext()
        : {
            timeZone: settings.settings.timeZone,
            dayStartHour: settings.settings.dayStartHour,
          },
    [settings.settings],
  )

  /*
   * `now` 在 useMemo 内部取：这满足 ADR-014 §1 的「每次解析时取当前时刻」。
   * 依赖里**没有** `now`（它是一个值，不是状态），这正是「不读系统时钟」那条纪律的落法——
   * `Date` 是值，调用方负责它的新鲜度。
   */
  const parsed = useMemo(() => {
    void tick
    const ctx: QuickAddContext = { now: new Date(), timeContext, projects: projectRefs }
    const parse = parseQuickAdd(text, ctx)
    return { quoted: parse.quoted, result: resolveQuickAdd(parse, suppressed) }
  }, [text, suppressed, timeContext, projectRefs, tick])

  const setText = useCallback((next: string) => {
    setTextRaw(next)
    // §2 的配套约束：抑制集以**原文偏移**为键，文本一变坐标即失效 → 清空
    setSuppressed([])
  }, [])

  const toggleSuppressed = useCallback((start: number) => {
    setSuppressed((previous) =>
      previous.includes(start) ? previous.filter((value) => value !== start) : [...previous, start],
    )
  }, [])

  const reset = useCallback(() => {
    setTextRaw('')
    setSuppressed([])
  }, [])

  return {
    text,
    setText,
    result: parsed.result,
    quoted: parsed.quoted,
    suppressed,
    toggleSuppressed,
    // `canSubmit` 的判据只在 `shared/quickadd` 一处（标题非空 + ≤500），这里不再写一份
    canSubmit: canSubmitParse(parsed.result),
    ready: settings.settings !== null,
    reset,
  }
}
