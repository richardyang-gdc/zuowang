# 坐忘 Senza · 部署与快速迭代方案

服务端已改为**自动适应 IP**：默认监听 `0.0.0.0`（所有网卡），本机 `127.0.0.1`、ECS 内网 IP、公网 IP 都能访问，不需要改代码。想恢复只本机可访问，启动时加 `HOST=127.0.0.1`。

## 一、它怎么工作

```
本地改代码 → npm run dev 热更新看效果 → git push → 服务器 git pull + deploy.sh → 线上验证
```

- 前端 API 用相对路径 `/api/pv`，天然跟随当前域名/IP，无需改地址。
- 数据写在本机项目内 `data/visits.jsonl`，`git pull` 不会覆盖它。
- Node 零依赖，ECS 只需装 Node 18.11+，不用 `npm install`。

## 二、首次部署（一次性）

**1. 本地把最新代码推送到 GitHub main**（含 `/ryadmin` 后台的版本）。若遇 non-fast-forward，按之前给过的 merge 命令先处理。

**2. SSH 登录服务器，克隆仓库：**

```bash
ssh root@你的公网IP
git clone https://github.com/richardyang-gdc/zuowang.git /opt/zuowang
cd /opt/zuowang
```

**3. 云控制台放行端口（必须手动做，脚本无法代劳）**

- 腾讯云轻量应用服务器 → 实例 → 防火墙 → 添加规则
- 协议 TCP，端口 `3000`，来源 `0.0.0.0/0`（测试期可先限定你自己的 IP 更安全）
- 保存后立即生效

## 三、每次部署 / 迭代（含首次克隆后）

在服务器上执行两步：

```bash
cd /opt/zuowang
git pull
sudo bash deploy/deploy.sh
```

一键脚本会：检查并在需要时装 Node.js 22 → 建 `zuowang` 运行用户与 `data/` → 首次生成后台随机密码并写入 `.env`（scrypt 哈希 + 盐，权限 600）→ 安装 systemd 服务 → 启动 → 健康检查 → 打印访问地址。

- **首次运行**会在终端打印一次随机管理员密码，只显示这一次，请立即保存。
- **再次运行**默认保留已有 `.env`，不会覆盖密码。
- 要改密码：`sudo ADMIN_PASS='你的新密码' bash deploy/deploy.sh`，或交互式 `sudo bash deploy/set-password.sh`。
- `git pull` 不会覆盖 `.env` 和 `data/visits.jsonl`（都已在 `.gitignore`）。

后台入口 `http://你的公网IP:3000/ryadmin`，用户名固定 `richard.yang`，密码见上一步。

**外网验证**

浏览器打开 `http://你的ECS公网IP:3000`。统计接口 `/api/stats` **已加登录保护**，不带会话 Cookie 会返回 401；请通过 `/ryadmin` 登录后查看，或用：

```bash
curl -c /tmp/ck -X POST http://你的ECS公网IP:3000/ryadmin/login \
  -H 'Content-Type: application/json' -d '{"user":"richard.yang","pass":"你的密码"}'
curl -b /tmp/ck http://你的ECS公网IP:3000/api/stats
```

服务日志：`journalctl -u zuowang -f`。若端口想换，改 `deploy/zuowang.service` 里的 `Environment=PORT=xxxx`，再 `systemctl daemon-reload && systemctl restart zuowang`，安全组同步放行新端口。

## 四、日常迭代（每次改代码）

**本地热更新看效果：**

```bash
cd /Users/Richard/Documents/workbuddy/zuowang-mvp
npm run dev          # Node 内置 --watch，改完 server.js 自动重启
```

前端 `public/` 下的 HTML/CSS/JS 是静态文件，改完刷新浏览器即可，不用重启服务。若占用 3000 端口：`PORT=3001 npm run dev`。

**本地提交并推送：**

```bash
git add -A && git commit -m "本次改动说明" && git push origin main
```

**服务器上线（就是第三节那两步）：**

```bash
cd /opt/zuowang
git pull
sudo bash deploy/deploy.sh
```

一键脚本不会动 `data/` 和 `.env`，所以历史埋点和后台密码都会保留。

**验证清单（每次部署后）：**

```bash
curl http://你的ECS公网IP:3000/api/health   # 应返回 ok:true
curl http://你的ECS公网IP:3000/ryadmin      # 应返回登录页 HTML
curl http://你的ECS公网IP:3000/api/stats    # 未登录应返回 401
journalctl -u zuowang -n 20 --no-pager      # 看有无报错
```

浏览器打开 `/ryadmin` 登录后，开无痕窗口访问一次主页，刷新后台 pv 应 +1。

## 五、常用运维

| 操作 | 命令 |
| --- | --- |
| 看状态 | `systemctl status zuowang` |
| 重启 | `systemctl restart zuowang` |
| 停/启 | `systemctl stop zuowang` / `systemctl start zuowang` |
| 日志 | `journalctl -u zuowang -f` |
| 看埋点数据 | `tail -f /opt/zuowang/data/visits.jsonl` |
| 备份数据 | `cp /opt/zuowang/data/visits.jsonl ~/visits-$(date +%F).jsonl` |
| 回滚 | `git -C /opt/zuowang reset --hard <旧commit>` 后 `systemctl restart zuowang` |

## 六、安全提醒（上线前至少做一条）

`/api/stats` 和 `/ryadmin` 已由登录会话保护（scrypt 校验 + HttpOnly Cookie + 失败限流），`.env` 只存哈希与盐、权限 600。长期用还建议：

1. **最简**：安全组来源限定为公司/家里固定 IP，减少暴露面。
2. **推荐**：前面加 Nginx 反代 80/443 并上 HTTPS（腾讯云免费证书）；识别到 HTTPS 时登录 Cookie 会自动加 `Secure`。此时 systemd 里 `PORT` 可保持 `3000`，并把 `HOST=127.0.0.1` 写回 service 只给本机 Nginx 用。
3. **接口防护**：`POST /api/pv` 目前只校验 id 格式，任何人可刷埋点；正式运营可加简单 token 或限流。

### Nginx 反代配置（配合登录限流必须有 `X-Forwarded-For`）

`server.js` 的失败限流按 `X-Forwarded-For` 识别来源。如果反代只传 `X-Real-IP`，所有请求都会被当成 `127.0.0.1`，**任何一个人输错 5 次密码就会锁住全部人 15 分钟**。配置如下：

```bash
sudo tee /etc/nginx/sites-available/zuowang <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/zuowang /etc/nginx/sites-enabled/zuowang
sudo nginx -t && sudo systemctl reload nginx
```

上 HTTPS 后，把 `listen 80` 改为跳转并新增 `listen 443 ssl`，`X-Forwarded-Proto` 就能让服务正确判断并给 Cookie 加 `Secure`。

## 七、环境变量速查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；设 `127.0.0.1` 则仅本机可访问 |
| `PORT` | `3000` | 监听端口，云控制台安全组要同步放行 |
