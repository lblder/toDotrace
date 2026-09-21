import { useId, useState } from 'react'
import type { RefObject } from 'react'
import { cx } from '../../lib/cx'
import { IconAlert, IconEye, IconEyeOff } from './Icons'

export interface FieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password'
  /** 常驻说明文字（不是占位符替代品） */
  hint?: string
  /** 字段级错误文案；服务端的错误是表单级的，见各页面的横幅 */
  error?: string | null
  autoComplete?: string
  autoFocus?: boolean
  disabled?: boolean
  /** 用户名、邀请码、标识一类用等宽体 */
  mono?: boolean
  spellCheck?: boolean
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'
  inputRef?: RefObject<HTMLInputElement | null>
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error = null,
  autoComplete,
  autoFocus = false,
  disabled = false,
  mono = false,
  spellCheck,
  autoCapitalize,
  inputRef,
}: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const [reveal, setReveal] = useState(false)

  const isPassword = type === 'password'
  const describedBy =
    [hint === undefined ? null : hintId, error === null ? null : errorId]
      .filter((part): part is string => part !== null)
      .join(' ') || undefined

  return (
    <div className="ta-field">
      <label className="ta-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ta-field__control">
        <input
          id={id}
          ref={inputRef}
          className={cx('ta-input', isPassword && 'ta-input--with-affix', mono && 'ta-mono')}
          type={isPassword && reveal ? 'text' : type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          disabled={disabled}
          autoFocus={autoFocus}
          {...(autoComplete === undefined ? {} : { autoComplete })}
          {...(spellCheck === undefined ? {} : { spellCheck })}
          {...(autoCapitalize === undefined ? {} : { autoCapitalize })}
          aria-invalid={error !== null}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        />
        {isPassword ? (
          <button
            type="button"
            className="ta-field__affix"
            onClick={() => setReveal((previous) => !previous)}
            aria-label={reveal ? '隐藏密码' : '显示密码'}
            aria-pressed={reveal}
          >
            {reveal ? <IconEyeOff size={18} /> : <IconEye size={18} />}
          </button>
        ) : null}
      </div>
      {hint === undefined ? null : (
        <p className="ta-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error === null ? null : (
        <p className="ta-field__error" id={errorId}>
          <IconAlert size={14} />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}
