# 网关控制面

> 新部署把网关放在本机虚拟机中，用 `deploy/lxd/gateway-vm.sh` 安装，见[虚拟机隔离](../../docs/vm-isolation.md#网关虚拟机)。下面的 `install.sh` 用于独立主机。

网关（`10.10.10.1`，Linux + sing-box）由 `gwctl.py` 统一管理代理节点、分流规则、开发机直连名单、DNAT 端口映射、Nginx 站点和 acme.sh 证书。期望状态保存在 `/etc/clinavat-gw/state.json`，`/etc/sing-box/config.json`、`/etc/clinavat-gw/rendered/guard.nft` 和 `/etc/nginx/sites-available/clinavat.conf` 均由其渲染，不再手工编辑。接口、号池机地址、内网段、DNS 上游与 sing-box 控制接口密钥等基础设施保存在 `/etc/clinavat-gw/infra.json`，只能在网关上修改。

## 防泄漏护栏

nft 表 `inet clinavat_guard` 负责 DNAT 和地址转换。号池网段（`eth1`）转发到 `eth0` 时，仅放行 `lan_direct`（内网段）、`dev_direct`（开发机公网地址）和 DNAT 入站回包，其余流量只能经 `tun0` 出站。sing-box 停止或崩溃时号池机断网而不会以真实 IP 出站。`gateway-rules.service` 在 sing-box 之前加载护栏；渲染文件缺失、加载失败或停止该服务时载入只放行内网段的兜底规则。

sing-box 默认出站、DNS 出站固定为节点选择器 `proxy`；`direct` 只用于直连名单，任何请求都不能把规则、默认出站或节点 `detour` 指向直连，也不能新增入站。开发机 SSH 通过直连名单绕过 tun，其他 SSH 目标（如 GitHub）经代理。

## 按来源绑定出口

`source_policy` 为 `shared`（默认）时，所有来源经共享选择器 `proxy` 出站。改为 `bound` 后，号池机和 `infra.json` 中 `vm_subnet` 的每个地址各有一个选择器 `src-<地址>`，按 `state.json` 的 `bindings` 指向节点。未绑定的地址指向只能连到网关回环地址的死路出口 `unbound`，路由和 DNS 末尾再拒绝号池网段与虚拟机网段的其余来源。网关自身的流量仍经 `proxy`。

经过 tun 的 DNS 请求由 sing-box 回答，并按来源地址经该来源的选择器解析。绑定只在运行时切换选择器（`binding.set`），不重启 sing-box；sing-box 启动后由 `ExecStartPost=gwctl.py pin` 按状态恢复全部选择。`pin` 不取 gwctl 的锁，因为持锁的变更可能正在等待这次重启完成。`vm_subnet.set` 只能在网关本机执行，用于声明虚拟机网段，并同时把该网段加入 masquerade。迁移见 [按来源绑定出口](../../docs/vm-isolation.md#按来源绑定出口)。

## 安装

在网关上以 root 执行，按提示审阅差异后确认：

```bash
ssh root@10.10.10.1 'rm -rf /root/clinavat-gateway && mkdir -m 700 /root/clinavat-gateway'
scp deploy/gateway/* root@10.10.10.1:/root/clinavat-gateway/
ssh root@10.10.10.1
cd /root/clinavat-gateway
./install.sh --wan-ip 192.0.2.10 --site clinavat.example.com --drop-direct 17.0.0.0/8 --acme-dns dns_ali
```

脚本依次安装 nginx 与 acme.sh、备份原配置至 `/var/lib/clinavat-gw/pre-install-*`、从现有 sing-box 配置导入状态、展示渲染差异、激活并等待确认，然后签发证书。阿里云 AccessKey 只在网关终端输入，由 acme.sh 保存在 `/var/lib/clinavat-gw/acme/account.conf`；应使用仅授予 `AliyunDNSFullAccess`（或限定该域名）的 RAM 子账号。证书由 `clinavat-gw-acme.timer` 每日检查续期。

Hub 接入时追加 `--hub-key 'ssh-ed25519 …'`，该密钥被限制为仅能从 `10.10.10.10` 调用 gwctl，不能获得 shell。安装后应删除号池机原有的网关 root 登录密钥，紧急运维从其他机器登录。

## 变更与回滚

每次变更：保存版本快照 → 校验约束、`sing-box check`、`nft -c`、`nginx -t` → 生效 → 健康检查（sing-box / tun、护栏、经代理的出口 IP、号池机 Web 与各站点）→ 90 秒内确认。健康检查失败立即回滚；未确认由 systemd 定时器自动回滚。存在待确认版本时拒绝新的变更；渲染文件被手工修改后拒绝覆盖，需显式传 `overwrite_drift`。

```bash
gwctl=/usr/local/lib/clinavat-gw/gwctl.py
$gwctl status
$gwctl state.get
$gwctl selector.select '{"tag": "home-proxy"}'
$gwctl dev_direct.put '{"dev_direct": ["203.0.113.7/32", "198.51.100.0/24"]}'
$gwctl binding.set '{"address": "10.31.0.130", "node": "home-proxy", "label": "槽位 A", "interrupt": false}'
$gwctl binding.set '{"address": "10.31.0.130", "node": null}'      # 解除绑定：该来源断网
$gwctl source_policy.set '{"source_policy": "bound"}'               # 需先绑定号池机地址
$gwctl confirm 7
$gwctl rollback 7          # 恢复到版本 7 生效之前
$gwctl audit.tail
```

Hub 通过 SSH 强制命令以 `{"op": "…", "args": {…}}` 单行 JSON 调用同一组操作；`import`、`render`、`activate` 仅限网关本机。审计记录位于 `/var/lib/clinavat-gw/audit.jsonl`，版本快照位于 `/var/lib/clinavat-gw/revisions/`。

应急恢复：`cp /var/lib/clinavat-gw/pre-install-*/config.json /etc/sing-box/ && systemctl restart sing-box`；护栏保持加载。
