import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type {
  CreateTaskInput,
  CreateTaskPayload,
  DeletedPayload,
  OccurrencePayload,
  RescheduleItem,
  ReschedulePayload,
  TaskDetailPayload,
  TaskListPayload,
  TaskListQuery,
  TaskPayload,
  TodoItem,
  UndoPayload,
  UpdateTaskInput,
} from '../lib/api-client'
import type { TaskStatus } from '@shared/tasks'
import { queryKeys } from './query-keys'

/**
 * ADR-017 §10 的三次重取时机（**本文件是它们唯一的落点**）。
 *
 * | 时机 | 理由 |
 * |---|---|
 * | 窗口 `focus` | 用户切回来时最可能已经跨过零点 |
 * | `visibilitychange` → 可见 | 移动端切后台再回来不会触发 `focus` |
 * | 每 5 分钟 | 前台长时间停留时覆盖跨零点 |
 *
 * **不用 React Query 的 `refetchOnWindowFocus`**：它只监听 `visibilitychange`，
 * 不监听窗口 `focus`，于是 ADR 要求的两条里有一条根本没有实现——
 * 而缺失的那一条不会有任何症状。这里显式写全两条，并把 RQ 的内建行为关掉，
 * 使「重取时机」只有一处实现、可以被测试直接钉住。
 *
 * 判据只在跨 `dayStartHour` 时才会变，而那是一天一次的时刻；5 分钟的误差上限
 * 比「永不更新」好，比「每秒轮询」省。
 */
const REFETCH_INTERVAL_MS = 5 * 60 * 1000

export interface TaskListApi {
  /** 服务端回带的今日归属日；**没拿到之前是 null**，界面不得自己算一个顶上 */
  readonly today: string | null
  readonly items: readonly TodoItem[]
  readonly isLoading: boolean
  readonly isError: boolean
  readonly error: unknown
  readonly refetch: () => void
}

/**
 * 某个 scope 的任务列表（GET /api/tasks）。
 *
 * ⚠️ **`today` 一律取响应里的那个**（ADR-015 §6）：跨零点或跨 `dayStartHour` 时
 * 两端会算出不同日期，症状是「任务点不动」且**没有任何报错**。
 * 服务端没回来之前 `today` 是 `null`，界面显示「正在读取」，
 * **不拿客户端的时钟顶上**——那正是这条约束要防的第二个来源。
 */
export function useTaskList(query: TaskListQuery): TaskListApi {
  const result = useQuery<TaskListPayload>({
    queryKey: queryKeys.taskList(query),
    queryFn: async ({ signal }) => api.listTasks(query, signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  // 上面 refetchInterval 的闭包随渲染更新；refetch 本身在 RQ v5 里是稳定引用
  const { refetch } = result
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    function onFocus(): void {
      void refetchRef.current()
    }
    function onVisibility(): void {
      if (document.visibilityState === 'visible') void refetchRef.current()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return {
    today: result.data?.today ?? null,
    items: result.data?.items ?? [],
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
    refetch: () => {
      void result.refetch()
    },
  }
}

/** 单个任务明细（GET /api/tasks/:id）。`enabled` 由调用方控制：不展开就不请求 */
export function useTaskDetail(taskId: string | null) {
  const result = useQuery<TaskDetailPayload>({
    queryKey: queryKeys.taskDetail(taskId ?? ''),
    queryFn: async ({ signal }) => api.getTask(taskId ?? '', signal),
    enabled: taskId !== null,
    retry: false,
  })
  return {
    detail: result.data ?? null,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
  }
}

/* -------------------------------------------------------------------------
   动作
   ------------------------------------------------------------------------- */

export type TaskMutation<TInput, TResult> = UseMutationResult<TResult, Error, TInput>

export interface TaskActions {
  readonly create: TaskMutation<CreateTaskInput, CreateTaskPayload>
  readonly update: TaskMutation<{ taskId: string; input: UpdateTaskInput }, TaskPayload>
  readonly setStatus: TaskMutation<{ taskId: string; to: TaskStatus }, TaskPayload>
  readonly complete: TaskMutation<{ taskId: string; occurrenceKey: string }, OccurrencePayload>
  readonly uncomplete: TaskMutation<{ taskId: string; occurrenceKey: string }, OccurrencePayload>
  readonly reschedule: TaskMutation<readonly RescheduleItem[], ReschedulePayload>
  readonly remove: TaskMutation<string, DeletedPayload>
  readonly undo: TaskMutation<string, UndoPayload>
  readonly addStep: TaskMutation<{ taskId: string; title: string }, TaskPayload>
  readonly renameStep: TaskMutation<{ taskId: string; stepId: string; title: string }, TaskPayload>
  readonly deleteStep: TaskMutation<{ taskId: string; stepId: string }, TaskPayload>
  readonly toggleStep: TaskMutation<
    { taskId: string; stepId: string; originalPlannedDate: string; checked: boolean },
    TaskPayload
  >
  readonly reorder: TaskMutation<{ taskId: string; manualOrder: number }, TaskPayload>
}

/**
 * 任务的全部写动作，集中一处。
 *
 * **每一次成功都失效整棵 `['tasks']`**：一次写入可能同时改变列表、明细与
 * 另一个 scope 的内容（例如完成一个实例会让它进「已完成」筛选、离开「今日」）。
 * 精确失效要求调用方逐处想清楚「这次改动影响哪些 key」，而那正是会漏的地方；
 * 列表规模是百量级（ADR-017 §1.1），重取一次的代价远小于漏失效。
 */
export function useTaskActions(): TaskActions {
  const queryClient = useQueryClient()

  const done = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
  }, [queryClient])

  const create = useMutation<CreateTaskPayload, Error, CreateTaskInput>({
    mutationFn: (input) => api.createTask(input),
    onSuccess: done,
  })
  const update = useMutation<TaskPayload, Error, { taskId: string; input: UpdateTaskInput }>({
    mutationFn: ({ taskId, input }) => api.updateTask(taskId, input),
    onSuccess: done,
  })
  const setStatus = useMutation<TaskPayload, Error, { taskId: string; to: TaskStatus }>({
    mutationFn: ({ taskId, to }) => api.setTaskStatus(taskId, { to }),
    onSuccess: done,
  })
  const complete = useMutation<
    OccurrencePayload,
    Error,
    { taskId: string; occurrenceKey: string }
  >({
    mutationFn: ({ taskId, occurrenceKey }) => api.completeOccurrence(taskId, occurrenceKey),
    onSuccess: done,
  })
  const uncomplete = useMutation<
    OccurrencePayload,
    Error,
    { taskId: string; occurrenceKey: string }
  >({
    mutationFn: ({ taskId, occurrenceKey }) => api.uncompleteOccurrence(taskId, occurrenceKey),
    onSuccess: done,
  })
  const reschedule = useMutation<ReschedulePayload, Error, readonly RescheduleItem[]>({
    mutationFn: (items) => api.rescheduleTasks(items),
    onSuccess: done,
  })
  const remove = useMutation<DeletedPayload, Error, string>({
    mutationFn: (taskId) => api.deleteTask(taskId),
    onSuccess: done,
  })
  const undo = useMutation<UndoPayload, Error, string>({
    mutationFn: (batchId) => api.undo(batchId),
    onSuccess: () => {
      // 撤销会移动折叠边界、触发全量重建（ADR-017 §8）——受影响的不止任务，
      // 项目与「今天」也可能变，故整棵树作废。
      void queryClient.invalidateQueries()
    },
  })
  const addStep = useMutation<TaskPayload, Error, { taskId: string; title: string }>({
    mutationFn: ({ taskId, title }) => api.addStep(taskId, title),
    onSuccess: done,
  })
  const renameStep = useMutation<
    TaskPayload,
    Error,
    { taskId: string; stepId: string; title: string }
  >({
    mutationFn: ({ taskId, stepId, title }) => api.renameStep(taskId, stepId, title),
    onSuccess: done,
  })
  const deleteStep = useMutation<TaskPayload, Error, { taskId: string; stepId: string }>({
    mutationFn: ({ taskId, stepId }) => api.deleteStep(taskId, stepId),
    onSuccess: done,
  })
  const toggleStep = useMutation<
    TaskPayload,
    Error,
    { taskId: string; stepId: string; originalPlannedDate: string; checked: boolean }
  >({
    mutationFn: ({ taskId, stepId, originalPlannedDate, checked }) =>
      api.toggleStep(taskId, stepId, { originalPlannedDate, checked }),
    onSuccess: done,
  })
  const reorder = useMutation<TaskPayload, Error, { taskId: string; manualOrder: number }>({
    mutationFn: ({ taskId, manualOrder }) => api.reorderTask(taskId, manualOrder),
    onSuccess: done,
  })

  return {
    create,
    update,
    setStatus,
    complete,
    uncomplete,
    reschedule,
    remove,
    undo,
    addStep,
    renameStep,
    deleteStep,
    toggleStep,
    reorder,
  }
}
