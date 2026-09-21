import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    // 默认 node 环境：服务端与 shared/ 都是纯 Node。
    // 前端组件测试若需 DOM，届时按文件用 `// @vitest-environment jsdom` 覆盖
    // （那需要新增 jsdom 依赖，由主控决定后安装）。
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // 开发工具自带的测试套件（115 个 node:test 文件）不属于本项目，
      // 收入会淹没真实结果——本项目启动时正是如此：115 failed | 5 passed。
      '.agents/**',
    ],
  },
})
