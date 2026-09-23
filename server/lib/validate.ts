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

/**
 * 口令：8–200，**不 trim**（口令里的空格是有效字符），但不得全部由空白组成
 * （ADR-008 §8 补遗 7：`        ` 被当成合法口令是设计气味）。
 * 仅用于「设置口令」的入口（引导 / 注册）；登录不套这条——
 * 登录只判非空，口令规则不在登录响应里暴露。
 */
const password = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(200, '密码最多 200 个字符')
  .refine((value) => value.trim().length > 0, '密码不能全部为空白字符')

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

/** 「本路由没有请求体」：空对象通过，**多一个字段即 400**（ADR-008 §8） */
const emptyBodySchema = z.object({}).strict()

/**
 * **无请求体的写路由**（打卡的到达/离开、实例完成/取消、删除、切换当前项目）统一的入口校验。
 *
 * 它存在的理由只有一个，但是本阶段的最高优先级约束（ADR-017 §5）：
 * 「请求体里的任何 `accountId` / `account_id` 字段一律因 `.strict()` 被拒（400），
 * **而不是被忽略**」。路由的请求体契约是「无」——那就得**把「无」也校验一遍**，
 * 否则一个带 `accountId` 的请求会一路走到域层，而它「碰巧没事」的原因是
 * 服务端压根不读那个字段：**那是侥幸，不是契约**。
 *
 * 不带 body 时 Express 给出 `undefined`，`?? {}` 让它与 `{}` 同解——
 * 于是「不传 body」与「传空对象」在这里是同一件事，不让调用方去猜。
 */
export function assertNoBody(body: unknown): void {
  parseInput(emptyBodySchema, body ?? {})
}
