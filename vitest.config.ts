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
    /**
     * 单条用例的超时预算。
     *
     * **为什么必须是 20 秒而不是默认的 5 秒**（阶段 4 实测，不是猜的）：
     *
     * 口令哈希是 **scrypt**，故意昂贵（ADR-008 §4 的安全属性，不是实现偷懒）。
     * 于是凡是要跑几次注册/登录往返的用例，耗时以**秒**计。实测空闲机器上：
     *
     *   | 用例 | 耗时 | 占默认 5 秒预算 |
     *   |---|---|---|
     *   | 「登录成功后清零失败计数」 | 3212 ms | **64%** |
     *   | 「防爆破按用户名原样分桶」 | 2219 ms | 44% |
     *   | 「连续 5 次失败后第 6 次返回 429」 | 1636 ms | 33% |
     *
     * 那个 64% 是关键：**空闲时就已经吃掉三分之二**，而全套件并行跑时
     * CPU 争用会让它成倍变慢——于是它随机超时。阶段 4 观察到过两次
     * （`server/tests/auth-flow.test.ts`，全套件负载下 2 条失败、单跑 45/45 全过）。
     *
     * **这是容量退化，不是「flake」**：套件从阶段 3 的 615 条涨到 1254 条，
     * 争用翻倍，而**预算没有跟着涨**。「flake」是个标签，不是诊断——
     * 真正的机制是「同一条用例的耗时随并行度线性增长，而阈值是常量」。
     *
     * 20 秒留了约 6 倍余量（空闲 3.2 s × 争用系数），
     * 同时仍能在合理时间内判出一条**真正挂死**的用例。
     *
     * ⚠️ **不要因为「它偶尔红」而把它调得更大**：那会让一条挂死的用例
     * 拖满超时才报错。若将来又不够用，**先量最慢的几条**再决定。
     */
    testTimeout: 20_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // 开发工具自带的测试套件（115 个 node:test 文件）不属于本项目，
      // 收入会淹没真实结果——本项目启动时正是如此：115 failed | 5 passed。
      '.agents/**',
      'backups/**',
      // 浏览器测试是 @playwright/test 的用例，不是 vitest 的。
      // 两者收集范围必须互斥：漏了这条会得到「172 个用例通过、6 个文件失败」
      // 这种自相矛盾的结果（文件级失败全来自 playwright 用例）。
      // 跑法：npm test（vitest）／ npm run test:browser（playwright），互不干涉。
      'tests/browser/**',
    ],
  },
})
