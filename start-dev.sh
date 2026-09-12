#!/usr/bin/env bash
# Union-API-Proxy 开发实例启动脚本（与线上 CodeBuddy-API-Proxy 完全隔离）
#
# 隔离要点：
#   PORT=3801                        与线上 3800 并存
#   CODEBUDDY_DATA_DIR=~/.union-api-proxy   独立 SQLite，绝不触碰线上库
#   CODEBUDDY_NO_OPEN=1              不自动弹浏览器，避免与线上管理页混淆
#
# 用法：bash start-dev.sh   （或 Windows 下双击 start-dev.cmd）

set -e
cd "$(dirname "$0")"

export PORT=3801
export CODEBUDDY_DATA_DIR="$HOME/.union-api-proxy"
export CODEBUDDY_NO_OPEN=1

echo "Union-API-Proxy dev instance"
echo "  API/管理页: http://127.0.0.1:${PORT}"
echo "  数据目录:   ${CODEBUDDY_DATA_DIR}"
echo

exec node server.js
