# 开发指南

技术栈：React + Vite 前端，Fastify + TypeScript 后端，SQLite 存储。代码规范见 [AGENTS.md](../AGENTS.md)。按项目约定，不编写单元 / 集成测试。

## 本地开发

先安装[部署文档](deployment.md#环境要求)中列出的系统工具和官方 CLI（只做构建和类型检查时不需要）。

```bash
cp .env.example .env
openssl rand -hex 32        # 填入 .env 的 CLINAVAT_MASTER_KEY
npm ci
npm run dev                 # 同时启动后端和前端
```

打开 `http://localhost:5173`，创建管理员（密码至少 12 位）。前端开发服务器把 `/api` 代理到 `VITE_API_PROXY_TARGET`（默认 `http://127.0.0.1:3001`）。

```bash
npm run check   # 前后端类型检查
npm run build   # 构建 backend/dist 和 frontend/dist
npm start       # 只启动后端；生产环境的前端由 Web 入口托管
```

数据库默认位于项目根目录的 `data/clinavat.sqlite`，可用 `CLINAVAT_DATA_DIR` 修改。构建和类型检查不需要官方账号或开发机。

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
  agent/       官方 CLI 协议、工具路由、权限 Hook
  gateway/     上游网关控制
  routes/      HTTP API
  runtime/     SSH、密钥加密、同步、remote-shell、终端
  server.ts    后端入口
frontend/src/
  components/  界面组件
  site/        站点品牌设置
frontend/demo/ 在线预览的模拟后端
deploy/        Caddy / Nginx 配置、宿主机服务、发布脚本、网关控制面
docs/          使用与运维文档
compose.yaml   Docker / Podman Compose 配置
```

## 验证记录

项目没有自动化测试，以下是已经人工验证过的范围：

- **构建与部署**：`npm run check`、`npm run build`、生产依赖审计、Compose 配置校验通过。用 Podman 5.7.0 / podman-compose 1.5.0 以普通用户完成镜像构建和启动，容器内 Claude Code、Codex、Mutagen、OpenSSH 正常。完成宿主机 systemd 服务部署和从 Compose 迁移数据的验收。
- **开发机与同步**：在临时的本机 OpenSSH 节点上验证了密钥连接、目录浏览、Mutagen 双向同步、`remote-shell` 前后同步与退出码传递、远端 Git Diff、网页终端，以及删除项目时关闭终端并保留源码。
- **CLI 交互**：用隔离的真实 Codex CLI 和本地模拟模型服务，验证了原生读取、`apply_patch`、批准与拒绝、权限保存、YOLO 和审批取消。核对了 Claude 的 Plan 参数与 compact 命令，以及 Codex 的协作模式、提问和压缩协议。
- **网页**：在桌面和手机浏览器上验证了登录、槽位设置、对话创建 / 重命名 / 删除、文件预览、终端、`/` 与 `@` 补全、模式与角色切换、对话大纲和多选提问。

**尚未验证**：向真实上游模型发起完整对话、规划或上下文压缩流程；在线预览在真实浏览器中的运行。
