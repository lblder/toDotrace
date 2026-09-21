import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 架构文档 §1：代码中不得出现 localhost/端口硬编码假设，一切来自配置。
// dev server 的 API 代理目标由环境变量给出，仅在此处使用默认值。
const apiHost = process.env.TODOAGENT_API_HOST ?? '127.0.0.1'
const apiPort = process.env.TODOAGENT_API_PORT ?? '8787'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: `http://${apiHost}:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
})
