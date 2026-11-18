#!/usr/bin/env bash
# 坐忘 Senza · 服务器上一键更新（保留 data/ 埋点数据）
# 用法：ssh 到服务器后执行  bash /opt/zuowang/deploy/update.sh
set -euo pipefail

APP_DIR="/opt/zuowang"
SERVICE="zuowang.service"
PORT="3000"

echo "==> 拉取最新 main"
git -C "$APP_DIR" fetch origin
git -C "$APP_DIR" reset --hard origin/main

echo "==> 修复权限（数据文件不会被 git 覆盖）"
mkdir -p "$APP_DIR/data"
touch "$APP_DIR/data/visits.jsonl"
chown -R zuowang:zuowang "$APP_DIR"

echo "==> 重启服务"
systemctl restart "$SERVICE"
sleep 2

echo "==> 健康检查"
curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo

echo "==> 完成。日志：journalctl -u $SERVICE -f"
