import { useEffect, useSyncExternalStore } from 'react'
import {
  applyRouteTitle,
  navigate,
  readRoute,
  subscribeRoute,
  type RouteName,
} from '../lib/router'

export interface RouteApi {
  /** 地址栏当前路由（白名单枚举值，不是原始 hash） */
  readonly route: RouteName
  readonly navigate: (name: RouteName) => void
}

/**
 * 订阅 hash 路由。
 * useSyncExternalStore 的 getSnapshot 直接读 location.hash 并做白名单查表，
 * 返回值是枚举字符串，引用稳定。
 */
export function useRoute(): RouteApi {
  const route = useSyncExternalStore(subscribeRoute, readRoute, () => 'home' as RouteName)

  useEffect(() => {
    applyRouteTitle(route)
  }, [route])

  return { route, navigate }
}
