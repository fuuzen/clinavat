# 开发指南

技术栈：React + Vite 前端，Fastify + TypeScript 后端，SQLite 存储。代码规范见 [AGENTS.md](../AGENTS.md)。按项目约定，不编写单元 / 集成测试。

## 本地开发

先安装[部署文档](deployment.md#环境要求)中列出的系统工具和官方 CLI（只做构建和类型检查时不需要）。

```bash
install -d -m 700 ~/.config/clinavat && install -m 600 .env.example ~/.config/clinavat/hub.env
openssl rand -hex 32        # 填入 hub.env 的 CLINAVAT_MASTER_KEY
npm ci
npm run dev                 # 同时启动后端和前端
```

打开 `http://localhost:5173`，创建管理员（密码至少 12 位）。前端开发服务器把 `/api` 代理到 `VITE_API_PROXY_TARGET`（默认 `http://127.0.0.1:3001`）。

```bash
npm run check   # 前后端类型检查
npm run prices:update -w backend   # 更新用量统计使用的模型价格快照
npm run build   # 构建项目目录内的 backend/dist 和 frontend/dist，不影响运行目录中的线上服务
npm start       # 只启动后端；生产环境的前端由 Web 入口托管
```

数据库默认位于 `~/.local/share/clinavat/clinavat.sqlite`，可用 `CLINAVAT_DATA_DIR` 修改。Vite 的开发设置（`VITE_*`）写在项目根目录的 `.env.local`，其中不要放密钥。构建和类型检查不需要官方账号或开发机。

客户端不在根目录的 workspaces 中，开发和构建都在 `client/` 下进行，需要另装 Rust 工具链，见[客户端](client.md#构建)。只修改 Hub 列表页时，`npm run check --prefix client` 不需要 Rust。

## 在线预览

在线预览是一个纯静态站点，可以托管到 GitHub Pages，用来展示和体验界面。它和正式版**使用同一份前端代码**：构建时以 `demo` 模式启动 [Mock Service Worker](https://mswjs.io/)，在浏览器里拦截 `/api` 的请求、SSE 事件流和终端 WebSocket，由 `frontend/demo/` 中的模拟数据和脚本化的智能体响应。

```bash
npm run dev:demo -w frontend                          # 本地体验，不需要后端
VITE_BASE=/<repo>/ npm run build:demo -w frontend     # 构建到 frontend/dist-demo
```

- 数据保存在页面内存中，刷新即重置。
- 正式构建会剔除全部模拟代码。
- 推送到 `main` 后，`.github/workflows/demo-pages.yml` 自动构建并发布。需要在仓库设置中把 Pages 的来源设为 GitHub Actions。访问路径由 Pages 配置自动确定：`<用户名>.github.io/<仓库名>/` 使用子路径，自定义域名使用根路径；需要强制指定时设置仓库变量 `DEMO_BASE`。站点必须通过 **HTTPS** 访问，浏览器只在安全连接下允许 Service Worker，HTTP 下模拟后端无法启动。
- **前端新增接口时**，需要在 `frontend/demo/handlers/` 中补充对应的模拟，否则该接口在预览中会提示“在线预览中无法执行该操作”。

## 目录结构

```text
backend/src/
  accounts/    槽位分配、凭据与运行状态
  agent/       对话运行、工具路由、引擎描述表（engines.ts）
    claude/    Claude Code 的协议、权限 Hook 与子智能体
    codex/     Codex app-server 的协议、审批与 Goal
  gateway/     上游网关控制
  orchestration/ 主智能体的编排工具、子智能体任务与汇报投递
  routes/      HTTP API
  runtime/     SSH、密钥加密、同步、remote-shell、终端
  token-usage/ Token 用量记录与价格快照
  server.ts    后端入口
frontend/src/
  components/  界面组件
  site/        站点品牌设置
frontend/demo/ 在线预览的模拟后端
client/        桌面与移动客户端（Tauri 2），独立的 npm 项目，见 client.md
deploy/        Caddy / Nginx 配置、宿主机服务、发布脚本、网关控制面
docs/          使用与运维文档
compose.yaml   Docker / Podman Compose 配置
```

## 主智能体与子智能体的实现

用户可见的行为见[与智能体对话](agents.md#主智能体与跨-cli-子智能体)，这里记录实现要点和取舍。代码在 `backend/src/orchestration/`，各 CLI 的接入在 `backend/src/agent/orchestration-tools.ts` 和各引擎目录中。

- **工具注入**：
  - **Claude Code**：使用进程内 SDK MCP 服务器。`--mcp-config` 声明 `{"type":"sdk"}` 服务器，控制协议的 `initialize` 声明 `sdkMcpServers`，MCP 消息以控制请求 `mcp_message` 往返。
  - **Codex**：在 `thread/start` 传入 `dynamicTools`（实验接口），调用以服务端请求 `item/tool/call` 到达。工具记录在线程元数据中，恢复线程时仍在，但不能给已有线程补上，所以只能在第一条消息之前开启编排。
  - **Antigravity**：使用 ACP `session/new` / `session/resume` 的 stdio `mcpServers`。服务器是 Hub 写进槽位目录的小程序 `~/.gemini/config/clinavat-mcp.py`。它连接 Hub 每次运行在 agy 旁边启动的桥接进程：后者监听 `/tmp` 下的私有 socket，经自己的标准输入输出回到 Hub，每次运行使用不同的令牌。
  - 三者都由 `answerHubMcp` / `callHubTool` 处理，工具定义由 zod 生成 JSON Schema 后共用。
- **审批集中在 Hub**：Codex 的动态工具不经过它自己的审批策略，所以编排工具一律在 `callHubTool` 中按主对话的授权模式审批。Claude 的 PreToolUse 回调和 agy 的权限请求对 `clinavat` 工具直接放行，避免重复审批。
- **任务与汇报**：主智能体发给子智能体的每条消息是一项 `agent_tasks`。子智能体空闲时（没有排队消息、后台任务，也不在切换账号），它空闲前收到的所有任务一起结束，汇报取最后一轮的最终回复，这样引导、排队和用户插话都不必对应到具体轮次。投递器把 2 秒内到达的汇报合并成一条 `source='report'` 的消息，以排队方式发给主对话；被 `wait_agents` 等待的子智能体不单独投递。Hub 重启前完成的汇报只能手动投递。
- **只读与目录限制**：Claude 由 PreToolUse 回调拒绝；agy 拒绝 edit、delete、move 类权限请求，另有 `write_file` 钩子兜底；Codex 的做法见用户文档中的说明。指定了工作目录时，Codex 的沙箱可写目录收窄为该目录和 `.bin`（`remote-shell` 在 `.bin` 中加锁），文件修改请求按路径检查。
- **worktree**：子智能体的 worktree 是主项目的派生项目（`projects.parent_project_id`）。开发机项目放在开发机的 `~/.clinavat/worktrees/`，因为主项目的同步规则在创建时固定，放进项目目录会被同步进主镜像；本机项目没有同步，放在项目内以便在 LXD 挂载白名单之内。没有修改时的清理只在子智能体的 CLI 已退出时进行；之后在同一路径重建，Claude 才能按工作目录找回原生会话。
- **讨论**：每一轮的提示由 Hub 拼装，作为不投递的任务（`notify: false`）发给参与者，再复用汇报模块的等待机制；发言保存在 `discussion_statements`，结束后整理成 `<clinavat_discussion>` 记录送给主持或主对话。圆桌的字母编号对所有人一致，以便汇总排名，排名从回复最后的 `RANKING:` 行解析。
- **Antigravity 的接入方式**：使用 `agy acp` 而不是 `-p --input-format stream-json`，因为后者没有审批通道，需要审批的工具会被软拒绝，也只接受文本输入。没有 D-Bus 会话总线时，agy 把令牌明文保存在 HOME 中，所以可以沿用槽位凭据机制。原生子智能体在 1.5.14 下实测仍无法把审批请求送到 ACP 客户端，因此继续用 Hook 禁用。

## 验证记录

项目没有自动化测试，以下是已经人工验证过的范围：

- **构建与部署**：`npm run check`、`npm run build`、生产依赖审计、Compose 配置校验通过。用 Podman 5.7.0 / podman-compose 1.5.0 以普通用户完成镜像构建和启动，容器内 Claude Code、Codex、Mutagen、OpenSSH 正常。完成宿主机 systemd 服务部署和从 Compose 迁移数据的验收。
- **开发机与同步**：在临时的本机 OpenSSH 节点上验证了密钥连接、目录浏览、Mutagen 双向同步、`remote-shell` 前后同步与退出码传递、远端 Git Diff、网页终端，以及删除项目时关闭终端并保留源码。
- **CLI 交互**：用隔离的真实 Codex CLI 和本地模拟模型服务，验证了原生读取、`apply_patch`、批准与拒绝、权限保存、YOLO 和审批取消。核对了 Claude 的 Plan 参数与 compact 命令，以及 Codex 的协作模式、提问和压缩协议。
- **网页**：在桌面和手机浏览器上验证了登录、槽位设置、对话创建 / 重命名 / 删除、文件预览、终端、`/` 与 `@` 补全、模式与角色切换、对话大纲和多选提问。
- **Antigravity 槽位**：直接调用 `startAntigravity`，在槽位虚拟机中运行真实的 agy 1.5.14，验证了审批、命令路由（包括后台命令）、最终回复、Token 用量、引导、打断、Stop Hook 结束自主执行、读取额度、跨进程恢复会话、提问，以及拒绝含工作区 Hook 的项目。
- **主智能体与子智能体**：没有用真实账号跑过完整流程，以下都是在本地模拟的模型接口上验证的。
  - 直接调用 `startClaude` 和 `startCodex`（参数与生产一致），验证了工具注入、审批、只读和目录限制。
  - 进程模式的完整 Hub 覆盖了：派生、汇报、`wait_agents`、全部停止；默认 worktree、`.worktreeinclude`、提交与合并、未修改时清理和重建、冲突的各种处理；三种讨论、网页发起与停止；名册。
  - Antigravity 主智能体先用替身 agy 验证了 Hub 一侧，再在 agy-02 的槽位虚拟机中用真实 agy 确认：工具以 `mcp_clinavat_<tool>` 的形式交给模型，调用能到达 Hub。
  - 进程模式下的端到端测试需要在独立的 PID 命名空间中运行（`unshare --user --map-current-user --pid --fork --mount-proc`），否则 Hub 无法确认宿主机上其他用户的进程是否占用槽位。
- **客户端**：Hub 列表页通过类型检查和构建，原生部分对 Android 和 macOS 目标通过 `cargo check`，但还没有在任何平台上实际运行，详见[客户端](client.md#验证情况)。

**尚未验证**：向真实上游模型发起完整对话、规划或上下文压缩流程；开发机项目（SSH 和 Mutagen 镜像）中子智能体的 worktree；Codex 只读子智能体的 `apply_patch` 被拒绝（模拟模型拿不到这个工具）；Antigravity 子智能体的目录限制；在线预览在真实浏览器中的运行。
