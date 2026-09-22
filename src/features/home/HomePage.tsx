import { useSession } from '../../hooks/use-session'
import './home.css'

/**
 * 工作台首页。
 * 阶段 1 只有骨架与账号，这里如实呈现「已就绪 / 待接入」，
 * 不摆空图表、不预告未实现的功能。
 */
export function HomePage() {
  const { user } = useSession()

  // App 的路由守卫已保证此处必有会话；没有就什么都不渲染，交给守卫带走
  if (user === null) return null

  const roleLabel = user.role === 'owner' ? 'owner' : '成员'

  return (
    <>
      <section className="ta-card ta-home__hero" aria-labelledby="home-heading">
        <p className="ta-home__eyebrow ta-mono">PHASE 1 · 骨架与账号</p>
        <h1 className="ta-home__heading" id="home-heading">
          欢迎回来，{user.displayName}
        </h1>
        <p className="ta-home__subtitle">
          账号已经可用。数据全部存在本机 <code className="ta-mono">data/app.db</code>
          ，不向任何外部服务发送。
        </p>

        <dl className="ta-home__facts">
          <div className="ta-home__fact">
            <dt>账号标识</dt>
            <dd className="ta-mono">{user.id}</dd>
          </div>
          <div className="ta-home__fact">
            <dt>角色</dt>
            <dd>{roleLabel}</dd>
          </div>
        </dl>
      </section>

      <section className="ta-card ta-home__status" aria-labelledby="home-status-heading">
        <h2 className="ta-home__statusHeading" id="home-status-heading">
          进度
        </h2>
        <ul className="ta-home__list">
          <li className="ta-home__listItem ta-home__listItem--done">
            首启创建 owner、邀请码注册、登录 / 登出、会话校验
          </li>
          <li className="ta-home__listItem ta-home__listItem--done">
            owner 签发邀请码，凭码注册新账号
          </li>
          <li className="ta-home__listItem ta-home__listItem--done">
            鉴权关口：无令牌请求一律被拒，数据按账号隔离
          </li>
          <li className="ta-home__listItem ta-home__listItem--done">
            每日打卡：到达 / 离开、连续天数、休息日呈现
          </li>
          <li className="ta-home__listItem">
            计划、周期、分析 —— 后续阶段逐步接入
          </li>
        </ul>
      </section>
    </>
  )
}
