import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * 全套只跑一次：构建前端产物。
 *
 * 为什么必须构建而不是用 dev server：首帧主题测试要量的正是
 * 「样式表生效之前」那一帧。Vite dev 下 CSS 是由模块脚本注入的，
 * 在 React 启动前页面上根本没有样式——那样的「首帧」测不出任何东西。
 * 生产构建里 CSS 是 head 里的 <link>（渲染阻塞），才是要验的那份东西。
 *
 * 产物落在 dist/（.gitignore 已忽略），与 `npm run build` 完全一致。
 */
export default function globalSetup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })

  const indexHtml = path.join(REPO_ROOT, 'dist', 'index.html')
  if (!existsSync(indexHtml)) {
    throw new Error(`构建结束但找不到 ${indexHtml}`)
  }
  const themeInit = path.join(REPO_ROOT, 'dist', 'theme-init.js')
  if (!existsSync(themeInit)) {
    // public/ 里的文件必须被复制进产物，否则首帧脚本 404，主题测试会全线失败；
    // 在这里就说清楚原因，而不是让 20 条用例各自报一个看不懂的错。
    throw new Error(`构建产物缺少 ${themeInit}——public/theme-init.js 是否还在？`)
  }
}
