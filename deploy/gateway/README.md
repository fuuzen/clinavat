# 网关控制面

网关（`10.10.10.1`，Linux + sing-box）由 `gwctl.py` 统一管理代理节点、分流规则、开发机直连名单、DNAT 端口映射、Nginx 站点和 acme.sh 证书。期望状态保存在 `/etc/cc-pool-gw/state.json`，`/etc/sing-box/config.json`、`/etc/cc-pool-gw/rendered/guard.nft` 和 `/etc/nginx/sites-available/cc-pool.conf` 均由其渲染，不再手工编辑。接口、号池机地址、内网段、DNS 上游与 sing-box 控制接口密钥等基础设施保存在 `/etc/cc-pool-gw/infra.json`，只能在网关上修改。

## 防泄漏护栏

nft 表 `inet cc_pool_guard` 取代原 iptables `POOL_DNAT` / `MASQUERADE`。号池网段（`eth1`）转发到 `eth0` 时，仅放行 `lan_direct`（内网段）、`dev_direct`（开发机公网地址）和 DNAT 入站回包，其余流量只能经 `tun0` 出站。sing-box 停止或崩溃时号池机断网而不会以真实 IP 出站。`gateway-rules.service` 在 sing-box 之前加载护栏；渲染文件缺失、加载失败或停止该服务时载入只放行内网段的兜底规则。

sing-box 默认出站、DNS 出站固定为节点选择器 `proxy`；`direct` 只用于直连名单，任何请求都不能把规则、默认出站或节点 `detour` 指向直连，也不能新增入站。原有“所有 22 端口直连”规则已移除，开发机 SSH 通过直连名单绕过 tun，其他 SSH 目标（如 GitHub）经代理。

## 安装

在网关上以 root 执行，按提示审阅差异后确认：

```bash
ssh root@10.10.10.1 'rm -rf /root/cc-pool-gateway && mkdir -m 700 /root/cc-pool-gateway'
scp deploy/gateway/* root@10.10.10.1:/root/cc-pool-gateway/
ssh root@10.10.10.1
cd /root/cc-pool-gateway
./install.sh --wan-ip 192.0.2.10 --site clinavat.example.com --drop-direct 17.0.0.0/8 --acme-dns dns_ali
```

脚本依次安装 nginx 与 acme.sh、备份原配置至 `/var/lib/cc-pool-gw/pre-install-*`、从现有 sing-box 配置导入状态、展示渲染差异、激活并等待确认，然后签发证书。阿里云 AccessKey 只在网关终端输入，由 acme.sh 保存在 `/var/lib/cc-pool-gw/acme/account.conf`；应使用仅授予 `AliyunDNSFullAccess`（或限定该域名）的 RAM 子账号。证书由 `cc-pool-gw-acme.timer` 每日检查续期。

Hub 接入时追加 `--hub-key 'ssh-ed25519 …'`，该密钥被限制为仅能从 `10.10.10.10` 调用 gwctl，不能获得 shell。安装后应删除号池机原有的网关 root 登录密钥，紧急运维从其他机器登录。

## 变更与回滚

每次变更：保存版本快照 → 校验约束、`sing-box check`、`nft -c`、`nginx -t` → 生效 → 健康检查（sing-box / tun、护栏、经代理的出口 IP、号池机 Web 与各站点）→ 90 秒内确认。健康检查失败立即回滚；未确认由 systemd 定时器自动回滚。存在待确认版本时拒绝新的变更；渲染文件被手工修改后拒绝覆盖，需显式传 `overwrite_drift`。

```bash
gwctl=/usr/local/lib/cc-pool-gw/gwctl.py
$gwctl status
$gwctl state.get
$gwctl selector.select '{"tag": "home-proxy"}'
$gwctl dev_direct.put '{"dev_direct": ["203.0.113.7/32", "198.51.100.0/24"]}'
$gwctl confirm 7
$gwctl rollback 7          # 恢复到版本 7 生效之前
$gwctl audit.tail
```

Hub 通过 SSH 强制命令以 `{"op": "…", "args": {…}}` 单行 JSON 调用同一组操作；`import`、`render`、`activate` 仅限网关本机。审计记录位于 `/var/lib/cc-pool-gw/audit.jsonl`，版本快照位于 `/var/lib/cc-pool-gw/revisions/`。

应急恢复：`cp /var/lib/cc-pool-gw/pre-install-*/config.json /etc/sing-box/ && systemctl restart sing-box`；护栏保持加载，如需同时恢复旧 iptables 脚本，从同一备份目录复制 `gateway-rules.sh` 与 `gateway-rules.service` 后执行 `systemctl daemon-reload && systemctl restart gateway-rules`。
