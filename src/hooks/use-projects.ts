import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api-client'
import type {
  CreateProjectInput,
  ProjectListPayload,
  ProjectRow,
  UpdateProjectInput,
} from '../lib/api-client'
import { queryKeys } from './query-keys'

export interface ProjectsApi {
  readonly projects: readonly ProjectRow[]
  readonly currentProjectId: string | null
  readonly isLoading: boolean
  readonly isError: boolean
  readonly error: unknown
  /**
   * 可用的项目。
   *
   * ⚠️ **就是 `projects` 本身**：`GET /api/projects` 只返回**未删除**的项目
   * （ADR-016 §6 的软删除在服务端就折掉了），故这里**不再按 `deletedAt` 过滤一次**
   * ——那个字段在响应里根本不存在，滤一次会把项目全部滤空（一个静默的空列表）。
   * 名字保留，是为了让调用方读起来仍是「可用项目」这层意思。
   */
  readonly active: readonly ProjectRow[]
}

/**
 * 项目列表与当前项目（ADR-017 §1.3；语义见 ADR-016）。
 *
 * ⚠️ **「当前项目」绝不参与任何归属推导**（ADR-016 §4 最重要的那条禁令）。
 * 它只有三个用途：项目视图的默认打开对象、快速录入的项目预选、导出范围。
 * 故本 hook 只把它**原样交出来**，不在这里做任何「新任务自动归到当前项目」的事——
 * 那会是一次切换就追溯改写历史的形状。
 */
export function useProjects(): ProjectsApi {
  const result = useQuery<ProjectListPayload>({
    queryKey: queryKeys.projects,
    queryFn: async ({ signal }) => api.listProjects(signal),
    retry: false,
  })

  const projects = result.data?.projects ?? []
  return {
    projects,
    // 没有当前项目是**正常状态**（ADR-016 §4 取「至多一个」），不是缺失
    currentProjectId: result.data?.currentProjectId ?? null,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
    active: projects,
  }
}

export function useProjectActions() {
  const queryClient = useQueryClient()
  const done = (): void => {
    // 项目变化会改变任务列表里的项目名与「区间外」标注
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
  }

  const create = useMutation<{ project: ProjectRow }, Error, CreateProjectInput>({
    mutationFn: (input) => api.createProject(input),
    onSuccess: done,
  })
  const update = useMutation<
    { project: ProjectRow },
    Error,
    { projectId: string; input: UpdateProjectInput }
  >({
    mutationFn: ({ projectId, input }) => api.updateProject(projectId, input),
    onSuccess: done,
  })
  const remove = useMutation<{ projectId?: string; batchId: string }, Error, string>({
    mutationFn: (projectId) => api.deleteProject(projectId),
    onSuccess: done,
  })
  const activate = useMutation<{ project: ProjectRow }, Error, string>({
    mutationFn: (projectId) => api.activateProject(projectId),
    onSuccess: done,
  })
  const clearCurrent = useMutation<{ currentProjectId: null }, Error, void>({
    mutationFn: () => api.clearCurrentProject(),
    onSuccess: done,
  })

  return { create, update, remove, activate, clearCurrent }
}
