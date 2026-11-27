# 客户端

Clinavat 客户端把网页版工作台装进 macOS、Windows、Android 和 iOS 应用，Linux 桌面也可以构建。它基于 [Tauri 2](https://v2.tauri.app/)，自身不带工作台页面，而是打开 Hub 托管的同一份网页版前端：界面、登录和数据与浏览器访问一致，Hub 升级后客户端不需要更新。

桌面端（macOS / Windows / Linux）还内置了纯 Rust 实现的**「此电脑」本机开发机守护进程**（`client/daemon`），无需在本机开放 `sshd` 或公网端口，即可将个人电脑接入 Hub 工作台，支持本机直连执行（Mode 1）与项目镜像同步（Mode 2）。移动端（Android / iOS）仅用于查看和操作工作台，不编译也不携带守护进程。

> 状态：桌面壳、Hub 列表与本机守护进程集成（含安全指纹确认 UI 与独立 `clinavat-agent` CLI）已完成代码落地、跨平台编译检查与端到端协议联调验证；各平台安装包签名公证与真实桌面/移动设备人工联调见[验证情况](#验证情况)与[技术路线](roadmap.md)。

## 工作方式

```text
客户端窗口（Tauri 2）
 ├─ Hub 列表：随应用打包的本地页面（唯一拥有原生 IPC 权限的页面）
 │   ├─ 管理 Hub 地址、打开/切换 Hub
 │   └─ 桌面端守护进程面板：查看 Ed25519 公钥、按 Hub 启停、重连、指纹确认与一键断开
 └─ 打开 Hub 后，同一个窗口 ──HTTPS──▶ Hub 的 Web 入口（网页版前端 + /api）
                                      （远程页面零原生命令权限）

桌面端后台守护进程（client/daemon，纯 Rust，随桌面壳运行或独立运行 clinavat-agent）
 └─ 出站 WSS（优先，经 /api/client-devices/tunnel）或 TCP SSH ──▶ Hub ClientSshServer
     └─ 单条 SSH 通道承载多路复用 RPC / 流（命令、PTY、文件读写/搜索、Git/Worktree、镜像增量同步）
```

- 启动时显示 Hub 列表，选中后窗口直接导航到 Hub 地址。页面来自 Hub 本身，所以 Cookie、来源校验和内容安全策略都与浏览器访问相同。
- **远端 Hub 页面零原生权限。** 客户端命令通过 `client/src-tauri/capabilities/hub-list.json`（`local: true`）严格限定在随应用打包的本地 Hub 列表页，远端 Hub 页面即使出现 XSS 也调用不到任何 Tauri 命令。
- 窗口只会停留在 Hub 列表和当前打开的 Hub。指向其他网站的链接、普通 `target="_blank"`（含非 `?window=` 的同源链接，如「查看原图」）、`mailto:` 和 `tel:` 都交给系统浏览器或默认程序打开；仅携带白名单 `?window=preview|settings|memory` 的同源多窗口请求由桌面客户端拦截并在应用内拉起独立窗口。
- 客户端会向每个页面注入冻结只读的 `window.__CLINAVAT_CLIENT__`（`Object.freeze` + 不可写属性），约定见 `frontend/src/client.ts`：
  - **所有平台（主窗口）**：`platform`、`version`、`switchHubUrl`（用于展示「切换 Hub」入口）。
  - **仅桌面端主窗口**：额外注入多窗口能力与哨兵地址 `multiWindow: true`、`closeWindowUrl`（`https://close-window.clinavat.invalid/`）、`focusMainUrl`（`https://focus-main.clinavat.invalid/`），以及只读设备配对元数据 `deviceId`、`publicKey`、`deviceName`（主机名）、`arch`、`osVersion`、`defaultShell`、`homedir`，以支持登录工作台后一键启用「此电脑」。**隐私提示：请仅在客户端中添加并打开受信任的 Hub。**
  - **桌面端独立子窗口**：遵循最小权限原则，仅注入 `platform`、`version`、`multiWindow: true`、`closeWindowUrl`、`focusMainUrl`，**不注入 `switchHubUrl` 与本机守护进程设备配对字段**；子窗口导航钩子也禁止访问本地 Hub 列表页或触发 `switch-hub` 切走主窗口。

### 桌面端原生多窗口与无 SSE 状态同步

桌面端（macOS / Windows / Linux）支持将**文件预览**、**工作台设置**与**项目记忆**作为独立原生窗口打开，同时继续保持远端页面零 Tauri IPC 权限：

- **白名单受控建窗与去重聚焦**：前端在检测到 `window.__CLINAVAT_CLIENT__.multiWindow === true` 时，通过同源 URL 查询参数 `?window=preview|settings|memory` 拉起独立窗口；Tauri 在 `on_new_window` 中严格校验请求 URL 与当前受信任 Hub **同源**（`scheme + host + port` 完全一致）且参数合法（UTF-8 字节长度与 Unicode C0/C1 控制字符前后端一致校验），在锁内以 `in_flight` 占位原子限制最大并发子窗口数（默认 `16`），同步回调始终返回 `NewWindowResponse::Deny`，预检通过后即刻发送前置 ack 再异步通过 `WebviewWindowBuilder` 建窗或聚焦已有窗口（避免 Windows WebView2 同步建窗死锁及慢建窗误回退）；参数非法或达到上限时立即返回拒绝回执并回退页内弹窗，不跳外部浏览器。同一逻辑键（`settings`、`memory:<projectId>`、`preview:<projectId>:<path>`）会自动去重并聚焦提升已有窗口（已有 `settings` 窗通过 `BroadcastChannel` `settings-tab` 平滑切页，不整页刷新）。
- **哨兵 URL 生命周期控制**：子窗口关闭（`close-window.clinavat.invalid`，仅非 `"main"` 子窗口可用）与聚焦主窗口（`focus-main.clinavat.invalid`）均通过 `.invalid` 哨兵导航在 `on_navigation` 中拦截并异步执行，无需向远端页面暴露任何 Tauri 命令；切换 Hub、返回 Hub 列表或关闭主窗口时，客户端会先递增世代号（`hub_epoch`）再在锁外级联销毁全部子窗口，并发建窗若在切 Hub 后完成也会因世代号不匹配立即销毁，杜绝跨 Hub 串源或孤儿窗口阻塞退出。
- **无额外 SSE 连接的跨窗同步**：子窗口由 `frontend/src/main.tsx` 直接挂载 `DetachedWindowRoot`，不挂载主工作台 `App` 也不建立 `/api/events` SSE 长连接。主窗口与子窗口通过同源 `BroadcastChannel`（`clinavat-windows`）双向同步主题切换、设置/账号/归档变更、文件保存刷新、项目记忆更新、从预览窗定位主窗口文件、打开归档会话以及登出自动关闭子窗口。
- **向后兼容降级**：浏览器端、移动端以及未注入 `multiWindow` 的旧版桌面客户端会自动回退为原有的页内弹窗；即使桌面端建窗被限流或 `window.open` 失败，前端也会平滑回退为页内弹窗。

## 本机开发机（「此电脑」）

### 配对与连接流程

1. **生成本机身份**：桌面客户端启动时在本地配置目录（macOS/Linux 位于 `~/.config/clinavat/daemon/` 或平台对应配置目录，POSIX 权限为目录 `0700`、敏感文件 `0600`；Windows 位于当前用户配置目录并通过 `MoveFileExW` 原子替换写入）加载或原子生成持久化的 `device_id` 与 Ed25519 密钥对（`id_ed25519`）。
2. **在 Hub 列表页开启守护进程**：在对应 Hub 卡片中开启「此电脑守护进程」开关（持久化在本地 `daemon_hubs.json`），守护进程开始轮询 Hub 的 `/api/client-devices/bootstrap`（携带 Ed25519 签名防重放）。
3. **在 Hub 工作台一键启用**：打开 Hub 登录后，网页版通过只读 `window.__CLINAVAT_CLIENT__` 识别当前桌面客户端，展示「此电脑」卡片；用户阅读无沙箱风险提示并确认后，前端向 Hub 注册 `kind='client'` 开发机（绑定 `deviceId` 与 `publicKey`）。
4. **建立反向 SSH 隧道**：守护进程在下次引导或手动点击「重连」时获取 Hub 的隧道地址与 SSH 主机密钥指纹，优先通过 WebSocket（`wss://.../api/client-devices/tunnel`）承载 SSH2 握手与 Ed25519 公钥认证，必要时回退直连 TCP SSH（支持 IPv6 `[host]:port`），执行 `clinavat-agent-v1` 进入多路复用控制会话。

### 两种项目模式（Mode 1 / Mode 2）

CLI 与模型账号凭据始终留在 Hub 侧，不会下发到个人电脑：

| 模式 | 适用场景 | 工作方式 |
| --- | --- | --- |
| **Mode 1（直连模式 `direct`）** | 默认推荐，开箱即用 | 不在 Hub 建立完整项目镜像，Hub 侧工具/CLI 通过控制通道 RPC 直接操作本机文件、搜索、命令、PTY 终端与 Git/Worktree |
| **Mode 2（镜像同步模式 `mirrored`）** | 需要本地镜像供 Hub 侧 CLI 直接读写 | 通过控制通道内置 Layer-2 增量同步（`sync.scan` / `sync.pull_batch` / `sync.push_batch`）维护 Hub 镜像与个人电脑代码目录一致，无需在客户端额外安装 Mutagen 或 `sshd` |

### 安全边界与主机指纹校验

- **无容器沙箱隔离提示**：守护进程以当前桌面用户的系统权限在本机直接执行命令与文件操作，能够访问本机目录、`~/.ssh` 与环境变量。桌面端列表页与 Hub 启用弹窗均提供明确风险提示，**建议使用专用系统账号**，且「此电脑」项目默认禁用 YOLO / Full access 自动放行。
- **远端页面零命令权限**：开启/关闭守护进程、重连、确认主机指纹与一键断开全部只能在随应用打包的本地 Hub 列表页完成，Hub 网页无法调用任何原生控制命令。
- **主机密钥指纹校验策略**：
  - **`https://`（`wss://`）与回环 `http://`（`127.0.0.1`、`::1`、`localhost`）**：保留首次信任（TOFU），将 Hub SSH 主机密钥 SHA-256 指纹固定写入本地 `trusted_hubs.json`（macOS/Linux 使用 `0600` 权限原子替换，Windows 位于当前用户配置目录并通过 `MoveFileExW` 原子替换写入）。
  - **非回环 `http://` 首次连接**：因缺少 HTTPS 证书校验，守护进程不会自动信任，而是拦截挂起并进入 `awaiting_fingerprint` 状态，桌面端弹出指纹确认框展示 Hub 地址与 SHA-256 指纹，用户人工核实确认后才会固定并继续连接，拒绝则立即断开。
  - **任何已信任 Hub 指纹变更**：无论协议类型，一旦引导结果与 `trusted_hubs.json` 记录不一致，立即阻断连接并弹出高危警告，同时展示原指纹与新指纹，禁止静默覆盖；若 SSH 握手阶段实际出示的主机密钥指纹与刚从引导接口声明的指纹不一致，则直接进入 `error` 连接异常状态并按退避策略处理，绝不弹出确认框诱导写入信任库。
- **一键断开**：桌面端 Hub 列表页支持按单个 Hub 一键断开或「一键断开全部」，立即终止 SSH 会话与后台重连；编辑或删除 Hub 时自动清理不再被任何条目引用的孤儿守护进程与配置；同时 Hub 侧也支持在开发机卡片中随时断开或移除设备吊销公钥。
- **文件与路径防护**：macOS/Linux 启动读取私钥及配置文件（`id_ed25519`、`device_id`、`trusted_hubs.json`、`daemon_hubs.json`）时校验非软链、属主为当前 `euid` 并自动将宽权限收敛为 `0600`（目录 `0700`）；Windows 下存储于当前用户配置目录并使用 `MoveFileExW` 原子替换写入；首次建钥使用不可覆盖原子发布避免并发竞态；所有工作区文件/Git/Worktree 清理操作均经过路径包含与符号链接校验。

## 独立守护进程 CLI（`clinavat-agent`）

无需启动 Tauri 图形界面时（例如无头 Linux、WSL2 或后台常驻服务），可直接构建并运行 `client/daemon` 提供的 `clinavat-agent` 命令行程序：

```bash
cargo build --manifest-path client/daemon/Cargo.toml --release

# 1. 查看或初始化本机 deviceId 与 Ed25519 公钥
clinavat-agent identity [--state-dir <dir>]

# 2. 查看本机身份、已信任 Hub 列表，并可选探测指定 Hub 的注册与指纹状态
clinavat-agent status [--state-dir <dir>] [--hub <url>]

# 3. 连接指定 Hub 并运行守护进程（标准输出打印结构化 JSON 事件）
clinavat-agent connect --hub <url> \
  [--state-dir <dir>] \
  [--transport auto|ws|tcp] \
  [--heartbeat-secs <n>] \
  [--expect-fingerprint <SHA256:...>] \
  [--stop-on-mismatch]
```

说明：连接非回环 `http://` Hub 时，可在核对指纹后通过 `--expect-fingerprint SHA256:...` 显式放行，或在桌面客户端 UI 中完成一次信任确认。

## Hub 地址

### 打包时的默认 Hub

客户端源码中不写任何 Hub 地址，默认地址在构建时从环境变量读取：

| 变量 | 说明 |
| --- | --- |
| `CLINAVAT_CLIENT_HUB_URL` | 默认 Hub 地址，例如 `https://clinavat.example.com`。可以带基础路径，不能包含账号、查询参数或片段；格式无效时构建直接失败 |
| `CLINAVAT_CLIENT_HUB_NAME` | 列表中显示的名称，默认取主机名 |

变量可以参照 `client/.env.example` 写在 `client/.env.local`（已被 Git 忽略），也可以在命令前设置：

```bash
CLINAVAT_CLIENT_HUB_URL=https://clinavat.example.com CLINAVAT_CLIENT_HUB_NAME=团队 Hub npm run tauri build
```

- 首次启动时，默认 Hub 会加入列表并直接打开。没有设置默认 Hub 时，首次启动显示「添加 Hub」。
- 用户删掉默认 Hub 后，它不会再被加回。新版本更换默认地址时，新地址会追加到列表中，已有条目保留。

### 切换与修改

用户可以在 Hub 列表中添加、编辑和删除 Hub，并选择是否「启动时自动打开上次使用的 Hub」。回到 Hub 列表的方式：

| 位置 | 方式 |
| --- | --- |
| 桌面菜单 | 「Hub → 切换 Hub…」，页面打不开时也能用。同一菜单的「重新加载」与缩放项（放大/缩小/实际大小）会作用于当前聚焦窗口（macOS 支持 ⌘R / ⌘= / ⌘- / ⌘0） |
| 网页版 | 登录页底部、侧栏用户信息旁的切换按钮，以及“无法连接服务”页面 |
| Android | 系统返回键 |
| 启动时 | 正在自动打开 Hub 时显示「取消」 |

### 地址规则

- 填写在浏览器中访问 Hub 的最终地址，省略协议时按 HTTPS 处理。打开后又跳转到其他域名的地址无法使用。
- 公网 Hub 必须使用 HTTPS。HTTP 只接受本机和内网地址，包括回环地址、私有网段、链路本地地址、`100.64.0.0/10`（Tailscale 等组网工具使用）、IPv6 ULA，以及 `localhost`、`*.local`、`*.home.arpa` 和不带点的主机名。
- 客户端使用的地址必须已加入 Hub 的公开访问地址（「管理面板 → 网关和访问 → 访问配置」，见[部署文档](deployment.md#公开访问与反向代理)），否则登录会因来源校验失败。

## 构建

需要 Node.js 22.13+，以及 [Tauri 列出的系统依赖](https://v2.tauri.app/start/prerequisites/)：Rust 工具链，再加上各平台各自需要的工具。客户端是独立的 npm 项目，不在根目录的 workspaces 中，不影响 Hub 的部署和 Docker 镜像。

```bash
cd client
npm ci
npm run tauri dev      # 桌面开发，Hub 列表页支持热更新
npm run tauri build    # 打包当前平台的安装包
```

| 平台 | 构建环境 | 命令 | 产物 |
| --- | --- | --- | --- |
| macOS | macOS + Xcode 命令行工具 | `npm run tauri build` | `.app`、`.dmg` |
| Windows | Windows + MSVC 生成工具（系统自带 WebView2） | `npm run tauri build` | `.msi`、`.exe` |
| Linux | WebKitGTK 4.1 等开发包 | `npm run tauri build` | `.deb`、`.rpm`、AppImage |
| Android | Android SDK、NDK 和 JDK 17 | 先 `node client/prepare-mobile.mjs android`，再 `npm run tauri android build` | APK、AAB |
| iOS | macOS + Xcode + `xcodegen` | 先 `node client/prepare-mobile.mjs ios`，再 `npm run tauri ios build` | IPA |

桌面安装包位于 `client/src-tauri/target/release/bundle/`，移动端工程生成在 `client/src-tauri/gen/`。

### 应用标识与签名

`client/src-tauri/tauri.conf.json` 中的 `identifier` 为 `app.clinavat.client`。正式分发前，请换成你所控制的反向域名，并配置签名：macOS 需要签名和公证，Windows 需要代码签名，Android 需要 keystore，iOS 需要证书和描述文件。如果不想改仓库里的文件，可以在构建时覆盖：

```bash
npm run tauri build -- --config '{"identifier":"com.example.clinavat"}'
```

在准备移动端工程或通过 GitHub Actions 构建时，也可以设置环境变量 / 仓库变量 `CLINAVAT_CLIENT_IDENTIFIER` 自动注入上述覆盖。

### 首次生成移动端工程

`tauri android init` 和 `tauri ios init` 会在 `client/src-tauri/gen/android` 与 `client/src-tauri/gen/apple` 生成原生工程目录。本仓库已通过 `client/src-tauri/.gitignore` 忽略这两个目录（不提交进 Git 仓库），而是提供纯 Node ESM 幂等准备脚本 `client/prepare-mobile.mjs`（也可在 `client/` 目录执行 `npm run prepare:android` / `npm run prepare:ios`），由本地构建与 CI 按需生成并自动补丁，避免原生工程漂移：

```bash
# 准备 Android 工程（默认禁止 release 明文 HTTP；如需内网 HTTP 可设 CLINAVAT_ANDROID_CLEARTEXT=true）
node client/prepare-mobile.mjs android

# 准备 iOS 工程（仅 macOS + Xcode）
node client/prepare-mobile.mjs ios
```

脚本按需执行 `npx tauri android init --ci` / `npx tauri ios init --ci`（支持读取 `CLINAVAT_CLIENT_IDENTIFIER`），并对 Android 工程幂等完成两项必要调整：

1. **系统栏、刘海与软键盘安全区。** 动态定位生成包名下的 `MainActivity.kt`，在 `onCreate` 中幂等注入 `ViewCompat.setOnApplyWindowInsetsListener` + `WindowInsetsCompat.Type.systemBars() or displayCutout() or ime()` 内边距适配，避免网页延伸到状态栏或被软键盘遮挡（若找不到预期锚点则直接非零退出报错）。
2. **内网 HTTP 明文开关。** 根据 `CLINAVAT_ANDROID_CLEARTEXT`（仅当值为 `"true"` 时启用，默认为 `"false"`）更新 `gen/android/app/build.gradle.kts` 中的 `manifestPlaceholders["usesCleartextTraffic"]`。公网 Hub 请始终使用 HTTPS。

iOS 工程不需要额外补丁。构建时会自动合并 `src-tauri/Info.plist` 和 `Info.ios.plist`，前者提供局域网访问说明，后者让下载的文件出现在「文件」App 中。

### GitHub Actions 自动构建与发布

仓库包含两条客户端工作流：

- **`.github/workflows/client-ci.yml`（PR 与 `main` 校验）**：仅在 `client/**` 或 `.github/workflows/client-*.yml` 变更时触发，在 `ubuntu-22.04` 上校验 Hub 列表页构建、`client/prepare-mobile.mjs` 语法、`client/src-tauri` 与 `client/daemon` 的 `cargo check --locked`，以及 `aarch64-linux-android` 目标的 `#[cfg]` 移动端隔离。
- **`.github/workflows/client-release.yml`（全平台打包与发布）**：支持推送 `client-v*` Tag 自动发布，也支持在 Actions 页面通过 `workflow_dispatch` 按需勾选平台（`build_desktop`、`build_android`、`build_ios`）、覆盖默认 Hub（`hub_url`、`hub_name`）、开启 `android_cleartext` 以及选择是否 `create_release`。

#### 版本一致性与变量配置

- 推送 `client-v<version>` Tag 时，`prepare` Job 会强制校验 Tag 版本号与 `client/package.json`、`client/src-tauri/Cargo.toml`、`client/daemon/Cargo.toml` 三处完全一致，否则立即失败。`workflow_dispatch` 则生成 `<version>-<short-sha>` 构建标识。
- 仓库级 Variables（Settings → Secrets and variables → Actions → Variables，均为可选）：
  - `CLINAVAT_CLIENT_HUB_URL`、`CLINAVAT_CLIENT_HUB_NAME`：打包进客户端的默认 Hub 地址与显示名称（`workflow_dispatch` 输入优先级更高；非空时会校验 URL 合法性）。
  - `CLINAVAT_CLIENT_IDENTIFIER`：覆盖打包用的反向域名 `identifier`。
  - `CLINAVAT_ANDROID_CLEARTEXT`：Tag 发布时是否允许 Android release 明文 HTTP（默认 `false`）。
  - `APPLE_IOS_EXPORT_METHOD`：iOS 正式签名通过 `tauri ios build --export-method` 导出的方式，合法枚举为 `release-testing`（默认，对应 Xcode 15.4+ 之前的 `ad-hoc`）、`app-store-connect`（原 `app-store`）、`debugging`（原 `development`）；工作流也会自动将旧称 `ad-hoc`/`app-store`/`development` 映射到对应新枚举。

#### 零证书默认构建与正式签名 Secrets

所有平台在**不配置任何签名 Secret 时均可直接完成构建并产出可用包**；配置对应 Secrets 后会自动升级为正式签名/公证流程。最终 `release` Job 会汇总所有产物并生成 `SHA256SUMS.txt`：

| 平台 | 未配置 Secrets（默认可用） | 配置 Secrets（自动升级正式签名） | 产物说明 |
| --- | --- | --- | --- |
| **macOS**（arm64 / x64） | 使用 `APPLE_SIGNING_IDENTITY="-"` 执行 ad-hoc 签名（保证 Apple Silicon 可打开，首次启动需在隐私与安全中放行） | `APPLE_CERTIFICATE`（Base64 `.p12`）、`APPLE_CERTIFICATE_PASSWORD`、可选 `APPLE_SIGNING_IDENTITY`；公证支持 `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` 或 `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_BASE64` | `.dmg` + `clinavat-agent_*.tar.gz` |
| **Windows**（x64） | 构建未签名安装包 | GitHub 托管 Runner 需配置 `WINDOWS_CERTIFICATE_BASE64`（Base64 `.pfx`）+ `WINDOWS_CERTIFICATE_PASSWORD`；仅配置 `WINDOWS_CERTIFICATE_THUMBPRINT` 仅适用于证书已预装在系统证书库（`Cert:\CurrentUser\My`）中的自托管 Runner；可选 `WINDOWS_TIMESTAMP_URL` | `.msi`、`-setup.exe` + `clinavat-agent_*.zip` |
| **Linux**（x64） | 直接构建 `.deb` 与 `.AppImage` | — | `.deb`、`.AppImage` + `clinavat-agent_*.tar.gz` |
| **Android**（universal） | 使用 `keytool` 生成临时密钥库，经 `zipalign` + `apksigner` 签名产出真机可直接安装的 `*_selfsigned.apk` | `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、可选 `ANDROID_KEY_PASSWORD` | 正式签名产出 `.apk` + `.aab`；零证书产出 `*_selfsigned.apk` |
| **iOS**（arm64） | 预先以 `--features tauri/custom-protocol` 编译 `aarch64-apple-ios` 静态库至 `gen/apple/Externals/arm64/<config>/libapp.a`，从 `project.yml` 裁剪 `"Build Rust Code"` 预构建脚本后重新 `xcodegen generate` 并合并 `Info.plist`/`Info.ios.plist`，以 `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" DEVELOPMENT_TEAM=""` 执行 `xcodebuild archive`，将归档 `.app` 封装进 `Payload/Clinavat.app` 生成 `*_ios_arm64_unsigned.ipa`（供 AltStore / SideStore / Sideloadly 等自签工具安装） | `APPLE_IOS_CERTIFICATE`（Base64 `.p12`）、`APPLE_IOS_CERTIFICATE_PASSWORD`、`APPLE_IOS_PROVISIONING_PROFILE`（Base64 `.mobileprovision`）、可选 `APPLE_TEAM_ID`（映射至 Tauri 原生 `IOS_CERTIFICATE` / `IOS_CERTIFICATE_PASSWORD` / `IOS_MOBILE_PROVISION` / `APPLE_DEVELOPMENT_TEAM`，直接由 `tauri ios build --ci --export-method ...` 完成签名、归档与导出） | 正式签名导出 `.ipa`；零证书产出 `*_unsigned.ipa` |

## 平台差异

| 能力 | macOS | Windows | Linux | Android | iOS |
| --- | --- | --- | --- | --- | --- |
| 网页引擎 | WKWebView | WebView2 | WebKitGTK | Android WebView | WKWebView |
| 原生多窗口（预览/设置/记忆） | 支持 | 支持 | 支持 | 页内弹窗 | 页内弹窗 |
| 本机开发机守护进程 | 支持 | 支持 | 支持 | 不包含（目标隔离） | 不包含（目标隔离） |
| 下载文件 | 保存到「下载」并在访达中显示 | 保存到「下载」并在资源管理器中显示 | 保存到「下载」并在文件管理器中显示 | 不支持 | 保存到「文件」App 的 Clinavat 目录 |
| 回到 Hub 列表 | 菜单、网页入口 | 菜单、网页入口 | 菜单、网页入口 | 返回键、网页入口 | 网页入口 |

- 网页版用到了 `color-mix()` 等较新的 CSS，要求 WebKit 16.2 或更高版本。因此 iOS 最低 16.4，macOS 最低 12 且需要把 Safari 更新到 16.2 以上。Windows 的 WebView2 和 Android WebView 会随系统自动更新。
- Android WebView 不支持下载文件，需要下载时请用浏览器访问 Hub。
- iOS 的 WKWebView 会忽略 `target="_blank"`，客户端会把这类链接的点击改为普通导航，再交给系统浏览器打开。
- 只包装网页的应用可能被 App Store 以“功能过少”为由拒绝上架。团队内部分发可以使用 TestFlight、企业签名，或者直接分发安装包。

## 代码结构

```text
client/
  src/                        Hub 列表页（React），复用网页版的样式变量和基础控件
    App.tsx                   列表页主控、守护进程轮询与指纹确认弹窗编排
    HubList.tsx               Hub 列表与每个 Hub 的守护进程开关/状态/重连/一键断开
    DaemonPanel.tsx           桌面端本机设备信息、Ed25519 公钥复制、风险提示与一键全断
    FingerprintDialog.tsx     非回环 HTTP 首次连接与主机指纹变更确认弹窗
    HubForm.tsx / hubs.ts     Hub 添加/编辑表单与本地存储
    native.ts                 Tauri invoke 封装（仅本地 Hub 列表页可调用）
  src-tauri/
    Cargo.toml                桌面目标按 cfg 引入 clinavat-daemon，移动端零依赖
    capabilities/hub-list.json 仅向本地 Hub 列表页授予导航与守护进程控制命令
    src/daemon_bridge.rs      桌面守护进程多 Hub 生命周期管理、孤儿清理与 Tauri 命令（移动端为空桩）
    src/daemon_store.rs       桌面端 daemon_hubs.json 安全读取、URL 校验与原子持久化
    src/hub.rs                Hub 地址规则、当前 Hub，以及打开和关闭 Hub 的命令
    src/navigation.rs         导航策略、外部链接、哨兵拦截与注入冻结只读 window.__CLINAVAT_CLIENT__
    src/windows.rs            桌面端原生多窗口白名单校验、按键去重聚焦、聚焦窗口缩放与级联销毁
    src/downloads.rs          按窗口隔离的下载位置与系统文件管理器定位
    src/menu.rs               桌面菜单（切换 Hub、聚焦窗口重新加载与缩放）
  daemon/                     纯 Rust 本机开发机守护进程库与独立 CLI（clinavat-agent）
    src/lib.rs                DaemonSupervisor 运行循环、指纹确认/拒绝控制与重连退避
    src/state.rs              DaemonConfig、DaemonState（含 awaiting_fingerprint / error）与事件类型
    src/identity.rs           持久化 device_id / Ed25519 密钥与主机元数据采集
    src/private_io.rs         macOS/Linux 0700/0600 权限收敛、非覆盖建钥与 Windows MoveFileExW 原子写
    src/bootstrap.rs          签名引导客户端、TrustStore 与 HTTPS/精确回环 TOFU 策略
    src/transport.rs          WSS/TCP SSH2 传输（支持 IPv6）、主机指纹校验与会话管理
    src/framing.rs            Layer-1/Layer-2 多路复用帧编解码
    src/router.rs             RPC / 流式请求路由与取消传播
    src/path_guard.rs         跨平台路径规范化、边界 containment 与软链/重解析点防护
    src/ops/                  fs、search、patch、git/worktree、exec/pty 与增量 mirror sync 实现
  vite.config.ts              读取 CLINAVAT_CLIENT_HUB_URL 和 CLINAVAT_CLIENT_HUB_NAME
```

## 验证情况

在 Linux 开发环境中已完成跨平台目标编译检查与临时联调验证：

- `client/` Hub 列表页（含 `DaemonPanel`、`FingerprintDialog` 与桌面守护进程控制）通过 `tsc -b` 与 Vite 生产构建，无报错与警告。
- 仓库根目录 `npm run check` 与 `npm run build`（Hub 前后端类型检查与构建）通过。
- `client/daemon` 通过本机 `cargo build` 以及 macOS（`aarch64-apple-darwin`）、Windows（`x86_64-pc-windows-msvc`）交叉 `cargo check`，零警告。
- `client/src-tauri` 通过 macOS（`aarch64-apple-darwin`）与 Android（`aarch64-linux-android`，验证移动端不引入守护进程依赖）交叉 `cargo check`，零警告。
- 通过临时外部联调脚本连接真实 Hub 后端组件与原生编译的 `clinavat-daemon`，完成了 WSS/TCP（含 IPv6 `[::1]`）隧道、`heartbeat`、Mode 1（22 个 RPC/流方法）与 Mode 2（镜像双向同步与 `exec-barrier`）全链路联调，以及安全边界联调（私钥权限收敛与并发建钥、精确回环 TOFU 边界、非回环 HTTP 确认与指纹变更阻断、SSH 握手指纹不一致直入 `error` 状态、重复后台 `taskId` 预检拦截不执行进程、`git.status` UTF-8 安全截断与 `worktrees` 清理边界）。

尚未验证的内容：

- 在真实 macOS、Windows、Linux 桌面及 Android / iOS 物理设备上完成安装包构建、签名公证与端到端人工联调。
- 各平台 WebView 导航拦截对登录页 iframe、文件下载、外部链接、剪贴板复制、拖拽上传与 `SameSite=Strict` Cookie 的实际表现。
- Windows 原生环境下的杀毒软件误报排查、文件占用同步降级体验与 ConPTY 复杂终端交互。
