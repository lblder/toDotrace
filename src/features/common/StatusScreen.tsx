import { BrandMark } from './BrandMark'
import { IconAlert, IconRefresh } from './Icons'
import './status-screen.css'

/** 启动中：进程内的第一次握手（首启状态 / 会话核对）完成前显示 */
export function BootScreen({ label = '正在启动' }: { label?: string }) {
  return (
    <div className="ta-status ta-status--boot" role="status" aria-live="polite">
      <BrandMark size={48} />
      <p className="ta-status__label">{label}</p>
    </div>
  )
}

/**
 * 服务不可达：首启状态拿不到时整个应用无法判断该进哪一屏，
 * 因此不能装作「未登录」——如实说明并提供重试。
 */
export function ServiceUnavailableScreen({
  message,
  onRetry,
  retrying = false,
}: {
  message: string
  onRetry: () => void
  retrying?: boolean
}) {
  return (
    <div className="ta-status">
      <BrandMark size={48} />
      <div className="ta-card ta-status__card" role="alert">
        <p className="ta-status__title">
          <IconAlert />
          无法连接到服务
        </p>
        <p className="ta-status__message">{message}</p>
        <p className="ta-status__hint">
          本应用由本机的前后端两个进程组成，请确认后端已启动（开发时用
          <code className="ta-mono"> npm run dev</code> 一并拉起）。
        </p>
        <button
          type="button"
          className="ta-btn ta-btn--secondary"
          onClick={onRetry}
          disabled={retrying}
        >
          <IconRefresh />
          {retrying ? '重试中…' : '重试'}
        </button>
      </div>
    </div>
  )
}
