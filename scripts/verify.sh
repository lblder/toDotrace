#!/usr/bin/env bash
# 收工判据：把全部检查跑完，**不因前一步失败而短路**。
#
# 为什么不用 `&&` 串联：阶段 2 出现过一次——`npm test` 里一条阶段 1 遗留的陈旧断言失败，
# 导致 build 与浏览器测试**根本没跑**。报告里只能看到「1 failed」，
# 而实际全貌是「5 项检查里 4 项通过、1 项是一条过期的版本号断言」。
# 让人无法判断影响面，是验证工具最不该犯的错误。
#
# 用法：npm run verify  （任一项失败则整体退出码非 0）
#
# 互斥锁：本脚本**不是并发安全的** —— 它会重建 dist/、清空 test-results/，
# 而浏览器测试的栈以 NODE_ENV=production 托管 dist/。
# 两套并发跑会互相破坏，表现为「某个 spec 莫名超时 / 服务端返回 500」，
# 且**不留痕迹**（并发方把 test-results/ 清掉了）。
# 阶段 3 真实发生过一次：两个 agent 同时跑 verify，一方的 07-checkin 失败，
# 排查后发现是另一方在重建 dist/。故用目录锁互斥，把「碰巧不撞」变成「撞不上」。
set -u

LOCK_DIR="${TMPDIR:-/tmp}/todoagent-verify.lock"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  if [ -n "$(find "${LOCK_DIR}" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    echo "⚠️  发现陈旧的 verify 锁（超过 30 分钟），判定为上次异常退出，接管"
    rm -rf "${LOCK_DIR}"
    mkdir "${LOCK_DIR}" 2>/dev/null || { echo "❌ 无法获取锁：${LOCK_DIR}"; exit 1; }
  else
    echo "❌ 另一个 verify 正在运行（锁：${LOCK_DIR}）"
    echo "   本脚本会重建 dist/ 并清空 test-results/，并发跑会互相破坏。"
    echo "   请等它结束，或确认无其他实例后手动删除该目录。"
    exit 1
  fi
fi
trap 'rm -rf "${LOCK_DIR}"' EXIT INT TERM

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
