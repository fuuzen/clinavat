# CC-Pool

基于 [reference.md](reference.md) 实现的多用户 CLI2Web 工作台。React + Vite 前端与 Fastify + TypeScript 控制面独立部署，SQLite 管理用户、专属槽位、开发机、项目、对话、审批和可重放事件。官方 CLI 在号池机运行，源码由 Mutagen 双向同步，命令通过 SSH 在开发机执行。

## 已实现

- 首次管理员初始化、密码登录、可配置注册、HttpOnly 会话 Cookie、来源校验和登录限流。
- 管理员通过设置面板创建普通成员，查看用户及其槽位；关闭公开注册时仍可创建用户。
- 数据库唯一约束和事务保证一人一槽。绑定永久保留，禁用或限流不会把账号分给其他人。
- 每用户 Ed25519 密钥、导入无口令私钥、AES-256-GCM 加密持久化、SSH ControlMaster、首次连接信任主机密钥及后续严格校验。
- SSH 跳板机连接：开发机可配置独立跳板地址、端口、用户名及密钥，目录浏览、远程命令、同步和 Web 终端共享同一连接路径。
- 开发机远端目录浏览，项目镜像、Mutagen 编排、同步重试、路径与符号链接边界校验。
- 远程命令执行前后同步屏障、子目录映射、退出码传递；同步失败时中止命令。
- Claude Code NDJSON 与 Codex app-server 原生会话恢复，SSE 流式文字、工具卡片、Web 审批、停止任务与重启中断恢复。
- 输入框支持选择 CLI 提供的模型及其思考强度，同一会话可在下一轮切换，并保存所选配置。
- 每轮执行、搜索、文件操作默认按组折叠；结束后将公开进度与执行过程收起为 `Worked for …`，可点击查看，刷新后保留过程和耗时。
- 中文三栏工作台、Markdown 对话、文件预览、远端 Git 状态 / Diff、xterm.js SSH 终端及账号槽位管理。
- Docker Compose 部署、反向代理与持久卷。没有预置账号、演示数据或模拟 CLI 响应。

## 本地开发

需要 Linux、Node.js 22.13+、OpenSSH 客户端、Bash、coreutils、flock（util-linux）、ripgrep、Mutagen 0.18.1，以及官方 Claude Code / Codex CLI。建议采用容器中固定的版本：Claude Code 2.1.308、Codex 0.164.0。

```bash
cp .env.example .env
openssl rand -hex 32
# 将输出填入 .env 的 CC_POOL_MASTER_KEY，保留此密钥。
npm ci
npm run dev
```

打开 `http://localhost:5173`，创建管理员，密码至少 12 位。`.env` 中 `CC_POOL_ORIGIN` 必须与浏览器地址完全一致；修改访问地址时同步修改它。开发代理地址通过 `VITE_API_PROXY_TARGET` 配置。

```bash
npm run check
npm run build
npm start
```

`npm start` 仅启动后端，生产前端应由反向代理托管。数据库默认位于项目根目录的 `data/`（后端工作目录下的 `../data`）；可用 `CC_POOL_DATA_DIR` 指定绝对路径。构建不需要官方账号或 SSH 开发机。按项目约定不提供单元 / 集成测试套件。

## 宿主机部署

使用 Node.js 后端、Caddy 静态前端和反向代理，分别由当前用户的 systemd 服务托管。需先安装 Linux、Node.js 22.13+（建议 22.23.4）、Caddy、Mutagen 0.18.1、官方 Claude Code / Codex CLI，以及本地开发章节中的系统工具，并将程序加入 `PATH`。独立安装的 Claude / Codex 应满足上文版本要求。宿主部署不依赖容器。

首次部署时复制 `.env.example` 为 `.env`，配置并保留 `CC_POOL_MASTER_KEY`；已有部署必须沿用原密钥和数据。将 `CC_POOL_ORIGIN` 设为浏览器实际地址（默认 `http://localhost:8080`），`CC_POOL_DATA_DIR` 指向持久数据目录（相对路径以 `backend/` 为基准），后端默认监听 `127.0.0.1:3001`。前端入口使用 `CC_POOL_WEB_BIND` / `CC_POOL_WEB_PORT`，默认仅监听 `127.0.0.1:8080`。`CC_POOL_PUBLIC_ORIGIN` 仅供 Compose 使用，不会覆盖宿主后端的 `CC_POOL_ORIGIN`。

```bash
npm ci
npm run check
npm run build
npm run host:install
```

安装命令创建并启用 `cc-pool-hub.service` 和 `cc-pool-web.service` 两个 systemd 用户服务，固定当前 Node / Caddy 的绝对路径，并将安装时的 `PATH` 传给后端。前端托管 `frontend/dist`，`/api/` 代理到后端，支持 SSE 和 WebSocket。公开入口的 TLS 可由上游反向代理终止。

多层入口可采用“浏览器 HTTPS → 上层反向代理 → 网关内网端口 → 宿主 Caddy”的路径。上层终止 TLS 后，使用 HTTP 访问网关的 `8080` 端口，由网关转发到宿主的同一端口。宿主 `.env` 中将 `CC_POOL_WEB_BIND` 设为网关可达的宿主内网地址，`CC_POOL_ORIGIN=https://pool.example.com`，并设 `CC_POOL_COOKIE_SECURE=true`；示例域名须替换为实际公开域名，`CC_POOL_ORIGIN` 应包含协议和必要的非默认端口，不带路径或尾部斜杠。后端仍只监听本机地址，网关仅需转发 Web 入口。若保留 Compose 配置，可同时将 `CC_POOL_PUBLIC_ORIGIN` 设为相同公开地址。

各层反向代理应保留原始 `Host` 和浏览器的 `Origin`，传递 WebSocket 的 `Upgrade` / `Connection`，并关闭 SSE 响应缓冲和缓存，设置适当的长连接超时。[上层 Nginx 示例](deploy/nginx-upstream.conf.example) 可合并到现有 HTTPS 站点；按注释替换域名和网关地址占位符，并将 `map` 放到 `http` 块。HTTP 回源不改变浏览器使用 HTTPS 和安全 Cookie 的要求。

```bash
npm run host:status
npm run host:logs
npm run host:stop
npm run host:start
# 更新代码或 .env 后，重新构建并更新、重启服务：
npm run build
npm run host:install
```

需在退出登录后继续运行并随系统启动时，执行 `loginctl enable-linger "$USER"`（权限取决于本机策略）。服务使用 `RuntimeDirectory=cc-pool`，将数据目录中的 `run` 链接到 `$XDG_RUNTIME_DIR/cc-pool`，解密后的 SSH 私钥及连接复用套接字随服务停止清理；遇到已有非空 `run` 目录时安装不会自动删除其中内容。Hub 每次启动后会为已有持久化同步会话的用户启动 Mutagen 守护进程，保留会话的暂停状态；停止服务时通过同一 systemd 控制组结束这些守护进程。

从 Compose 迁移时，先停止 Hub，完整备份持久卷与原 `.env`，再恢复至宿主数据目录并修正文件所有者。不要直接切换到空的 `data/`，否则会出现全新初始化页面。SQLite 中槽位、工作区和会话含绝对路径，SSH / Mutagen 配置也与数据根相关；改变数据根须一并迁移这些路径并恢复同步。验收后使用 `podman compose down` 停用容器，保留旧卷和备份，不使用 `down -v`。

## Docker / Podman Compose

```bash
cp .env.example .env
# 设置 CC_POOL_MASTER_KEY、CC_POOL_PUBLIC_ORIGIN 和需要的监听地址。
docker compose up -d --build
```

使用 Podman 时，安装 Podman 和 `podman-compose`，将本文中的 `docker compose` 替换为 `podman compose`：

```bash
podman compose up -d --build
podman compose ps
podman compose logs -f
```

默认仅绑定本机 `127.0.0.1:8080`，访问 `http://localhost:8080`。首次初始化管理员后，在 `.env` 中将 `CC_POOL_WEB_BIND` 改为号池机的内部地址或 `0.0.0.0`，将 `CC_POOL_PUBLIC_ORIGIN` 设为真实入口（包括协议与端口），再运行 `docker compose up -d`。由现有 LXC DNAT 将入口流量转入该端口。公网入口应配置 HTTPS，并设 `CC_POOL_COOKIE_SECURE=true`。

`hub` 镜像以非 root 的 `node` 用户运行，安装官方 CLI、OpenSSH 和 Mutagen；`web` 镜像托管静态前端并代理 SSE / WebSocket。只有 Web 端口对外发布。`pool-data` 卷保存 SQLite、加密 SSH 私钥、槽位 OAuth 状态、工作区与 Mutagen 元数据；解密后的 SSH 私钥位于 `/srv/pool/run` 的临时内存挂载中，服务重启自动恢复。新机器恢复时须同时恢复持久卷和原 `CC_POOL_MASTER_KEY`。

```bash
docker compose logs -f hub
docker compose exec hub node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>r.json()).then(console.log)"
```

备份时先停止 `hub`，再备份完整 `pool-data` 卷与主密钥。不要只复制运行中的 SQLite 主文件而遗漏 WAL。`docker compose down` 保留数据，`down -v` 会删除数据。

## 配置专属账号

管理员可在「设置与连接 → 用户管理」点击「创建用户」，填写用户名和至少 12 位的初始密码。创建的账号为普通成员，创建过程不会切换管理员登录，也不受 `CC_POOL_REGISTRATION` 开关影响。新成员会自动绑定一个空闲槽位；暂无空闲槽位时仍可创建并显示为「待分配」，之后在「账号槽位」绑定该用户。初始密码由管理员通过可信渠道交给成员，创建成功后表单会清空密码。

1. 在工作台设置 → 账号槽位创建槽位，如 `slot_01`，选择 `claude` / `codex` 引擎。管理员可绑定指定用户；未绑定的空闲槽位会在用户登录或刷新工作台时事务分配。
2. 在服务器中以运行 Hub 的操作系统用户，在该槽位 HOME 内完成官方授权。管理界面提供实际目录及登录命令。容器示例：

```bash
docker compose exec -e HOME=/srv/pool/slots/slot_01 hub claude auth login
docker compose exec -e HOME=/srv/pool/slots/slot_01 hub codex login --device-auth
```

3. 需要多人注册时设 `CC_POOL_REGISTRATION=true` 并重启 Hub。先完成账号授权再开放注册。没有可用槽位的用户仍能管理开发机，但无法启动智能体。

槽位的 `RATE_LIMITED` 和 `DISABLED` 状态会阻止新任务；运行中的会话需要先停止才可更改槽位状态。不会自动抓取订阅套餐或判定 OAuth 是否有效；槽位标签由管理员填写，实际认证错误由官方 CLI 返回。注册默认关闭，OAuth 令牌不会返回浏览器。

## 忘记管理员密码

拥有服务器或容器运维权限时，可通过本地恢复命令重置已有管理员的密码。命令要求交互式终端，隐藏输入并确认两次新密码（12–256 个字符）；密码不能通过参数或环境变量传入。不会删除账号、槽位、OAuth 状态、项目、对话或 SSH 密钥。

宿主机部署，在项目根目录执行：

```bash
# 更新源码后先生成恢复命令：
npm run build -w backend
npm run admin:reset-password -- --username '实际管理员用户名'
# 忘记用户名时可只读列出管理员：
npm run admin:reset-password -- --list
# 数据目录与当前 .env 不同时，用绝对路径指定：
npm run admin:reset-password -- --username '实际管理员用户名' --data-dir '/实际持久数据目录'
```

宿主机命令加载项目根目录的 `.env`，按后端相同规则读取 `CC_POOL_DATA_DIR`。恢复命令只访问现有数据库，不会初始化空平台，也不需要主密钥。请以运行 Hub 的操作系统用户执行，使用同一份持久数据。

Docker Compose 部署（镜像须包含最新构建的恢复命令）：

```bash
docker compose exec hub node backend/dist/reset-admin-password.js --username '实际管理员用户名'
docker compose exec hub node backend/dist/reset-admin-password.js --list
```

Podman 部署将 `docker compose` 替换为 `podman compose`。保留 `exec` 默认的交互终端，不要使用 `-T`。容器命令读取容器内的 `CC_POOL_DATA_DIR`，默认访问 `/srv/pool` 持久卷。

重置成功会立即撤销该管理员所有登录会话，旧 Cookie 的下一次 HTTP 请求将被拒绝，现有事件流和终端最多 15 秒后关闭。密码校验期间遇到重置的旧登录请求也无法创建有效新会话。需要立即结束所有现有连接时，可重启 Hub；这会同时中断其他用户正在运行的任务和终端：宿主机执行 `systemctl --user restart cc-pool-hub.service`，容器执行 `docker compose restart hub`。

## 连接开发机与项目

在「添加开发机」中填写地址、SSH 端口和用户，将展示的公钥加入开发机的 `~/.ssh/authorized_keys`，或导入已有无口令私钥。点击连接时首次记录主机密钥并显示指纹；管理员应通过可信渠道核对。后续主机密钥变化会拒绝连接，不会自动清空 `known_hosts`。

需要经过跳板机时，开启「通过跳板机连接」，填写跳板机地址、端口和用户名。例如目标为 `developer@dev.internal:22`、跳板机为 `gateway@jump.example.com:2222`，等价于 `ssh -J gateway@jump.example.com:2222 developer@dev.internal`。当前支持一台跳板机；两端分别认证，可分别导入不同的无口令私钥，未导入时使用平台专属密钥。将平台公钥分别加入需要使用它的跳板机和目标机。跳板机须允许到目标 SSH 端口的 TCP 转发，目标机地址由跳板机访问。

开发机菜单中的「编辑连接」可为已有开发机添加、修改或移除跳板配置，私钥留空保留原密钥。仅修改名称不会影响项目；修改连接或密钥前须停止运行中的任务。系统暂停关联项目同步并关闭 Web 终端后保存新连接，保留项目镜像与远端文件。之后先「测试连接」核对两端指纹，再在项目工作区点击「立即同步」恢复同步。首次测试连接记录两端主机密钥，后续连接均严格验证；无需把目标机私钥上传到跳板机。

开发机应有 Bash、SSH / SCP 和目标项目目录。Mutagen 会自动安装对应平台 agent。选择该主机并输入或浏览绝对路径来创建项目。首次同步以远端为 alpha、本地镜像为 beta，使用 `two-way-resolved`；排除依赖、常见构建产物、运行时 `.bin` 和 Git 内部目录，保留依赖锁文件。它按排除规则过滤，**并非任意文件类型的纯文本识别器**。

Git 操作直接在远端执行，因此不会同步大型 `.git` 对象。Diff 包括 `HEAD` 相对暂存区和工作树的已跟踪改动；未跟踪文件显示在状态中。项目删除先终止同步，再移除镜像和控制面记录，保留远端源码。删除对话只删除平台记录，官方 CLI 槽位中的原生日志仍保留。

开发机出站地址仍须由现有 LXC 网关加入直连白名单。服务不自动改写网关策略，也不安装代理；官方 CLI 访问官方服务沿用宿主机已配置的出站网络。容器桥接 / NAT 流量也须由网关实际核验，应用代码不能保证网络出口或账号风控结果。

## 两种 CLI 的执行与审批

只设置 `SHELL` 不足以保证官方 CLI 的工具执行位置，因此本实现使用显式工具路由：

- **Claude Code**：使用 `--restricted`、隔离的 settings、固定工具白名单及 `PreToolUse` Hook。读写限制在项目镜像内，编辑与命令等待网页审批；Bash 的 `updatedInput` 将原命令包装为调用项目 `remote-shell`。Hook 通过每次运行随机令牌的 Unix Socket 与 Hub 通信，超时或断开即拒绝，并配置 `onFailure: block`。最低需要 2.1.295，建议使用固定的 2.1.308。
- **Codex**：使用固定版本的 `app-server` JSON RPC 和实验性 dynamic tools。禁用本地 shell，并使用只读原生沙箱；提供 `remote_command` 与带路径检查的本地 `workspace_read/list/search/write/replace`。所有远端命令和编辑都需网页审批，原生命令 / 文件变更审批直接拒绝。这样不依赖 Codex 未承诺支持的 `SHELL` 覆盖行为。

每个项目最多一个智能体任务。输入框底部使用紧凑的自定义菜单：点击模型名称选择模型，新对话也可在此切换引擎；点击旁边的思考图标调整强度。列表从当前专属槽位的 CLI 动态读取，仅展示对应模型支持的强度；选择「跟随默认」时沿用其默认配置，运行中不能更改，下一轮可以切换。菜单支持方向键选择、Enter 确认、Escape 关闭。实时响应中的文本和工具信息显示在工作台，原始隐藏推理不展示。

命令、搜索和其他工具操作按组显示摘要，点击可展开具体输入与输出。每轮结束后，进度、公开思考摘要和工具记录自动收起为 `Worked for …`，最终答复保持可见；审批卡片独立展示。会话的模型配置，以及每轮执行过程和耗时保存到 SQLite，切换会话或刷新页面后仍能查看。升级前已有的历史消息保持原样，无法补回当时未保存的执行记录。

原生会话 ID 用于继续对话，不会扫描导入管理员在平台外创建的任意 CLI 历史。SSE 支持 `Last-Event-ID` 重放，重连也重新读取消息、执行过程和待审批项。服务重启将运行中任务及执行轮次标为中断、待审批标为过期。

远程命令必须以前台方式完成。分离后台任务、跨机器文件同步冲突、用户同时通过外部终端修改同一文件仍需人工协调。`sync flush` 是同步屏障，不等同于分布式事务；同步出错会显示错误并阻止命令继续。手动 Web 终端直接连接远端，开启与退出时同步，长期交互期间由 Mutagen 持续同步。

独立 HOME 提供逻辑账号隔离，文件工具和接口提供路径边界；当前版本没有为每个租户建立独立 Linux UID、容器、cgroup 或网络命名空间。适用于受信任团队；面向不受信任租户部署前，需要进一步加入操作系统级隔离。账号使用仍须遵守上游服务条款，不保证住宅网络或原生 CLI 能避免封禁。

协议依据：[OpenAI app-server](https://learn.chatgpt.com/docs/app-server)、[Claude Hooks](https://code.claude.com/docs/en/hooks)、[Claude CLI reference](https://code.claude.com/docs/en/cli-reference)、[Mutagen 安装](https://mutagen.io/documentation/introduction/installation)。Codex 动态工具属于实验接口，升级前应核对目标版本生成的 JSON Schema；镜像版本可通过 `.env` 中的构建参数调整。

## 验证状态

已通过 `npm run check`、`npm run build`、生产依赖审计，以及官方 Compose 命令的配置校验。在临时本机 OpenSSH 开发节点上实际验证了密钥连接、目录浏览、Mutagen 双向同步、remote-shell 前后屏障和退出码传递、远端 Git Diff、WebSocket PTY、项目删除时撤销终端并保留远端源码。最终后端构建产物可直接启动；浏览器验证了登录、槽位设置、会话创建 / 重命名 / 删除、文件预览、终端和手机布局。

Claude 的固定版本参数和 Codex 的固定版本 app-server 初始化 / 动态工具协议已实际核对。尚未使用已授权槽位进行真实模型对话与工具审批闭环；这一步需要管理员完成官方 OAuth。已使用 Podman 5.7.0 / podman-compose 1.5.0 以普通用户模式完成镜像构建和容器启动，确认 Hub 健康检查、前端页面与静态资源、初始化状态接口以及容器内 Claude Code / Codex / Mutagen / OpenSSH 均正常。另已完成宿主 Node.js / Caddy 的 systemd 用户服务启动、前端页面和资源、后端健康接口及原 Compose 数据迁移验收；宿主部署脚本支持在 Hub 每次启动后恢复已有 Mutagen 守护进程。

## 目录

```text
backend/src/
  agent/       官方 CLI 协议、工具路由、权限 Hook
  routes/      开发机、项目、会话、管理员 API
  runtime/     SSH、加密密钥、同步、remote-shell、PTY
  server.ts    Fastify 入口与生命周期
frontend/src/
  components/  登录、导航、对话、检查器、管理弹窗、终端
deploy/        Nginx / Caddy 配置和宿主 systemd 服务管理
compose.yaml   容器与 SQLite 持久卷
```
