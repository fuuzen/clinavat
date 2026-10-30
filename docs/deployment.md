# 部署与运维

Clinavat 由两部分组成：**Hub**（Node.js 后端，默认监听 `127.0.0.1:3001`）和 **Web 入口**（托管前端静态文件，并把 `/api/` 转发给 Hub，默认监听 `127.0.0.1:8080`）。可以直接部署在宿主机上，也可以用 Docker / Podman Compose 部署。

从 CC-Pool 升级的部署请先阅读[从 CC-Pool 升级](upgrade.md)，不要用示例配置覆盖原有 `.env`。

## 环境要求

| 类别 | 要求 |
| --- | --- |
| 系统 | Linux；Bash、coreutils、flock（util-linux）、ripgrep、OpenSSH 客户端、Python 3（本机网页终端使用） |
| 运行时 | Node.js 22.13+（建议 22.23.4） |
| 同步 | Mutagen 0.18.1 |
| 官方 CLI | Claude Code（最低 2.1.295，建议 2.1.308）、Codex 0.164.0 |
| 宿主机部署另需 | Caddy |

Docker 镜像已内置以上依赖，版本可以通过 `.env` 中的 `CLAUDE_CODE_VERSION`、`CODEX_VERSION`、`MUTAGEN_VERSION` 调整。

## 配置项

复制 `.env.example` 为 `.env` 后修改。常用配置：

| 变量 | 说明 |
| --- | --- |
| `CLINAVAT_MASTER_KEY` | **必填**。64 位十六进制主密钥，用 `openssl rand -hex 32` 生成。用于加密保存 SSH 私钥，丢失后已保存的私钥无法解密，必须长期保留 |
| `CLINAVAT_DATA_DIR` | 数据目录（数据库、密钥、槽位授权等），默认项目根目录下的 `data/`；相对路径以 `backend/` 为基准 |
| `CLINAVAT_WORKSPACE_DIR` | 项目镜像目录，默认 `/var/tmp/clinavat-workspace` |
| `CLINAVAT_HOST` / `CLINAVAT_PORT` | Hub 监听地址，默认 `127.0.0.1:3001` |
| `CLINAVAT_WEB_BIND` / `CLINAVAT_WEB_PORT` | Web 入口监听地址，默认 `127.0.0.1:8080` |
| `CLINAVAT_COOKIE_SECURE` | 通过 HTTPS 访问时设为 `true` |
| `CLINAVAT_REGISTRATION` | 是否开放自助注册，默认 `false`；修改后需重启 Hub |
| `CLINAVAT_ORIGIN` | 首次启动时导入的公开访问地址（宿主机部署），见下文 |
| `CLINAVAT_PUBLIC_ORIGIN` | 同上，供 Compose 部署使用 |
| `CLINAVAT_APPROVAL_TIMEOUT_MS` | 网页审批的等待时间，默认 5 分钟 |
| `CLINAVAT_GATEWAY_HOST` / `_PORT` / `_USER` | [上游网关](../deploy/gateway/README.md)的 SSH 地址；留空则管理面板不连接网关 |
| `CLINAVAT_*_BIN` | `claude`、`codex`、`mutagen`、`ssh`、`ssh-keygen` 的可执行文件路径 |

## 宿主机部署

使用当前用户的两个 systemd 服务：`clinavat-hub.service` 运行后端，`clinavat-web.service` 用 Caddy 托管前端并代理 `/api/`（包括 SSE 和 WebSocket）。

```bash
cp .env.example .env   # 填写 CLINAVAT_MASTER_KEY 等配置
npm ci
npm run check
npm run build
npm run host:install
```

`host:install` 会记录当前 Node 和 Caddy 的绝对路径，以及当前的 `PATH`，因此请先确保官方 CLI 和 Mutagen 都在 `PATH` 中。日常操作：

```bash
npm run host:status
npm run host:logs
npm run host:stop
npm run host:start
# 更新代码或 .env 后，重新构建并重装服务：
npm run build
npm run host:install
```

需要在退出登录后保持运行、并随系统启动时，执行 `loginctl enable-linger "$USER"`（是否有权限取决于系统策略）。

有正在运行的对话时，直接 `npm run build` 会覆盖线上的前端文件，应改用下文的[不中断任务的发布](#不中断任务的发布)。

### 运行时文件

- 解密后的 SSH 私钥和 SSH 连接复用套接字放在 `$XDG_RUNTIME_DIR/clinavat`（数据目录中的 `run` 是指向它的链接），服务停止时自动清理。如果 `run` 已经是一个非空目录，安装脚本不会删除其中内容。
- Hub 每次启动时会为已有同步会话的用户启动 Mutagen 守护进程（保留暂停状态）；服务停止时这些进程随之结束。

### 防止项目镜像被系统清理

项目镜像默认位于 `/var/tmp/clinavat-workspace/proj_<id>`。它是持久数据，不能被临时文件清理任务删除。如果号池机或开发机启用了 systemd-tmpfiles 对 `/var/tmp` 的清理，请由管理员安装排除规则：

```bash
sudo cp deploy/clinavat-tmpfiles.conf /etc/tmpfiles.d/clinavat.conf
```

修改了 `CLINAVAT_WORKSPACE_DIR` 时，同步修改该文件中的路径。

## Docker / Podman Compose

```bash
cp .env.example .env   # 填写 CLINAVAT_MASTER_KEY；首次就用公开域名访问时，可预填 CLINAVAT_PUBLIC_ORIGIN
docker compose up -d --build
```

使用 Podman 时安装 `podman-compose`，并把本文中的 `docker compose` 换成 `podman compose`。

默认只监听 `127.0.0.1:8080`。先访问 `http://localhost:8080` 创建管理员、在管理面板中添加公开访问地址，再把 `.env` 中的 `CLINAVAT_WEB_BIND` 改为号池机的内网地址或 `0.0.0.0`，执行 `docker compose up -d` 生效。修改 `CLINAVAT_WEB_PORT` 时它会同时传给 Hub，用于生成正确的本机默认来源。

两个容器：

- **hub**：以非 root 的 `node` 用户运行，内置官方 CLI、OpenSSH 和 Mutagen，不对外暴露端口。
- **web**：托管前端并代理 SSE / WebSocket，是唯一对外发布的端口。

两个持久卷：`data` 保存数据库、加密的 SSH 私钥、槽位授权和 Mutagen 元数据；`workspaces` 保存项目镜像。解密后的私钥位于 `/srv/clinavat/run` 的内存挂载中，重启后自动恢复。

```bash
docker compose logs -f hub
docker compose exec hub node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>r.json()).then(console.log)"
```

本机开发机在 Compose 部署中指的是**容器内**的目录，需要通过卷或绑定挂载提供项目代码。

## 公开访问与反向代理

为防止跨站请求，Hub 只接受来自允许名单的请求。名单默认只有 `http://localhost:<端口>` 和 `http://127.0.0.1:<端口>`（开发时另含 `VITE_PORT`）。

添加公开地址：进入「管理面板 → 网关和访问 → 访问配置」，在 Public URL 中填写地址并保存，HTTP 请求和 WebSocket 立即使用新名单，无需重启。

- 每个地址是完整的 Origin，例如 `https://clinavat.example.com` 或带非默认端口的 `http://10.0.0.5:8080`；不能包含路径、参数、用户名或通配符。
- 可以添加多个域名，它们共享账号和数据，但登录 Cookie 按域名区分，需要分别登录。
- 名单保存在数据库中。`CLINAVAT_ORIGIN` / `CLINAVAT_PUBLIC_ORIGIN` 只在首次启动时导入一次，之后修改环境变量不会覆盖面板中的配置，删除的地址也不会被重新导入。

首次就想通过公开域名访问时，可以在 `.env` 预填：

```dotenv
CLINAVAT_ORIGIN=https://clinavat.example.com,https://clinavat.example.net   # 宿主机部署
CLINAVAT_PUBLIC_ORIGIN=https://clinavat.example.com,https://clinavat.example.net   # Compose 部署
CLINAVAT_COOKIE_SECURE=true
```

### 多层代理

一种常见的入口是：浏览器 HTTPS → 上层反向代理（终止 TLS）→ 网关内网端口 → 号池机 Web 入口。此时：

1. 上层代理用 HTTP 访问网关的 `8080` 端口，网关再转发到号池机的同一端口。
2. 号池机 `.env` 中把 `CLINAVAT_WEB_BIND` 设为网关能访问到的内网地址，并设 `CLINAVAT_COOKIE_SECURE=true`。
3. 在管理面板添加浏览器实际访问的 HTTPS 地址。

每一层代理都需要：

- 保留原始的 `Host` 和 `Origin` 请求头；
- 转发 WebSocket 的 `Upgrade` / `Connection` 头；
- 对 SSE 关闭响应缓冲和缓存，并设置足够长的连接超时。

可参考 [上层 Nginx 示例](../deploy/nginx-upstream.conf.example)，按注释替换域名和网关地址后合并到现有 HTTPS 站点，其中的 `map` 需放在 `http` 块。

## 数据与备份

需要备份的内容：

- `CLINAVAT_DATA_DIR`（Compose 为 `data` 卷）：SQLite 数据库、加密的 SSH 私钥、槽位授权、用户会话数据；
- `CLINAVAT_WORKSPACE_DIR`（Compose 为 `workspaces` 卷）：项目镜像；
- `.env` 中的 `CLINAVAT_MASTER_KEY`。

备份前先停止 Hub。不要只复制正在运行的 SQLite 主文件，否则会漏掉 WAL 中的数据。在新机器恢复时，必须同时恢复数据和原主密钥。

数据库、槽位、项目和会话中记录了绝对路径，SSH / Mutagen 配置也和数据目录位置有关。**更换数据目录位置时必须一起迁移这些路径**；直接换成一个空的数据目录会看到全新的初始化页面。

`docker compose down` 会保留数据，`docker compose down -v` 会**删除**数据卷。

### 从 Compose 迁移到宿主机部署

1. 停止 Hub，完整备份持久卷和原 `.env`。
2. 把卷中的数据恢复到宿主机的数据目录，修正文件所有者。
3. 按上文完成宿主机部署并验证。
4. 用 `podman compose down`（不加 `-v`）停用容器，保留旧卷和备份。

## 不中断任务的发布

宿主机部署的线上文件位于 `backend/dist` 和 `frontend/dist`。有对话正在运行时，先构建到单独的目录，再用发布脚本在系统空闲时切换：

```bash
npm run check
node node_modules/typescript/bin/tsc -p backend/tsconfig.json --outDir .releases/staging/backend
npm exec -w frontend -- vite build --outDir ../.releases/staging/frontend --emptyOutDir
node --no-warnings deploy/release.mjs status
node --no-warnings deploy/release.mjs publish .releases/staging
```

发布脚本的行为：

- **只在空闲时发布**：有任何运行中的对话、待处理的审批或账号切换进程时，脚本不做任何改动，返回退出码 `75`，稍后重试即可。
- **防止发布途中有新任务**：空闲时先在数据库中设置发布锁，阻止新任务启动，再更新并重启服务。
- **自动验证和回滚**：发布后检查后端健康接口和前端页面；失败时自动恢复旧版本。旧版本保存在 `.releases/<发布编号>/previous`，需要手动回滚时把这个目录传给同一个 `publish` 命令。

只更新前端时，在 `publish` 命令后加 `--frontend-only`：只重启 Web 入口，Hub 和正在进行的额度查询不受影响。此时暂存目录中的 `backend/` 必须与线上 `backend/dist/` 完全一致（可以直接复制线上文件）。这种发布的 `previous/` 只包含前端；回滚时把旧 `frontend/` 和当前线上后端复制到新的暂存目录，再用同样的选项发布。

如果发布进程被意外终止，发布锁会保留，以免不完整的版本接收任务。按 `.releases/<发布编号>/release.json` 恢复前后端构建并确认服务正常后，执行 `node deploy/release.mjs unblock` 解除。

## 重置管理员密码

有服务器或容器的运维权限时，可以用本地命令重置管理员密码。命令需要交互式终端，会隐藏输入并要求输入两次（12–256 个字符）；密码不能通过参数或环境变量传入。只修改密码，不影响账号、槽位、项目、对话和 SSH 密钥。

宿主机部署，在项目根目录执行：

```bash
npm run build -w backend   # 更新源码后先构建
npm run admin:reset-password -- --username '管理员用户名'
npm run admin:reset-password -- --list    # 忘记用户名时，列出所有管理员
# 数据目录与当前 .env 不同时，用绝对路径指定：
npm run admin:reset-password -- --username '管理员用户名' --data-dir '/实际数据目录'
```

命令读取项目根目录的 `.env` 来确定数据目录，不需要主密钥，也不会初始化空数据库。请用运行 Hub 的系统用户执行。

Docker / Podman 部署（镜像需包含最新构建）：

```bash
docker compose exec hub node backend/dist/reset-admin-password.js --username '管理员用户名'
docker compose exec hub node backend/dist/reset-admin-password.js --list
```

不要给 `exec` 加 `-T`，命令需要交互终端。

重置后，该管理员的所有登录会话立即失效：旧 Cookie 的下一次请求会被拒绝，已打开的事件流和终端在 15 秒内断开。如需立即断开所有连接，可以重启 Hub（`systemctl --user restart clinavat-hub.service` 或 `docker compose restart hub`），但这会同时中断其他用户正在运行的任务。
