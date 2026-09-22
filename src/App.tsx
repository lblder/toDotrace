import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { SetupOwnerPage } from './features/auth/SetupOwnerPage'
import { CheckinPage } from './features/checkin/CheckinPage'
import { BootScreen, ServiceUnavailableScreen } from './features/common/StatusScreen'
import { HomePage } from './features/home/HomePage'
import { InvitesPage } from './features/invites/InvitesPage'
import { AppShell } from './features/shell/AppShell'
import { useRoute } from './hooks/use-route'
import { useSession } from './hooks/use-session'
import { useSetupStatus } from './hooks/use-setup'
import { errorMessage } from './lib/api-client'
import { resolveRoute, type RouteName } from './lib/router'

/**
 * 路由白名单 → 屏幕。键是枚举，查表必然命中，
 * 因此不存在「未知路由」这种需要回显地址栏内容的渲染分支。
 */
const SCREENS: Readonly<Record<RouteName, () => ReactElement | null>> = {
  setup: SetupOwnerPage,
  login: LoginPage,
  register: RegisterPage,
  home: HomePage,
  checkin: CheckinPage,
  invites: InvitesPage,
}

/** 登录后才有外壳（顶栏 + 导航）；账号三页自带整屏版式，不套壳 */
const SHELLED: ReadonlySet<RouteName> = new Set<RouteName>(['home', 'checkin', 'invites'])

export function App() {
  const { route, navigate } = useRoute()
  const setup = useSetupStatus()
  const session = useSession()

  // 首启状态没拿到之前，无法判断该进哪一屏——先不下结论
  const needsOwner = setup.data?.needsOwner ?? false

  /**
   * 判断依据齐了没有。
   *
   * 三个输入（首启状态、本地令牌、服务端核对的会话）都到位之前**不能下结论**：
   * 那时 `authenticated`/`isOwner` 都还是 false，任何受保护的地址都会被判成非法，
   * 把用户从 #/invites 直接甩回 #/login，深链接当场丢失。
   * 未就绪时原样保留请求的路由，只渲染启动屏（见下面的提前 return）。
   */
  const settled = !setup.isPending && !setup.isError && !session.isLoading

  const effective = settled
    ? resolveRoute(route, {
        needsOwner,
        authenticated: session.isAuthenticated,
        isOwner: session.isOwner,
      })
    : route

  // 守卫结果落到地址栏（只写白名单路径，不写用户的原始 hash）
  useEffect(() => {
    if (settled && route !== effective) navigate(effective)
  }, [settled, route, effective, navigate])

  if (setup.isPending) {
    return <BootScreen />
  }

  if (setup.isError) {
    return (
      <ServiceUnavailableScreen
        message={errorMessage(setup.error)}
        onRetry={() => {
          void setup.refetch()
        }}
        retrying={setup.isFetching}
      />
    )
  }

  // 本地有令牌时，先向服务端核对会话再决定进哪一屏
  if (session.isLoading) {
    return <BootScreen label="正在核对会话" />
  }

  const Screen = SCREENS[effective]

  // 外壳自带会话兜底：会话若在渲染中途消失，它会退回启动屏而不是崩掉
  return SHELLED.has(effective) ? (
    <AppShell>
      <Screen />
    </AppShell>
  ) : (
    <Screen />
  )
}
