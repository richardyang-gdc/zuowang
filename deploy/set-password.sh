#!/usr/bin/env bash
# 坐忘 Senza · 设置 ryadmin 登录密码
# 在服务器项目根目录执行：bash deploy/set-password.sh
# 用 scrypt + 随机盐生成不可逆哈希，写入项目根 .env（chmod 600），明文不落盘。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

echo "设置 ryadmin 管理员密码（用户名固定为 richard.yang）"
read -r -s -p "新密码: " PASS1; echo
read -r -s -p "确认密码: " PASS2; echo

if [ "$PASS1" != "$PASS2" ]; then
  echo "两次输入不一致，已取消"; exit 1
fi
if [ ${#PASS1} -lt 8 ]; then
  echo "密码至少 8 位，已取消"; exit 1
fi

# 用 Node 内置 crypto 生成 salt 与 scrypt 哈希，避免依赖 python 模块
PASS="$PASS1" ENV_FILE="$ENV_FILE" node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  const pass = process.env.PASS;
  const file = process.env.ENV_FILE;
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pass, salt, 64).toString("hex");
  const body = "# ryadmin 登录凭据（由 deploy/set-password.sh 生成，请勿提交）\n"
    + "ADMIN_PASS_HASH=" + hash + "\n"
    + "ADMIN_PASS_SALT=" + salt + "\n";
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log("已写入 " + file + "（权限 600，仅属主可读）");
'

echo "完成。重启服务生效：systemctl restart zuowang"
