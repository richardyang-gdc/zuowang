#!/usr/bin/env bash
# 坐忘 Senza · 服务器端一键部署脚本
# 前置：已在本目录执行 git pull，代码已是最新 main
#
# 用法（在服务器 /opt/zuowang 下）：
#   sudo bash deploy/deploy.sh                        # 首次自动生成随机管理员密码，只显示一次
#   sudo ADMIN_PASS='你的强密码' bash deploy/deploy.sh  # 指定/修改管理员密码
#
# 行为：
#   - 检查并在需要时安装 Node.js 22
#   - 创建运行用户 zuowang、数据目录 data/
#   - 首次生成后台密码（scrypt 哈希 + 随机盐写入 .env，权限 600）；再次运行默认保留原密码
#   - 安装 systemd 服务、重启、健康检查、打印访问地址
#   - 不执行 git pull（由你显式执行），不会覆盖 data/ 与 .env
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请提权执行：sudo bash deploy/deploy.sh"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="zuowang.service"
PORT=3000
ENV_FILE="$ROOT/.env"
export DEBIAN_FRONTEND=noninteractive
cd "$ROOT"

echo "==> [1/6] 检查 Node.js（需要 >= 18.11）"
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  MINOR=$(node -p 'process.versions.node.split(".")[1]')
  if [ "$MAJOR" -lt 18 ] || { [ "$MAJOR" -eq 18 ] && [ "$MINOR" -lt 11 ]; }; then NEED_NODE=1; fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  echo "  未安装或版本过低，安装 Node.js 22..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  Node: $(node -v)"

echo "==> [2/6] 创建运行用户与数据目录"
id -u zuowang >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir "$ROOT" zuowang
mkdir -p "$ROOT/data"
touch "$ROOT/data/visits.jsonl"

echo "==> [3/6] 配置后台登录密码"
GENERATED=0
if [ -n "${ADMIN_PASS:-}" ]; then
  if [ ${#ADMIN_PASS} -lt 8 ]; then
    echo "密码至少 8 位，已取消"
    exit 1
  fi
elif [ -f "$ENV_FILE" ] && grep -q '^ADMIN_PASS_HASH=' "$ENV_FILE"; then
  echo "  保留已有 .env（未覆盖密码）"
else
  ADMIN_PASS="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
  GENERATED=1
fi
if [ "$GENERATED" -eq 1 ] || [ -n "${ADMIN_PASS:-}" ]; then
  ADMIN_PASS="$ADMIN_PASS" ENV_FILE="$ENV_FILE" node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(process.env.ADMIN_PASS, salt, 64).toString("hex");
    const body = "# ryadmin 登录凭据（由 deploy/deploy.sh 生成，请勿提交）\n"
      + "ADMIN_PASS_HASH=" + hash + "\n"
      + "ADMIN_PASS_SALT=" + salt + "\n";
    fs.writeFileSync(process.env.ENV_FILE, body, { mode: 0o600 });
    fs.chmodSync(process.env.ENV_FILE, 0o600);
  '
  echo "  已写入 $ENV_FILE（scrypt 哈希 + 随机盐，权限 600）"
fi

echo "==> [4/6] 修复权限并安装 systemd 服务"
chown -R zuowang:zuowang "$ROOT"
cp "$ROOT/deploy/$SERVICE" "/etc/systemd/system/$SERVICE"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

echo "==> [5/6] 健康检查"
OK=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  echo "服务未就绪，最近日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  exit 1
fi
curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo

echo "==> [6/6] 系统防火墙检查"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow "${PORT}/tcp" >/dev/null && echo "  ufw 已放行 ${PORT}"
else
  echo "  未检测到已启用的 ufw，跳过（仍需云控制台放行）"
fi

PRIVATE_IP="$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)"
echo
echo "==================== 部署完成 ===================="
echo "  本机地址: http://127.0.0.1:${PORT}"
[ -n "$PRIVATE_IP" ] && echo "  内网地址: http://${PRIVATE_IP}:${PORT}"
echo "  公网地址: http://<你的公网IP>:${PORT}  （控制台可见）"
echo "  后台入口: http://<你的公网IP>:${PORT}/ryadmin"
echo "  用户名:   richard.yang"
if [ "$GENERATED" -eq 1 ]; then
  echo "  密码:     ${ADMIN_PASS}   ← 自动生成，仅此一次显示，请立即保存"
elif [ -n "${ADMIN_PASS:-}" ]; then
  echo "  密码:     已用你指定的 ADMIN_PASS 更新"
else
  echo "  密码:     沿用已有 .env（可用 sudo bash deploy/set-password.sh 重设）"
fi
echo "  服务状态: systemctl status ${SERVICE}"
echo "  日志:     journalctl -u ${SERVICE} -f"
echo
echo "【必做】腾讯云控制台 → 轻量应用服务器 → 防火墙 → 添加规则："
echo "        TCP ${PORT}，来源 0.0.0.0/0（测试期可限定你的 IP）"
echo "=================================================="
