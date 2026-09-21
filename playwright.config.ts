import { defineConfig, devices } from '@playwright/test'

/**
 * 浏览器端到端测试（阶段 1 验收）。
 *
 * 与 vitest 的分工：`npm test` 跑服务端与 shared/ 的单元/集成测试（node 环境），
 * `npm run test:browser` 跑这里——真实 Chromium + 真实前端产物 + 真实服务端。
 * 两边互不包含，`testDir` 收在 tests/browser 内，不会把 .agents/ 的开发工具测试卷进来。
 *
 * 服务端由测试自己拉起：每个测试文件一份**临时库 + 临时端口**的完整栈
 * （见 tests/browser/harness/stack.ts），绝不碰 data/app.db。
 * 因此文件之间不共享任何状态，也就不需要并行——串行反而让端口与日志都好读。
 */
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  // 只留一条会失败的用例没有意义：本地也不允许 .only
  forbidOnly: true,
  // 不自动重试：失败就是失败，重试会把「偶发」伪装成「通过」
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  globalSetup: './tests/browser/harness/global-setup.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      // 只声明 chromium：本机缓存的浏览器是 chromium-1223，与 @playwright/test 1.60.0
      // 精确配对；webkit/firefox 的缓存版本对不上，声明了只会启动失败。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], locale: 'zh-CN' },
    },
  ],
})
