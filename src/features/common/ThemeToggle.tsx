import { useTheme } from '../../hooks/use-theme'
import { IconMoon, IconSun } from './Icons'

/**
 * 主题切换：明 / 暗两态。初始未选择时跟随系统偏好（需求文档 §4），
 * 一旦点过就持久化为显式选择。
 */
export function ThemeToggle() {
  const { resolved, toggle } = useTheme()
  const next = resolved === 'dark' ? '亮色' : '暗色'

  return (
    <button
      type="button"
      className="ta-btn ta-btn--ghost ta-icon-btn"
      onClick={toggle}
      aria-label={`切换到${next}主题`}
      title={`切换到${next}主题`}
    >
      {resolved === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  )
}
