import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useLogout } from '../../hooks/use-auth'
import { useRoute } from '../../hooks/use-route'
import { useSession } from '../../hooks/use-session'
import { routeHref, type RouteName } from '../../lib/router'
import { BrandMark } from '../common/BrandMark'
import { IconLogout } from '../common/Icons'
import { BootScreen } from '../common/StatusScreen'
import { ThemeToggle } from '../common/ThemeToggle'
import './shell.css'

interface NavItem {
  readonly route: RouteName
  readonly label: string
  /** 仅 owner 可见（服务端另有 403 把关，这里只是不摆无效入口） */
  readonly ownerOnly: boolean
}

const NAV: readonly NavItem[] = [
  // 打卡排在最前：它是每天的例行动作，也是全应用的签名交互（03 §7）
  { route: 'checkin', label: '打卡', ownerOnly: false },
  { route: 'home', label: '工作台', ownerOnly: false },
  { route: 'invites', label: '邀请码', ownerOnly: true },
]

/**
 * 登录后的外壳：顶栏（品牌 + 导航 + 账号 + 登出）与主内容容器。
 * 主内容由 App 按路由白名单挑好再传进来，外壳不认识任何具体页面。
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useSession()
  const { route } = useRoute()
  const logout = useLogout()
  const mainRef = useRef<HTMLElement>(null)

  if (user === null) {
    // App 的路由守卫已保证此处必有会话，这只是防御性分支
    return <BootScreen label="正在载入账号" />
  }

  const roleLabel = user.role === 'owner' ? 'owner' : '成员'
  const items = NAV.filter((item) => !item.ownerOnly || user.role === 'owner')

  return (
    <div className="ta-shell">
      {/* 跳转链接用按钮实现：hash 路由下 href="#main" 会污染地址栏并触发路由回调 */}
      <button
        type="button"
        className="ta-skip-link"
        onClick={() => mainRef.current?.focus()}
      >
        跳到主内容
      </button>

      <header className="ta-shell__bar">
        <div className="ta-shell__brand">
          <span className="ta-shell__seal">
            <BrandMark size={26} />
          </span>
          <span className="ta-shell__title">每日打卡工作台</span>
        </div>

        <nav className="ta-shell__nav" aria-label="主导航">
          {items.map((item) => (
            <a
              key={item.route}
              className={
                item.route === route ? 'ta-shell__navLink ta-shell__navLink--on' : 'ta-shell__navLink'
              }
              href={routeHref(item.route)}
              aria-current={item.route === route ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ta-shell__actions">
          <ThemeToggle />
          <span className="ta-shell__user">
            <span className="ta-shell__displayName">{user.displayName}</span>
            <span className="ta-shell__account ta-mono">@{user.username}</span>
            <span
              className={
                user.role === 'owner' ? 'ta-badge ta-badge--primary' : 'ta-badge'
              }
            >
              {roleLabel}
            </span>
          </span>
          <button
            type="button"
            className="ta-btn ta-btn--secondary ta-btn--sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            aria-busy={logout.isPending}
          >
            <IconLogout size={16} />
            {logout.isPending ? '正在登出…' : '登出'}
          </button>
        </div>
      </header>

      <main className="ta-shell__main" ref={mainRef} id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
