/**
 * api client 的对外出口（架构文档 §6 的第三层）。
 * 分层：features/* → hooks → api client → 服务端。
 * 组件**不得**直接 import 本模块；只有 hooks 可以。
 */

export { ApiError, errorMessage, onUnauthorized } from './client'
export type { ApiErrorKind } from './client'
export { api } from './endpoints'
export type { Api, TaskListQuery } from './endpoints'
export type {
  AuthPayload,
  CheckinResult,
  CreateInvitePayload,
  CreateOwnerInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskPayload,
  DayNotePayload,
  DayRow,
  DeletedPayload,
  ErrorEnvelope,
  InviteListPayload,
  InviteSummary,
  IssueInviteInput,
  IssuedInvite,
  LoginInput,
  MemberListPayload,
  MemberSummary,
  MePayload,
  OccurrencePayload,
  ProjectListPayload,
  ProjectRow,
  ProjectView,
  RegisterInput,
  RescheduleItem,
  ReschedulePayload,
  Role,
  SetTaskStatusInput,
  SettingsPayload,
  SetupStatus,
  TaskDetailPayload,
  TaskListPayload,
  TaskPayload,
  TaskView,
  TodayCheckin,
  TodoItem,
  UndoPayload,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
  User,
} from './types'
