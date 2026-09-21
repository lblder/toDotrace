import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'
import { BrandMark } from '../common/BrandMark'
import { IconAlert } from '../common/Icons'
import './auth.css'

/**
 * 三个账号页共用的外壳：品牌区 + 卡片 + 页脚链接。
 * 两主题共用同一套布局，只换令牌（开发文档 §7）。
 */
export function AuthScreen({
  eyebrow,
  title,
  subtitle,
  banner,
  children,
  footer,
}: {
  eyebrow: string
  title: string
  subtitle: string
  /** 表单级错误：服务端错误信封里的 message 原样显示 */
  banner?: string | null
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="ta-auth">
      <main className="ta-auth__panel">
        <header className="ta-auth__brand">
          <span className="ta-auth__seal">
            <BrandMark size={40} />
          </span>
          <span className="ta-auth__brandText">
            <span className="ta-auth__wordmark">每日打卡工作台</span>
            <span className="ta-auth__tagline">本地运行 · 多账号隔离 · 数据不出本机</span>
          </span>
        </header>

        <section className={cx('ta-card', 'ta-auth__card')} aria-labelledby="auth-title">
          <p className="ta-auth__eyebrow ta-mono">{eyebrow}</p>
          <h1 className="ta-auth__title" id="auth-title">
            {title}
          </h1>
          <p className="ta-auth__subtitle">{subtitle}</p>
          <span className="ta-auth__rule" aria-hidden="true" />

          {banner === null || banner === undefined ? null : (
            <p className="ta-banner ta-banner--error" role="alert">
              <IconAlert size={18} />
              <span>{banner}</span>
            </p>
          )}

          {children}
        </section>

        {footer === undefined ? null : (
          <footer className="ta-auth__foot">{footer}</footer>
        )}
      </main>
    </div>
  )
}
