import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLogin } from '../../hooks/use-auth'
import { useRoute } from '../../hooks/use-route'
import { errorMessage } from '../../lib/api-client'
import { AuthScreen } from './AuthScreen'
import { Field } from '../common/Field'
import {
  checkLoginPassword,
  checkLoginUsername,
  clearFieldError,
  firstInvalid,
  type FieldErrors,
} from './validation'

type FieldName = 'username' | 'password'

const FIELD_ORDER: readonly FieldName[] = ['username', 'password']

/**
 * 登录只查非空（ADR-008 §8：登录时用户名/口令只校验非空、不 trim）。
 * 这里**故意不套用建号时的长度与字符集规则**——历史口令可能不满足今天的建号规则，
 * 在登录页把它们挡下来等于把用户锁在门外。
 */
const VALIDATORS: Readonly<Record<FieldName, (value: string) => string | null>> = {
  username: checkLoginUsername,
  password: checkLoginPassword,
}

/**
 * 登录：POST /api/auth/login。
 * 401（用户名或密码不正确）与 429（尝试次数过多）都由服务端给出中文 message，
 * 这里原样显示——前端不猜测剩余锁定时间（ADR-008 的信封里没有这个字段）。
 */
export function LoginPage() {
  const login = useLogin()
  const { navigate } = useRoute()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors<FieldName>>({})
  const [banner, setBanner] = useState<string | null>(null)

  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const refs = { username: usernameRef, password: passwordRef }

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
    if (login.isPending) return

    const values: Record<FieldName, string> = { username, password }
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
    login.mutate(
      { username: username.trim(), password },
      {
        onError: (error) => {
          setBanner(errorMessage(error))
        },
      },
    )
  }

  return (
    <AuthScreen
      eyebrow="SIGN IN"
      title="登录"
      subtitle="用账号进入工作台。"
      banner={banner}
      footer={
        <p className="ta-auth__footText">
          拿到邀请码了？
          <button
            type="button"
            className="ta-linkBtn"
            onClick={() => navigate('register')}
            disabled={login.isPending}
          >
            注册新账号
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
          autoComplete="username"
          autoFocus
          disabled={login.isPending}
          autoCapitalize="none"
          spellCheck={false}
          inputRef={usernameRef}
          mono
        />
        <Field
          label="密码"
          value={password}
          onChange={edit('password', setPassword)}
          type="password"
          error={errors.password ?? null}
          autoComplete="current-password"
          disabled={login.isPending}
          inputRef={passwordRef}
        />

        <button
          type="submit"
          className="ta-btn ta-btn--primary ta-btn--block"
          disabled={login.isPending}
          aria-busy={login.isPending}
        >
          {login.isPending ? '正在登录…' : '登录'}
        </button>
      </form>
    </AuthScreen>
  )
}
