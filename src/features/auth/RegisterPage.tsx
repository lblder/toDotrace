import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useRegister } from '../../hooks/use-auth'
import { useRoute } from '../../hooks/use-route'
import { ApiError, errorMessage } from '../../lib/api-client'
import { AuthScreen } from './AuthScreen'
import { Field } from '../common/Field'
import {
  USERNAME_HINT,
  PASSWORD_HINT,
  DISPLAY_NAME_HINT,
  checkDisplayName,
  checkInviteCode,
  checkPassword,
  checkUsername,
  clearFieldError,
  firstInvalid,
  type FieldErrors,
} from './validation'

type FieldName = 'inviteCode' | 'username' | 'displayName' | 'password'

const FIELD_ORDER: readonly FieldName[] = ['inviteCode', 'username', 'displayName', 'password']

/** 字段 → 校验函数（ADR-008 §8 的约束） */
const VALIDATORS: Readonly<Record<FieldName, (value: string) => string | null>> = {
  inviteCode: checkInviteCode,
  username: checkUsername,
  displayName: checkDisplayName,
  password: checkPassword,
}

/**
 * 服务端错误码 → 该落到哪个字段上（ADR-008 §8 的稳定 code）。
 * 命中就贴着那个输入框显示并聚焦过去；其余（如 validation/invalid-input）
 * 信封里没有字段信息，只能走表单级横幅。文案一律用服务端的原文，不自己改写。
 */
const SERVER_ERROR_FIELD: Readonly<Record<string, FieldName>> = {
  'conflict/username-taken': 'username',
  'conflict/invite-used': 'inviteCode',
  'invite/invalid': 'inviteCode',
}

/**
 * 注册：POST /api/auth/register（凭邀请码，无鉴权）。
 * 邀请码由 owner 签发且有有效期；码错、过期、已用分别由服务端以
 * 400 / 409 一类状态码 + 中文 message 回答，这里只负责显示。
 */
export function RegisterPage() {
  const register = useRegister()
  const { navigate } = useRoute()

  const [inviteCode, setInviteCode] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors<FieldName>>({})
  const [banner, setBanner] = useState<string | null>(null)

  const inviteRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const refs = {
    inviteCode: inviteRef,
    username: usernameRef,
    displayName: displayNameRef,
    password: passwordRef,
  }

  /** 编辑某字段：写入值、撤掉它的旧错误、清掉上一次的服务端横幅 */
  function edit(field: FieldName, set: (value: string) => void) {
    return (value: string) => {
      set(value)
      setErrors((previous) => clearFieldError(previous, field))
      setBanner(null)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (register.isPending) return

    const values: Record<FieldName, string> = { inviteCode, username, displayName, password }
    const next: FieldErrors<FieldName> = {}
    for (const field of FIELD_ORDER) {
      const message = VALIDATORS[field](values[field])
      if (message !== null) next[field] = message
    }
    setErrors(next)

    const invalid = firstInvalid(FIELD_ORDER, next)
    if (invalid !== null) {
      refs[invalid].current?.focus()
      return
    }

    setBanner(null)
    register.mutate(
      {
        inviteCode: inviteCode.trim(),
        username: username.trim(),
        displayName: displayName.trim(),
        password,
      },
      {
        onError: (error) => {
          const message = errorMessage(error)
          const field = error instanceof ApiError ? SERVER_ERROR_FIELD[error.code] : undefined
          if (field === undefined) {
            setBanner(message)
            return
          }
          const next: FieldErrors<FieldName> = {}
          next[field] = message
          setErrors(next)
          setBanner(null)
          refs[field].current?.focus()
        },
      },
    )
  }

  return (
    <AuthScreen
      eyebrow="REGISTER"
      title="注册"
      subtitle="凭 owner 签发的邀请码注册。邀请码有有效期，用过一次即失效。"
      banner={banner}
      footer={
        <p className="ta-auth__footText">
          已经有账号？
          <button
            type="button"
            className="ta-linkBtn"
            onClick={() => navigate('login')}
            disabled={register.isPending}
          >
            去登录
          </button>
        </p>
      }
    >
      <form className="ta-form" onSubmit={handleSubmit} noValidate>
        <Field
          label="邀请码"
          value={inviteCode}
          onChange={edit('inviteCode', setInviteCode)}
          error={errors.inviteCode ?? null}
          hint="由 owner 签发；仅在签发时显示一次"
          autoComplete="off"
          autoFocus
          disabled={register.isPending}
          autoCapitalize="none"
          spellCheck={false}
          inputRef={inviteRef}
          mono
        />
        <Field
          label="用户名"
          value={username}
          onChange={edit('username', setUsername)}
          error={errors.username ?? null}
          hint={`登录时使用，创建后不可更改。${USERNAME_HINT}`}
          autoComplete="username"
          disabled={register.isPending}
          autoCapitalize="none"
          spellCheck={false}
          inputRef={usernameRef}
          mono
        />
        <Field
          label="显示名"
          value={displayName}
          onChange={edit('displayName', setDisplayName)}
          error={errors.displayName ?? null}
          hint={DISPLAY_NAME_HINT}
          autoComplete="nickname"
          disabled={register.isPending}
          inputRef={displayNameRef}
        />
        <Field
          label="密码"
          value={password}
          onChange={edit('password', setPassword)}
          type="password"
          hint={PASSWORD_HINT}
          error={errors.password ?? null}
          autoComplete="new-password"
          disabled={register.isPending}
          inputRef={passwordRef}
        />

        <button
          type="submit"
          className="ta-btn ta-btn--primary ta-btn--block"
          disabled={register.isPending}
          aria-busy={register.isPending}
        >
          {register.isPending ? '正在注册…' : '注册并进入'}
        </button>
      </form>
    </AuthScreen>
  )
}
