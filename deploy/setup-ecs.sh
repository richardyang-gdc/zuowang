#!/usr/bin/env bash
# 坐忘 Senza · ECS 首次部署脚本
# 在服务器上以 root 执行：sudo bash deploy/setup-ecs.sh
# 假设代码已通过 git 推送到 origin/main
set -euo pipefail

APP_DIR="/opt/zuowang"
REPO="https://github.com/richardyang-gdc/zuowang.git"
SERVICE="zuowang.service"
PORT="3000"

echo "==> 1. 检查 Node.js（需要 >= 18.11）"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
  if [ "$NODE_MAJOR" -lt 18 ] || { [ "$NODE_MAJOR" -eq 18 ] && [ "$NODE_MINOR" -lt 11 ]; }; then
    echo "Node 版本过低：$(node -v)，请先升级到 18.11+"; exit 1
  fi
  echo "  已安装：$(node -v)"
else
  echo "  未检测到 Node，请先安装（任选其一后重新运行）："
  echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  echo "  CentOS/TencentOS: curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo yum install -y nodejs"
  exit 1
fi

echo "==> 2. 创建运行用户"
if ! id -u zuowang >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" zuowang
  echo "  已创建用户 zuowang"
else
  echo "  用户 zuowang 已存在"
fi

echo "==> 3. 获取代码"
if [ -d "$APP_DIR/.git" ]; then
  echo "  目录已存在，执行更新"
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" reset --hard origin/main
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO" "$APP_DIR"
fi

echo "==> 4. 准备数据目录与权限"
mkdir -p "$APP_DIR/data"
touch "$APP_DIR/data/visits.jsonl"
chown -R zuowang:zuowang "$APP_DIR"

echo "==> 5. 安装 systemd 服务"
cp "$APP_DIR/deploy/$SERVICE" "/etc/systemd/system/$SERVICE"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
sleep 2

echo "==> 6. 本机健康检查"
curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo

echo "==> 7. 防火墙（仅在工具存在且已启用时开放 ${PORT}）"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow "${PORT}/tcp" && echo "  ufw 已放行 ${PORT}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" && firewall-cmd --reload && echo "  firewalld 已放行 ${PORT}"
else
  echo "  未检测到已启用的防火墙工具，跳过"
fi

echo
echo "==> 完成"
echo "  服务状态: systemctl status $SERVICE"
echo "  实时日志: journalctl -u $SERVICE -f"
echo "  统计数据: curl http://127.0.0.1:${PORT}/api/stats"
echo
echo "【重要】还需要在云控制台安全组放行 TCP ${PORT}，否则外网访问不了。"
echo "  腾讯云：ECS 实例 → 安全组 → 入站规则 → 添加 TCP:${PORT} 来源 0.0.0.0/0（或限定你的 IP）"
