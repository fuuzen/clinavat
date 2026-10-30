# 从 CC-Pool 升级

Clinavat 原名 CC-Pool。升级时**沿用原有 `.env`、主密钥和数据目录**，不要用 `.env.example` 覆盖。升级前停止 Hub，完整备份数据目录，并预留足够的磁盘空间（迁移时会复制原生会话数据）。

## 兼容规则

| 项目 | 新名称 | 兼容旧名称 |
| --- | --- | --- |
| 环境变量 | `CLINAVAT_*` | 缺少新变量时读取同名 `CC_POOL_*` |
| 数据库 | `clinavat.sqlite` | 已有 `cc-pool.sqlite` 时继续使用；两个不同的数据库同时存在时拒绝启动 |
| 登录 Cookie | `clinavat_session` | 登录后自动换成新名称，保留原会话和到期时间 |
| 浏览器存储 | `clinavat-*` | 外观、工作区选择和输入草稿按需迁移，新键优先 |
| 同步排除文件 | `.clinavatignore` | 兼容读取旧文件，见[同步排除规则](projects.md#同步排除规则) |
| systemd 服务 | `clinavat-hub` / `clinavat-web` | 安装成功后停用旧服务 |
| Caddy 配置 | `deploy/clinavat.Caddyfile` | 旧的 `deploy/Caddyfile` 只用于回退到旧服务 |

品牌更名不会移动已有的工作区、槽位目录和原生会话，其中记录的绝对路径保持不变。站点品牌改为保存在服务端（「管理面板 → 站点个性化」），不再保存浏览器中的品牌预览草稿。

## 宿主机部署

先用新构建替换现有服务，再切换服务名称：

```bash
npm run check
node node_modules/typescript/bin/tsc -p backend/tsconfig.json --outDir .releases/clinavat-staging/backend
npm exec -w frontend -- vite build --outDir ../.releases/clinavat-staging/frontend --emptyOutDir
node --no-warnings deploy/release.mjs status
node --no-warnings deploy/release.mjs publish .releases/clinavat-staging
npm run host:install
```

发布和服务安装都会等待系统空闲（没有运行中、待审批或已暂停的任务），切换失败时恢复原服务。完成后可以把 `.env` 中的变量名改为 `CLINAVAT_*`，**值保持不变**，尤其是密钥和数据目录。

### 只改数据库文件名（可选）

1. 结束全部任务，停止新旧服务。
2. 执行 `node --no-warnings deploy/migrate-database.mjs`。
3. 启动当前服务。

脚本会确认服务已停止、数据库未被占用，完成 WAL checkpoint 和备份后才改名，不会覆盖已有的新数据库。它只改文件名，不移动项目和账号目录。

## Docker / Podman Compose 部署

保留原 `.env`，使用兼容配置升级，避免新项目名创建一组空数据卷：

```bash
docker compose --env-file .env -f deploy/compose.legacy.yaml up -d --build
```

兼容配置沿用旧项目名，以及容器内的 `/srv/pool`、`/var/tmp/cc-pool-workspace` 路径。数据卷必须已经存在，默认是 `cc-pool_pool-data` 和 `cc-pool_pool-workspaces`；名称不同时设置 `CLINAVAT_LEGACY_DATA_VOLUME` / `CLINAVAT_LEGACY_WORKSPACE_VOLUME`。

新安装使用根目录的 `compose.yaml`。**两套配置不要同时启动到同一份数据上。**

## 启动时的自动迁移

以下迁移在新版 Hub 首次启动时自动进行。迁移期间启动会变慢，请不要同时修改开发机和镜像中的文件，也不要运行旧版 Hub 或在槽位目录中手动启动 CLI。

### 项目镜像目录

- 新安装的镜像位于 `/var/tmp/clinavat-workspace`。未配置 `CLINAVAT_WORKSPACE_DIR` 且存在旧的 `/var/tmp/cc-pool-workspace` 时，继续使用旧目录，保留项目、Mutagen 和原生会话中的绝对路径。
- 更早版本放在 `data/workspaces/proj_<id>` 的镜像会被迁出：先备份数据库、完成同步并结束旧同步会话，再在同一文件系统内重命名目录。
- 迁移记录和旧原生会话的引用保存在 `data/workspace-migrations/`。网页中的聊天记录保留，下一轮对话会在新目录启动新的原生会话，并带入最近的对话内容。
- 跨文件系统或同步失败时保留原目录并记录错误，不会盲目复制或丢弃未同步的修改。

### 槽位结构

旧版槽位可以同时登录两种 CLI，新版每个槽位只对应一种。首次启动时：

1. 分离旧槽位的 HOME 目录，回收旧版凭据；
2. 把双引擎槽位拆成两个槽位，保留原用户的使用权限、对话关联和受限状态；
3. 没有绑定用户的旧槽位只提取账号凭据，无法确定归属的历史保留在归档中。

| 内容 | 位置 |
| --- | --- |
| 原槽位归档 | `backups/account-homes-v1/` |
| 拆分前的数据库备份 | `backups/single-engine-slots-v1/` |
| 拆分计划 | `accounts/single-engine-slots.json` |

旧的用户目录和按对话保存的运行目录，会在该用户首次使用对应 CLI 时迁入统一的会话存储。迁移失败时保留原始数据和日志，**不要手动删除日志**。

启动前会检查残留进程：如果上次 Hub 异常退出后 CLI 仍在运行，启动会报告 PID 并拒绝迁移，结束对应进程后再重启。

### 旧版凭据冲突

升级时仍会处理旧版 `accounts/leases-v2/` 中的凭据日志。有未解决的冲突时，Hub 拒绝启动。处理步骤：

1. 停止 Hub 及相关 CLI 和工具子进程。
2. 备份槽位目录、相关对话或查询的运行目录，以及这些日志。
3. 在槽位目录中重新完成官方登录。
4. 按引擎清除旧运行目录中的账号字段（保留 Claude MCP 等用户配置）。
5. 确认新登录的槽位授权是唯一有效的凭据后，归档已处理的日志，重新启动。

不要把有冲突的刷新令牌复制回槽位，也不要不经检查就删除日志。

## 迁移未完成的 Claude 任务（高级）

经明确授权时，可以让升级后的 Hub 接续一个升级前未完成的 Claude 任务：

1. 挂起原 CLI，备份原生 JSONL 记录和平台数据库。
2. 等远端工具执行结束后，向原 CLI 发送 SIGTERM，让它记录中断状态。
3. 升级前写入 `data/agent-runtime/session-recovery.json`（权限 `0600`）：

   ```json
   { "version": 1, "sessions": [{ "sessionId": "网页会话 UUID", "userId": "用户 UUID", "nativeSessionId": "原生 UUID", "slotId": "槽位 ID", "userMessageId": "原用户消息 UUID" }] }
   ```

新 Hub 在发布锁解除后读取一次该文件，校验归属、槽位和项目，再用 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` 和 `--resume` 接续，不发送新的用户消息（CLI 可能自行加入续跑指令），新的执行过程挂在原用户消息下。失败时文件改名为 `.claimed.json` 并记录错误，不会反复重试。旧进程和正在执行的命令不会保留。此流程已在 Claude Code 2.1.310 上验证。
