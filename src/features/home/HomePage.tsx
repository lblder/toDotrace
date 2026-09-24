import { useSession } from '../../hooks/use-session'
import './home.css'

/** 工作台首页：账号信息与常用入口。 */
export function HomePage() {
  const { user } = useSession()

  // App 的路由守卫已保证此处必有会话；没有就什么都不渲染，交给守卫带走
  if (user === null) return null

  const roleLabel = user.role === 'owner' ? '管理员' : '成员'

  return (
    <>
      <section className="ta-card ta-home__hero" aria-labelledby="home-heading">
        <h1 className="ta-home__heading" id="home-heading">
          欢迎回来，{user.displayName}
        </h1>

        <dl className="ta-home__facts">
          <div className="ta-home__fact">
            <dt>账号</dt>
            <dd className="ta-mono">{user.username}</dd>
          </div>
          <div className="ta-home__fact">
            <dt>角色</dt>
            <dd>{roleLabel}</dd>
          </div>
        </dl>
      </section>

      <section className="ta-card ta-home__status" aria-labelledby="home-status-heading">
        <h2 className="ta-home__statusHeading" id="home-status-heading">
          常用功能
        </h2>
        <ul className="ta-home__list">
          <li>
            <a className="ta-btn ta-btn--secondary" href="#/tasks">计划待办 →</a>
          </li>
          <li>
            <a className="ta-btn ta-btn--secondary" href="#/checkin">今日打卡 →</a>
          </li>
          <li>
            <a className="ta-btn ta-btn--secondary" href="#/trace">学习轨迹 →</a>
          </li>
        </ul>
      </section>
    </>
  )
}
