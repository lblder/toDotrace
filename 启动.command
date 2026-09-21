#!/bin/bash
# TodoAgent · 每日打卡工作台 —— 双击启动
#
# 流程（开发文档 §8）：确保前端已构建 → 启动服务（默认仅绑 127.0.0.1，
# 可交互选择开放局域网并明示风险）→ 打开浏览器。
#
# 数据只有一个持久文件：data/app.db。服务停止时 -wal 已 checkpoint，
# 直接复制该文件即完整备份；服务运行中请用 VACUUM INTO 产出一致快照（ADR-003）。

cd "$(dirname "$0")" || exit 1

PORT="${TODOAGENT_API_PORT:-8788}"
HOST="127.0.0.1"
SERVER_PID=""

# 端口占用时顺延取一个空闲端口：默认端口未必归本程序独占
# （本机 8787 就长期被另一个程序占用）。生产态下前端由本进程托管，
# 端口不必与 vite dev 代理的默认值一致，因此顺延是安全的；但会明确打印。
port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
if port_in_use "$PORT"; then
  ORIGINAL_PORT="$PORT"
  for candidate in $(seq $((PORT + 1)) $((PORT + 20))); do
    if ! port_in_use "$candidate"; then PORT="$candidate"; break; fi
  done
  if [ "$PORT" = "$ORIGINAL_PORT" ]; then
    echo "[错误] 端口 ${ORIGINAL_PORT} 及其后 20 个端口都被占用，无法启动。"
    read -r -p "按回车键关闭窗口…" _
    exit 1
  fi
  echo "[提示] 端口 ${ORIGINAL_PORT} 已被其他程序占用，本次改用 ${PORT}。"
fi

echo "=============================================="
echo " TodoAgent · 每日打卡工作台"
echo "=============================================="

# ---------- 运行环境自检 ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node。请先安装 Node 22 或更高版本（https://nodejs.org）。"
  read -r -p "按回车键关闭窗口…" _
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[错误] 需要 Node 22 或更高版本，当前为 $(node -v)。"
  read -r -p "按回车键关闭窗口…" _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖（npm install）…"
  npm install || { echo "[错误] 依赖安装失败。"; read -r -p "按回车键关闭窗口…" _; exit 1; }
fi

# ---------- 前端产物 ----------
if [ ! -f dist/index.html ]; then
  echo "未发现前端产物，正在构建（npm run build）…"
  if ! npm run build; then
    echo "[错误] 前端构建失败，服务未启动。请修复后重试。"
    read -r -p "按回车键关闭窗口…" _
    exit 1
  fi
fi

# ---------- 监听范围 ----------
echo
echo "访问范围："
echo "  [1] 仅本机（默认，推荐）—— 只有这台电脑能打开"
echo "  [2] 局域网 —— 同一网络下的手机/平板也能打开"
echo "      风险：局域网内是明文 HTTP，同一网段的设备可能嗅探到登录令牌；"
echo "      请仅在自家可信网络下开启，不要在公共 Wi-Fi 下使用。"
read -r -t 15 -p "请选择 1 或 2（15 秒后默认 1）：" choice
case "$choice" in
  2)
    HOST="0.0.0.0"
    echo "已选择：开放局域网。"
    ;;
  *)
    echo "已选择：仅本机。"
    ;;
esac

# ---------- 启动服务 ----------
echo
echo "正在启动服务…（关闭此窗口或按 Ctrl+C 即停止）"
echo
NODE_ENV=production TODOAGENT_API_HOST="$HOST" TODOAGENT_API_PORT="$PORT" npm start &
SERVER_PID=$!

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup INT TERM EXIT

# 等待就绪（最多 30 秒）
READY=""
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/api/setup/status" >/dev/null 2>&1; then
    READY="1"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if [ -z "$READY" ]; then
  echo "[错误] 服务未能在 30 秒内就绪，请查看上方日志。"
  echo "       若日志提示端口被占用，可用 TODOAGENT_API_PORT=其他端口 重试。"
  read -r -p "按回车键关闭窗口…" _
  exit 1
fi

URL="http://127.0.0.1:${PORT}"
echo "服务已就绪：${URL}"
if [ "$HOST" = "0.0.0.0" ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"
  [ -n "$LAN_IP" ] && echo "局域网地址：http://${LAN_IP}:${PORT}（手机与电脑需在同一网络）"
fi

if [ "${TODOAGENT_NO_BROWSER:-}" != "1" ]; then
  open "$URL" 2>/dev/null || echo "（未能自动打开浏览器，请手动访问上面的地址）"
fi

echo
echo "数据文件：${TODOAGENT_DB_PATH:-$(pwd)/data/app.db} —— 停服务后复制该文件即完整备份。"
echo

wait "$SERVER_PID"
