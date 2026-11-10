#!/usr/bin/env bash
# ============================================================
# 学徒考勤系统 · macOS / Linux 启动脚本（对应 Windows 的 start.bat）
#   ./start-mac.sh              启动并自动打开浏览器
#   NO_OPEN=1 ./start-mac.sh    只启动服务，不弹浏览器
#   PORT=9000 ./start-mac.sh    换端口
# Ctrl+C 停止服务；MySQL 由 brew services 独立管理，不受影响。
# ============================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f "config/database.env" ]]; then
  echo "缺少 config/database.env，请先运行：./setup-database-mac.sh"
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "缺少依赖目录 node_modules，请先运行：pnpm install"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js（建议 20 及以上）。"
  exit 1
fi

# 数据库连通性预检，失败时给出明确指引而不是抛栈
DB_HOST_VAL="$(awk -F= '/^DB_HOST=/{print $2}' config/database.env)"
DB_PORT_VAL="$(awk -F= '/^DB_PORT=/{print $2}' config/database.env)"
DB_HOST_VAL="${DB_HOST_VAL:-127.0.0.1}"
DB_PORT_VAL="${DB_PORT_VAL:-3306}"

if ! node -e "
const net = require('net');
const s = net.connect(Number('${DB_PORT_VAL}'), '${DB_HOST_VAL}');
s.setTimeout(1500);
s.on('connect', () => { s.end(); process.exit(0); });
s.on('error', () => process.exit(1));
s.on('timeout', () => { s.destroy(); process.exit(1); });
" 2>/dev/null; then
  echo "数据库 ${DB_HOST_VAL}:${DB_PORT_VAL} 不可达。"
  echo "MySQL 可能没在跑，试试：brew services start mysql@8.0"
  exit 1
fi

exec node server.js
