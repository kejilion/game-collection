#!/usr/bin/env sh
# 一键构建并启动（服务器上执行）
set -e
cd "$(dirname "$0")/.."
docker compose up -d --build
echo "💣 炸弹派对已启动: http://localhost:3000"
