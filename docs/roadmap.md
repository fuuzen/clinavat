# 技术路线

本文记录方向已经确定、但尚未完全收尾的阶段与后续规划。已经落地的能力已同步至对应使用文档（如[客户端](client.md)）。

## 跨平台客户端与本机开发机（代码已落地，待多端实机联调与发布签名）

### 已落地能力

桌面客户端与「此电脑」本机开发机核心链路已完成前后端与纯 Rust 守护进程闭环，细节见[客户端](client.md)：

- **跨平台 Tauri 2 客户端**：支持 macOS、Windows、Linux、Android 和 iOS 壳工程，打包时注入默认 Hub，支持多 Hub 切换；远端 Hub 页面零原生 IPC 权限。
- **开发机类型与统一工作区抽象**：Hub 侧已落地 `kind='client'` 开发机类型、设备注册/吊销/心跳在线状态管理（`ClientHostRegistry`、`ClientSshServer`）与统一执行/文件/终端/Git 适配层（`ClientWorkspaceAdapter`）。
- **纯 Rust 本机开发机守护进程（`client/daemon`）**：
  - 所有连接均由客户端主动出站发起，优先经 `wss://.../api/client-devices/tunnel`（支持回退 TCP SSH 与 IPv6），不要求个人电脑开放 `sshd` 或公网端口，CLI 与账号凭据始终留在 Hub 侧。
  - 支持 **Mode 1（直连执行 `direct`）** 与 **Mode 2（内置 Layer-2 增量镜像同步 `mirrored`）**，无需在个人电脑安装 Mutagen。
  - 已实现跨平台文件浏览/读写/编辑/补丁应用、全局搜索（glob/grep）、命令执行与进程树/后台任务隔离、ConPTY/Unix PTY 终端、Git 状态与 Worktree 管理。
  - 已适配 **Claude Code**、**Codex** 与 **Antigravity** 三类官方 CLI 接入本机开发机。
- **桌面端 Tauri 集成与安全控制**：
  - 桌面目标通过目标条件依赖集成 `clinavat-daemon`（Android/iOS 移动端完全隔离，不引入守护进程）。
  - 向页面注入冻结只读的 `window.__CLINAVAT_CLIENT__` 设备配对元数据，本地 Hub 列表页提供设备公钥展示、无沙箱风险提示、按 Hub 启停/重连/一键断开以及非回环 HTTP 首次连接与主机指纹变更的显式确认弹窗。
  - 提供独立无头 CLI `clinavat-agent`（`identity` / `status` / `connect`）。

### 尚未完成项

- **各端安装包正式签名与公证**：GitHub Actions 跨平台自动构建与发布流水线（支持零证书默认构建）已落地，后续补齐 macOS 签名与公证、Windows 代码签名（以及杀毒软件白名单测试）、Android 正式 keystore 签名、iOS 证书/TestFlight 签名 Secrets 配置。
- **真实多端实机联调**：在 macOS、Windows、Linux 桌面及 Android / iOS 真机上验证 WebView 导航、下载、剪贴板、拖拽上传、`SameSite=Strict` Cookie、Windows ConPTY 与路径/文件占用边界场景。
- **独立 CLI 交互对话界面**：`clinavat-agent` 目前提供身份管理、状态探测与守护进程连接；直接在终端内进行交互式对话的 CLI 界面留待后续阶段。
- **离线延迟清理与同步分级**：删除离线客户端项目时的后台延迟清理队列，以及 Windows 文件占用下的更细粒度同步降级提示。

## 其他计划

- [虚拟机隔离](vm-isolation.md#尚未完成)：按用户配置出站规则、按需启停虚拟机，以及「令牌只留在宿主机」的进阶路线。
- [槽位自动切换](slot-failover-verification.md)：真实撞限和跨账号恢复的验证。
