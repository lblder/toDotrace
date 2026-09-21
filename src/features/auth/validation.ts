/**
 * 表单校验：逐条对照 ADR-008 §8「字段级约束与错误码（实现时冻结）」。
 *
 * 这里**只做契约明文写下的检查**——不做「更严」的猜测（不额外要求大小写混合、
 * 不禁止连续字符一类），否则就会出现「前端拦住了服务端本可接受的值」这种契约漂移。
 * 号段里的规则（用户名已被占用、邀请码已用过…）只有服务端知道，一律交给
 * 服务端的中文 message 原样显示。
 *
 * 注意两处口径差异（ADR-008 §8 明写）：
 *   · 登录时用户名/口令**只校验非空**——口令里的空格是有效字符，任何长度限制
 *     都会把历史口令挡在门外；建号时才按 8–200 校验；
 *   · 口令**一律不 trim**（两端空格是口令的一部分），其余字段按 trim 后的值判定。
 */

export type FieldErrors<F extends string> = Partial<Record<F, string>>

/* ADR-008 §8 冻结的数值，集中在此处，页面不重复写字面量 */
export const USERNAME_MIN = 3
export const USERNAME_MAX = 32
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 200
export const DISPLAY_NAME_MAX = 50
export const INVITE_CODE_MAX = 512

/** 用户名只允许 ASCII 字母、数字、下划线与短横线 */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/

export const USERNAME_HINT = `${USERNAME_MIN}–${USERNAME_MAX} 位，仅限字母、数字、下划线和短横线`
export const PASSWORD_HINT = `至少 ${PASSWORD_MIN} 位，可以包含空格`
export const DISPLAY_NAME_HINT = `界面上展示的名字，最多 ${DISPLAY_NAME_MAX} 个字符`

/* -------------------------------------------------------------------------
   登录：只查非空
   ------------------------------------------------------------------------- */

export function checkLoginUsername(value: string): string | null {
  return value.trim().length === 0 ? '请输入用户名' : null
}

export function checkLoginPassword(value: string): string | null {
  return value.length === 0 ? '请输入密码' : null
}

/* -------------------------------------------------------------------------
   建号：按 §8 的完整约束
   ------------------------------------------------------------------------- */

export function checkUsername(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return '请输入用户名'
  if (!USERNAME_PATTERN.test(trimmed)) {
    return '用户名只能包含字母、数字、下划线和短横线'
  }
  if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
    return `用户名需 ${USERNAME_MIN}–${USERNAME_MAX} 个字符（当前 ${trimmed.length}）`
  }
  return null
}

export function checkPassword(value: string): string | null {
  // 不 trim：口令里的空格是有效字符
  if (value.length === 0) return '请输入密码'
  if (value.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
  if (value.length > PASSWORD_MAX) return `密码不能超过 ${PASSWORD_MAX} 位`
  return null
}

export function checkDisplayName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return '请输入显示名'
  if (trimmed.length > DISPLAY_NAME_MAX) {
    return `显示名不能超过 ${DISPLAY_NAME_MAX} 个字符（当前 ${trimmed.length}）`
  }
  return null
}

export function checkInviteCode(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return '请输入邀请码'
  if (trimmed.length > INVITE_CODE_MAX) {
    return `邀请码不能超过 ${INVITE_CODE_MAX} 个字符`
  }
  return null
}

/* -------------------------------------------------------------------------
   通用工具
   ------------------------------------------------------------------------- */

/** 按字段顺序找出第一个出错的字段（用于把焦点送过去） */
export function firstInvalid<F extends string>(
  order: readonly F[],
  errors: FieldErrors<F>,
): F | null {
  for (const field of order) {
    if (errors[field] !== undefined) return field
  }
  return null
}

/** 用户重新编辑某个字段时，撤掉它的旧错误——避免「改完了错还在」的误导 */
export function clearFieldError<F extends string>(
  errors: FieldErrors<F>,
  field: F,
): FieldErrors<F> {
  if (errors[field] === undefined) return errors
  const next = { ...errors }
  delete next[field]
  return next
}
