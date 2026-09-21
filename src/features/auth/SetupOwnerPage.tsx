import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useRoute } from '../../hooks/use-route'
import { useCreateOwner } from '../../hooks/use-setup'
import { ApiError, errorMessage } from '../../lib/api-client'
import { AuthScreen } from './AuthScreen'
import { Field } from '../common/Field'
import {
  USERNAME_HINT,
  PASSWORD_HINT,
  DISPLAY_NAME_HINT,
  checkDisplayName,
  checkPassword,
  checkUsername,
  clearFieldError,
  firstInvalid,
  type FieldErrors,
} from './validation'

type FieldName = 'username' | 'displayName' | 'password'

const FIELD_ORDER: readonly FieldName[] = ['username', 'displayName', 'password']

/** 字段 → 校验函数（ADR-008 §8 的约束），顺序与 FIELD_ORDER 一致 */
const VALIDATORS: Readonly<Record<FieldName, (value: string) => string | null>> = {
  username: checkUsername,
  displayName: checkDisplayName,
  password: checkPassword,
}

/**
 * 服务端错误码 → 该落到哪个字段上（ADR-008 §8 的稳定 code）。
 * conflict/owner-exists 不在此表：它是「整台机器已经初始化过」的全局状态，
 * 路由守卫会把页面整体换掉，贴到某个输入框上没有意义。
 */
const SERVER_ERROR_FIELD: Readonly<Record<string, FieldName>> = {
  'conflict/username-taken': 'username',
}

/**
 * 首启引导：创建 owner（ADR-008 §2 的 POST /api/setup/owner）。
 * 服务端只在无 owner 时可调用，已有 owner 返回 409——那时页面会被
 * App 的路由守卫自动换掉，不需要在这里额外处理。
 */
export function SetupOwnerPage() {
  const createOwner = useCreateOwner()
  const { navigate } = useRoute()

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors<FieldName>>({})
  const [banner, setBanner] = useState<string | null>(null)

  const usernameRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const refs = { username: usernameRef, displayName: displayNameRef, password: passwordRef }

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
    if (createOwner.isPending) return

    const values: Record<FieldName, string> = { username, displayName, password }
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
    createOwner.mutate(
      {
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
      eyebrow="SETUP"
      title="首次启动"
      subtitle="这台机器上还没有账号。创建第一个账号（owner），此后新账号凭邀请码注册。"
      banner={banner}
      footer={
        <p className="ta-auth__footText">
          已经建过账号？
          <button
            type="button"
            className="ta-linkBtn"
            onClick={() => navigate('login')}
            disabled={createOwner.isPending}
          >
            去登录
          </button>
        </p>
      }
    >
      <form className="ta-form" onSubmit={handleSubmit} noValidate>
        <Field
          label="用户名"
          value={username}
          onChange={edit('username', setUsername)}
          error={errors.username ?? null}
          hint={`登录时使用，创建后不可更改。${USERNAME_HINT}`}
          autoComplete="username"
          autoFocus
          disabled={createOwner.isPending}
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
          disabled={createOwner.isPending}
          inputRef={displayNameRef}
        />
        <Field
          label="密码"
          value={password}
          onChange={edit('password', setPassword)}
          type="password"
          error={errors.password ?? null}
          hint={PASSWORD_HINT}
          autoComplete="new-password"
          disabled={createOwner.isPending}
          inputRef={passwordRef}
        />

        <button
          type="submit"
          className="ta-btn ta-btn--primary ta-btn--block"
          disabled={createOwner.isPending}
          aria-busy={createOwner.isPending}
        >
          {createOwner.isPending ? '正在创建…' : '创建 owner 并进入'}
        </button>
      </form>
    </AuthScreen>
  )
}
