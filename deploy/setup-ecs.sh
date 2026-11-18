#!/usr/bin/env bash
# 兼容旧入口：实际执行服务器端一键部署脚本 deploy/deploy.sh
set -euo pipefail
exec bash "$(dirname "$0")/deploy.sh" "$@"
