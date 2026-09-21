import { z } from 'zod'
import { invalidInput } from './errors.js'

/**
 * 入口校验（ADR-008 §1 / 架构文档 §9 必做 4）：
 * 每个入口的输入都用 zod 校验，失败一律 400，不进入域逻辑。
 *
 * 全部对象用 strict：多给字段即拒绝——接口冻结的意义就在于字段集合是确定的，
 * 静默忽略多余字段会让前端依赖上并不存在的契约。
 */

/** 用户名：3–32 位，仅字母数字下划线连字符（语义非法 → 400）。 */
const username = z
  .string()
  .trim()
  .min(3, '用户名至少 3 个字符')
  .max(32, '用户名最多 32 个字符')
  .regex(/^[A-Za-z0-9_-]+$/, '用户名只能包含字母、数字、下划线与连字符')

const password = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(200, '密码最多 200 个字符')

const displayName = z.string().trim().min(1, '显示名不能为空').max(50, '显示名最多 50 个字符')

export const setupOwnerSchema = z
  .object({ username, password, displayName })
  .strict()

export const loginSchema = z
  .object({
    // 登录只做非空校验（口令规则不在这里暴露），但同样 trim：
    // 注册时用户名被 trim 过，登录不 trim 会让「多打一个空格」变成登录失败。
    username: z.string().trim().min(1, '请输入用户名').max(200),
    password: z.string().min(1, '请输入密码').max(200),
  })
  .strict()

export const registerSchema = z
  .object({
    username,
    password,
    displayName,
    inviteCode: z.string().min(1, '邀请码不能为空').max(512),
  })
  .strict()

/**
 * POST /api/invites 的入参：ADR-008 §2 未列字段。
 * 这里接受一个可选的 expiresInDays（1–30，默认 7 天），
 * 不传或整个 body 缺席时走默认值——保证「无 body 调用」也能成功。
 */
export const createInviteSchema = z
  .object({ expiresInDays: z.number().int().min(1).max(30).optional() })
  .strict()

/** 校验失败一律 400，细节只进服务端日志，不外泄到响应（响应只给 code + 中文文案）。 */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)'
    const detail = issue ? `${path}: ${issue.message}` : 'unknown'
    throw invalidInput(`请求参数不合法（${detail}）`)
  }
  return result.data
}
