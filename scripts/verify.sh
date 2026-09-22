#!/usr/bin/env bash
# 收工判据：把全部检查跑完，**不因前一步失败而短路**。
#
# 为什么不用 `&&` 串联：阶段 2 出现过一次——`npm test` 里一条阶段 1 遗留的陈旧断言失败，
# 导致 build 与浏览器测试**根本没跑**。报告里只能看到「1 failed」，
# 而实际全貌是「5 项检查里 4 项通过、1 项是一条过期的版本号断言」。
# 让人无法判断影响面，是验证工具最不该犯的错误。
#
# 用法：npm run verify  （任一项失败则整体退出码非 0）
set -u

fail=0

run() {
  local label="$1"; shift
  echo
  echo "──────────────────────────────────────────"
  echo "▶ ${label}"
  echo "──────────────────────────────────────────"
  if "$@"; then
    echo "✓ ${label} 通过"
  else
    echo "✗ ${label} 失败（退出码 $?）"
    fail=1
  fi
}

run "类型检查（tsc --noEmit）"        npm run typecheck
run "单元测试（vitest）"              npm test
run "构建（vite build）"              npm run build
run "浏览器测试（playwright）"        npm run test:browser

echo
echo "══════════════════════════════════════════"
if [ "${fail}" -eq 0 ]; then
  echo "✅ verify 全部通过"
else
  echo "❌ verify 有失败项 —— 见上方各段输出"
fi
echo "══════════════════════════════════════════"

exit "${fail}"
