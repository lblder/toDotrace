// 样式必须排在最前：Vite 打包出的 CSS 顺序 = 模块导入顺序，
// 组件（features/*）各自带样式，若先导入组件，特性样式会排到令牌之前，
// 同优先级规则就会被后加载的基础控件样式覆盖。**这段顺序勿调**。
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { initTheme } from './lib/theme'

// 在首次渲染前落好主题属性，避免首帧闪烁（初始跟随系统偏好）
initTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 本地单机应用：窗口重新聚焦不必重取，避免无谓请求
      refetchOnWindowFocus: false,
      // 失败不自动重试，错误如实交给界面（首启状态单独放宽为 1 次）
      retry: false,
      staleTime: 30_000,
    },
    mutations: {
      retry: false,
    },
  },
})

const container = document.getElementById('root')

if (container === null) {
  throw new Error('找不到挂载点 #root，检查 index.html')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
