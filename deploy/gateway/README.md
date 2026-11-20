# 网关控制面

> 新部署把网关放在本机虚拟机中，用 `deploy/lxd/gateway-vm.sh` 安装，见[虚拟机隔离](../../docs/vm-isolation.md#网关虚拟机)。下面的 `install.sh` 用于独立主机。

网关（`10.10.10.1`，Linux + sing-box）由 `gwctl.py` 统一管理代理节点、分流规则、开发机直连名单、DNAT 端口映射、Nginx 站点和 acme.sh 证书。期望状态保存在 `/etc/clinavat-gw/state.json`，`/etc/sing-box/config.json`、`/etc/clinavat-gw/rendered/guard.nft` 和 `/etc/nginx/sites-available/clinavat.conf` 均由其渲染，不再手工编辑。接口、号池机地址、内网段、DNS 上游与 sing-box 控制接口密钥等基础设施保存在 `/etc/clinavat-gw/infra.json`，只能在网关上修改。

## 防泄漏护栏

nft 表 `inet clinavat_guard` 负责 DNAT 和地址转换。号池网段（`eth1`）转发到 `eth0` 时，仅放行 `lan_direct`（内网段）、`dev_direct`（开发机公网地址）和 DNAT 入站回包，其余流量只能经 `tun0` 出站。sing-box 停止或崩溃时号池机断网而不会以真实 IP 出站。`gateway-rules.service` 在 sing-box 之前加载护栏；渲染文件缺失、加载失败或停止该服务时载入只放行内网段的兜底规则。

sing-box 默认出站、DNS 出站固定为节点选择器 `proxy`；`direct` 只用于直连名单，任何请求都不能把规则、默认出站或节点 `detour` 指向直连，也不能新增入站。出口节点的 `detour` 由控制器根据前置链生成，管理员不能在节点定义中自行设置。开发机 SSH 通过直连名单绕过 tun，其他 SSH 目标（如 GitHub）经代理。

网关安装会设置 `/etc/systemd/networkd.conf.d/90-clinavat-proxy-routing.conf` 中的 `ManageForeignRoutingPolicyRules=no`，防止 `systemd-networkd` 在网卡重配时删除 sing-box 的自动策略路由。已有网关新增此配置后，先重启 `systemd-networkd`，再重启 `sing-box`；随后检查 `ip rule` 中的代理规则和虚拟机内 DNS/HTTPS，单独检查网关本机连通性不能验证转发链路。

## 按来源绑定出口

`source_policy` 为 `shared`（默认）时，所有来源经共享选择器 `proxy` 出站。改为 `bound` 后，号池机和 `infra.json` 中 `vm_subnet` 的每个地址各有一个选择器 `src-<地址>`，按 `state.json` 的 `bindings` 指向节点。未绑定的地址指向只能连到网关回环地址的死路出口 `unbound`，路由和 DNS 末尾再拒绝号池网段与虚拟机网段的其余来源。网关自身的流量仍经 `proxy`。

经过 tun 的 DNS 请求由 sing-box 回答，并按来源地址经该来源的选择器解析。绑定只在运行时切换选择器（`binding.set`），不重启 sing-box；sing-box 启动后由 `ExecStartPost=gwctl.py pin` 按状态恢复全部选择。`pin` 不取 gwctl 的锁，因为持锁的变更可能正在等待这次重启完成。`vm_subnet.set` 只能在网关本机执行，用于声明虚拟机网段，并同时把该网段加入 masquerade。迁移见 [按来源绑定出口](../../docs/vm-isolation.md#按来源绑定出口)。

管理员可以在槽位的出口绑定行同时选择 VM 时区。选择节点时，会经该节点实际访问位置服务，自动选中对应 IANA 时区；推荐结果包含出口 IP 和地理位置，仍可手动更改。只有点击「应用」才保存，查询失败不影响手动选择。

`nodes.location` 由同目录的 `gateway-location.py` 启动独立 sing-box 临时进程，仅监听带随机认证的回环 SOCKS 端口。该进程包含所选出口的前置节点与代理组，按完整链路查询 [IPWHOIS](https://ipwhois.io/documentation) 的 HTTPS 当前 IP 接口，失败后尝试 [ipapi](https://ipapi.co/api/)，目标 DNS 也经所选节点解析；不会切换正在使用的节点、修改来源绑定或重启主 sing-box。请求超时后清理临时进程和配置，节点凭据不会返回 Hub。地理信息依赖服务商数据库，仅供选择时区时参考；服务不可用或限流时可手动指定。

已有网关需同时更新 `gwctl.py`、`gateway-chain.py` 和 `gateway-location.py`（安装位置 `/usr/local/lib/clinavat-gw/`，root 所有、权限 `0700`）。更新控制器文件本身不会重启 sing-box；应用前置组配置时才重新渲染并重启。独立主机安装和 LXD 的创建、刷新、出口绑定迁移脚本均会复制这三个文件。

## 节点管理与多级链式代理

管理员在「网关」的节点与链路配置区中分别维护落地节点、前置节点、自动代理组和每个落地节点的链路。两类节点使用相同的单节点编辑器，支持新增、编辑、复制、删除；常用字段使用表单，协议特有配置保留在单节点高级 JSON 中。已有节点标识固定，避免凭据与已有引用失配；复制节点时需要为新标识补齐凭据。

节点、代理组和链路的修改先保存到同一份草稿，再点击「应用全部更改」一次生效。例如将正在使用的落地节点从 VLESS 改成 Shadowsocks，并同时设置其前置链，整个过程只有一次校验、重启和回滚版本。草稿存在时，刷新和其他配置操作会受到限制，避免覆盖尚未应用的修改。其他管理员修改了代理配置后，旧草稿会因版本不一致被拒绝，需要重新读取并合并。

链路按实际流量方向配置：`设备 → 第一跳 → 第二跳 → … → 落地节点 → 目标网站`。每一跳可以选择单个前置节点或自动代理组，支持添加、删除和调整顺序，最多 8 个前置跳。最终公网 IP 由落地节点决定；来源绑定、分流规则和共享选择器仍引用落地节点。

状态沿用 `preproxy` 对象，包含 `nodes`、`groups` 和 `routes`：`nodes` 为 sing-box 原生节点数组；`groups[].nodes` 引用前置节点标识；`routes` 的键为落地节点标识，值为按流量顺序排列的前置节点/组数组，不包含落地节点自身。兼容旧的字符串值，表示单跳链。示例中的域名和凭据均为占位符，真实凭据不写入源码：

```json
{
  "nodes": [
    {
      "tag": "front-01",
      "type": "shadowsocks",
      "server": "front-01.example.com",
      "server_port": 443,
      "method": "aes-256-gcm",
      "password": "<节点密码>"
    },
    {
      "tag": "front-02",
      "type": "shadowsocks",
      "server": "front-02.example.com",
      "server_port": 443,
      "method": "aes-256-gcm",
      "password": "<节点密码>"
    },
    {
      "tag": "front-relay",
      "type": "shadowsocks",
      "server": "relay.example.com",
      "server_port": 443,
      "method": "aes-128-gcm",
      "password": "<中转节点密码>"
    }
  ],
  "groups": [
    {
      "tag": "front-auto",
      "nodes": ["front-01", "front-02"],
      "url": "https://www.gstatic.com/generate_204",
      "interval": "30s",
      "tolerance": 50
    }
  ],
  "routes": {
    "jp-zoro": ["front-auto", "front-relay"],
    "malaysia-wepc": "front-auto"
  }
}
```

每个落地节点的每一跳都生成独立的 sing-box 出站依赖，内部标识使用保留前缀 `chain-`。同一节点或代理组可以用于不同链路，各链的前序连接与选择状态相互独立。组固定渲染为 sing-box [URLTest](https://sing-box.sagernet.org/configuration/outbound/urltest/)，默认每 `30s` 探测、容差 `50ms`；间隔可设 `10s` 到 `1h`。故障切换依赖探测周期及超时，内部链路切换可能中断现有连接，需要客户端重连。

第一跳服务器的域名由 WAN 引导 DNS 解析；后续代理服务器的域名通过前序链解析，客户端目标域名继续经最终落地节点解析。`infra.json` 的 `bootstrap_dns` 使用 sing-box DNS 服务器对象，默认复用 `dns` 上游；该上游必须可从 WAN 直达。

所有节点和组标识全局唯一。拒绝保留标识、`direct`、悬空引用、重复跳，以及跨跳重复的底层组成员，防止循环和串路。节点定义不能自行设置 `detour`、网卡绑定等绕行字段；这些字段由控制器生成。配置了前置链的落地节点在链路失败时断网，不会退回直连。

`proxies.put` 使用一次事务同时替换落地节点和前置配置。Hub 接口为 `PUT /api/admin/gateway/proxies`，请求体包含 `nodes`、`preproxy`、可选的 `expected_revision` 以及 `force`。`state.get` 顶层的 `proxy_revision` 是代理配置版本，面板提交草稿时携带它；来源绑定等非代理配置的变化不影响该版本。旧的 `nodes.put` 与 `preproxy.put` 接口仍可用。

`preproxy.delay` / `POST /api/admin/gateway/preproxy/delay` 返回前置节点连通性与自动组选择信息。直接测试前置节点不等于测试经过前序节点的完整链路，面板区分两者；落地节点测速和 `nodes.location` 均按实际完整链路执行。凭据在读取时显示为 `***`，按相同节点标识保存会保留原值；新增和复制节点必须填写实际凭据。

应用沿用快照、配置检查、健康检查和 90 秒确认回滚流程，可能中断现有连接。运行中的对话需要管理员选择允许中断。网关凭据仅保存在受限状态、运行配置和版本快照中，前端及审计不会返回原始凭据。

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

管理面板读取失败时，先查看号池机上的 `journalctl --user -u clinavat-hub.service`。SSH 超时不代表公钥未授权，不需要因此重跑安装脚本。LXD 部署可用 `sudo lxc exec clinavat-gateway --project clinavat-gateway -- journalctl -b -u ssh -u systemd-logind --no-pager -n 80` 查看网关内部日志；在号池宿主机运行 `install.sh` 会因没有 sing-box 而退出。

## 变更与回滚

每次变更：保存版本快照 → 校验约束、`sing-box check`、`nft -c`、`nginx -t` → 生效 → 健康检查（sing-box / tun、护栏、经代理的出口 IP、号池机 Web 与各站点）→ 90 秒内确认。健康检查失败立即回滚；未确认由 systemd 定时器自动回滚。存在待确认版本时拒绝新的变更；渲染文件被手工修改后拒绝覆盖，需显式传 `overwrite_drift`。

```bash
gwctl=/usr/local/lib/clinavat-gw/gwctl.py
$gwctl status
$gwctl state.get
$gwctl selector.select '{"tag": "home-proxy"}'
$gwctl dev_direct.put '{"dev_direct": ["203.0.113.7/32", "198.51.100.0/24"]}'
$gwctl binding.set '{"address": "10.31.0.130", "node": "home-proxy", "label": "槽位 A", "interrupt": false}'
$gwctl nodes.location '{"tag": "home-proxy"}'                       # 查询节点真实出口及其时区
$gwctl binding.set '{"address": "10.31.0.130", "node": null}'      # 解除绑定：该来源断网
$gwctl source_policy.set '{"source_policy": "bound"}'               # 需先绑定号池机地址
$gwctl confirm 7
$gwctl rollback 7          # 恢复到版本 7 生效之前
$gwctl audit.tail
```

Hub 通过 SSH 强制命令以 `{"op": "…", "args": {…}}` 单行 JSON 调用同一组操作；`import`、`render`、`activate` 仅限网关本机。审计记录位于 `/var/lib/clinavat-gw/audit.jsonl`，版本快照位于 `/var/lib/clinavat-gw/revisions/`。

应急恢复：`cp /var/lib/clinavat-gw/pre-install-*/config.json /etc/sing-box/ && systemctl restart sing-box`；护栏保持加载。
