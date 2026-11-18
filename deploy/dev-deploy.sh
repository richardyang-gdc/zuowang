#!/usr/bin/env bash
# 坐忘 Senza · 本机一条命令：提交 → 推送 → 远程更新 → 验证
# 用法：./deploy/dev-deploy.sh "提交信息" [服务器SSH地址]
# 例：  ./deploy/dev-deploy.sh "调浅暖灰" root@1.2.3.4
set -euo pipefail

MSG="${1:?请提供提交信息}"
SERVER="${2:-${ZUOWANG_SERVER:-}}"
BRANCH="main"

echo "==> 本地提交并推送"
git add -A
git commit -m "$MSG"
git push origin "$BRANCH"

if [ -n "$SERVER" ]; then
  echo "==> 远程更新：$SERVER"
  ssh "$SERVER" "bash /opt/zuowang/deploy/update.sh"
  echo "==> 完成，访问 http://$SERVER 对应的公网 IP:${PORT:-3000}"
else
  echo "==> 未指定服务器SSH地址，已推送。请到 ECS 执行："
  echo "    ssh <你的服务器> 'bash /opt/zuowang/deploy/update.sh'"
fi
