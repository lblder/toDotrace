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
      // 浏览器测试是 @playwright/test 的用例，不是 vitest 的。
      // 两者收集范围必须互斥：漏了这条会得到「172 个用例通过、6 个文件失败」
      // 这种自相矛盾的结果（文件级失败全来自 playwright 用例）。
      // 跑法：npm test（vitest）／ npm run test:browser（playwright），互不干涉。
      'tests/browser/**',
    ],
  },
})
