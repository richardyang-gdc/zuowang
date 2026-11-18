# 坐忘 Senza · 部署与快速迭代方案

服务端已改为**自动适应 IP**：默认监听 `0.0.0.0`（所有网卡），本机 `127.0.0.1`、ECS 内网 IP、公网 IP 都能访问，不需要改代码。想恢复只本机可访问，启动时加 `HOST=127.0.0.1`。

## 一、它怎么工作

```
本地改代码 → npm run dev 热更新看效果 → git push → 服务器 update.sh → 线上验证
```

- 前端 API 用相对路径 `/api/pv`，天然跟随当前域名/IP，无需改地址。
- 数据写在本机项目内 `data/visits.jsonl`，`git pull` 不会覆盖它。
- Node 零依赖，ECS 只需装 Node 18.11+，不用 `npm install`。

## 二、首次部署（一次性）

**1. 确保代码已推送到 GitHub main**（注意本地与远端历史可能无关，先处理 non-fast-forward 再推）。

**2. SSH 登录 ECS，把仓库克隆到 `/opt/zuowang` 并一键装服务：**

```bash
ssh root@你的ECS公网IP
git clone https://github.com/richardyang-gdc/zuowang.git /opt/zuowang
cd /opt/zuowang
sudo bash deploy/setup-ecs.sh
```

脚本会：检查 Node → 建 `zuowang` 运行用户 → 拉代码 → 建数据目录和权限 → 安装 systemd 服务 → 本机健康检查 → 尝试放行系统防火墙。

**3. 云控制台安全组放行端口（必须手动做，脚本无法代劳）**

- 腾讯云 ECS → 实例 → 安全组 → 入站规则 → 添加规则
- 协议 TCP，端口 `3000`，来源 `0.0.0.0/0`（测试期可先限定你自己的 IP 更安全）
- 保存后立即生效

**4. 外网验证**

浏览器打开 `http://你的ECS公网IP:3000`，另开一条验证统计：

```bash
curl http://你的ECS公网IP:3000/api/stats
```

服务日志：`journalctl -u zuowang -f`。若端口想换，改 `deploy/zuowang.service` 里的 `Environment=PORT=xxxx`，再 `systemctl daemon-reload && systemctl restart zuowang`，安全组同步放行新端口。

## 三、日常迭代（每次改代码）

**本地热更新看效果：**

```bash
cd /Users/Richard/Documents/workbuddy/zuowang-mvp
npm run dev          # Node 内置 --watch，改完 server.js 自动重启
```

前端 `public/` 下的 HTML/CSS/JS 是静态文件，改完刷新浏览器即可，不用重启服务。若占用 3000 端口：`PORT=3001 npm run dev`。

**一条命令完成提交 + 上线 + 验证：**

```bash
./deploy/dev-deploy.sh "本次改动说明" root@你的ECS公网IP
```

它会 `git add -A && git commit && git push` → SSH 到服务器执行 `update.sh`（拉代码、保数据、重启、健康检查）。

不带服务器参数则只推送：

```bash
./deploy/dev-deploy.sh "本次改动说明"
# 然后到服务器手动：ssh root@IP 'bash /opt/zuowang/deploy/update.sh'
```

也可以只设一次默认服务器，以后省掉第二个参数：

```bash
export ZUOWANG_SERVER=root@你的ECS公网IP
```

**验证清单（每次部署后）：**

```bash
curl http://你的ECS公网IP:3000/api/health   # 应返回 ok:true
curl http://你的ECS公网IP:3000/api/stats    # 看 pv/uv 是否在涨
journalctl -u zuowang -n 20 --no-pager      # 看有无报错
```

浏览器开无痕窗口访问一次，`/api/stats` 的 pv 应该 +1。

## 四、常用运维

| 操作 | 命令 |
| --- | --- |
| 看状态 | `systemctl status zuowang` |
| 重启 | `systemctl restart zuowang` |
| 停/启 | `systemctl stop zuowang` / `systemctl start zuowang` |
| 日志 | `journalctl -u zuowang -f` |
| 看埋点数据 | `tail -f /opt/zuowang/data/visits.jsonl` |
| 备份数据 | `cp /opt/zuowang/data/visits.jsonl ~/visits-$(date +%F).jsonl` |
| 回滚 | `git -C /opt/zuowang reset --hard <旧commit>` 后 `systemctl restart zuowang` |

## 五、安全提醒（上线前至少做一条）

现在服务直接暴露在公网，`/api/stats` 任何人都能看到你的访问数据。MVP 阶段可接受，但要长期用，建议：

1. **最简**：安全组来源限定为公司/家里固定 IP，或给服务器挂安全组白名单。
2. **推荐**：前面加 Nginx 反代 80/443，`/api/stats` 加 basic auth；同时上 HTTPS（腾讯云免费证书）。此时 systemd 里的 `PORT` 可改回 `3000` 只给本机 Nginx 用，并把 `HOST=127.0.0.1` 写回 service。
3. **接口防护**：`POST /api/pv` 目前只校验 id 格式，任何人可刷；正式运营可加简单 token 或限流。

## 六、环境变量速查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；设 `127.0.0.1` 则仅本机可访问 |
| `PORT` | `3000` | 监听端口，云控制台安全组要同步放行 |
