import { useCallback, useSyncExternalStore } from 'react'
import { getThemeState, setTheme, subscribeTheme, type ResolvedTheme } from '../lib/theme'

export interface ThemeApi {
  /** 此刻实际生效的主题（未显式选择过时即系统偏好） */
  readonly resolved: ResolvedTheme
  /** 明 ↔ 暗切换；一旦切过即持久化为显式选择，不再跟随系统 */
  toggle: () => void
}

export function useTheme(): ThemeApi {
  // 快照是模块内的稳定引用，只在取值变化时才换对象
  const state = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState)

  const toggle = useCallback(() => {
    setTheme(state.resolved === 'dark' ? 'light' : 'dark')
  }, [state.resolved])

  return { resolved: state.resolved, toggle }
}
