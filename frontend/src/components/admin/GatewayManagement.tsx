import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Activity, Check, Copy, FileJson, Globe2, History, KeyRound, LoaderCircle, Network, RefreshCw, Route, Save, ShieldCheck, Undo2, Waypoints, Zap,
} from "lucide-react";
import { api, ApiError, errorText } from "../../api";
import SiteAccessSettings from "./SiteAccessSettings";
import "../../styles/admin-gateway.css";

interface Info { configured: boolean; target: string | null; publicKey: string; fingerprint: string | null; gwctl: string; installCommand: string }
interface Health {
  sing_box: boolean; tun: boolean; guard: boolean; egress_ip: string | null; upstream: string | null;
  sites: Record<string, string>; problems: string[];
}
interface Node { tag: string; type: string; server?: string; server_port?: number; [key: string]: unknown }
interface Forward { proto: "tcp" | "udp"; port: number; to_port: number; note?: string }
interface GatewayState { nodes: Node[]; selected: string; rules: Record<string, unknown>[]; dev_direct: string[]; forwards: Forward[]; sites: string[] }
interface AuditEntry { at: string; action: string; status: string; via: string; revision?: number; error?: string; problems?: string[]; reason?: string }
interface HubAudit { id: number; username: string | null; action: string; revision: number | null; status: string; detail: string | null; created_at: string }
interface Overview {
  status: { health: Health; drift: string[]; pending: { revision: number } | null; certificates: Record<string, string | null>; selected: string; nginx_installed: boolean };
  state: GatewayState; infra: { lan_direct: string[]; pool_ip: string; wan_ip: string; forbidden_egress_ips?: string[] };
  audit: AuditEntry[]; revisions: number[]; hubAudit: HubAudit[]; busySessions: number;
}
interface DevHost { id: string; name: string; owner: string; endpoints: { host: string; resolved: boolean; addresses: { address: string; covered: "dev" | "lan" | null }[] }[] }

const actionLabels: Record<string, string> = {
  import: "导入配置", activate: "激活", "nodes.put": "修改节点", "selector.select": "切换节点", "rules.put": "修改分流规则",
  "dev_direct.put": "修改直连名单", "forwards.put": "修改端口映射", "sites.put": "修改站点", "cert.issue": "签发证书",
  "cert.enable": "启用证书", "certs.sync": "证书续期", confirm: "确认", rollback: "回滚",
};
const statusLabels: Record<string, string> = {
  PENDING: "待确认", CONFIRMED: "已确认", APPLIED: "已应用", UNCHANGED: "无变化", ROLLED_BACK: "已回滚",
  FAILED: "失败", ISSUED: "已签发", IMPORTED: "已导入", RENEWED: "已续期",
};

function Status({ ok, label }: { ok: boolean | null; label: string }) {
  return <span className={`admin-status${ok === null ? "" : ok ? " success" : " warning"}`}>{label}</span>;
}

function JsonEditor({ value, disabled, hint, onSave }: { value: unknown; disabled: boolean; hint: string; onSave: (value: unknown) => Promise<void> }) {
  const initial = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(initial); setError(""); }, [initial]);
  function save() {
    let parsed: unknown;
    try { parsed = JSON.parse(draft); } catch (cause) { setError(`JSON 无效：${errorText(cause)}`); return; }
    setError("");
    void onSave(parsed);
  }
  return (
    <div className="gateway-editor">
      <p className="gateway-hint">{hint}</p>
      <textarea value={draft} spellCheck={false} rows={Math.min(18, Math.max(5, draft.split("\n").length))} disabled={disabled}
        onChange={(event) => setDraft(event.target.value)} aria-label="JSON 配置" />
      {error && <p className="gateway-field-error" role="alert">{error}</p>}
      <div className="gateway-editor-actions">
        <button type="button" className="button button-ghost button-small" disabled={disabled || draft === initial} onClick={() => setDraft(initial)}>还原</button>
        <button type="button" className="button button-primary button-small" disabled={disabled || draft === initial} onClick={save}><Save size={14} />应用</button>
      </div>
    </div>
  );
}

function ListEditor({ value, disabled, placeholder, extra, onSave }: { value: string[]; disabled: boolean; placeholder: string; extra?: string[]; onSave: (value: string[]) => Promise<void> }) {
  const initial = value.join("\n");
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); }, [initial]);
  useEffect(() => {
    if (!extra?.length) return;
    setDraft((current) => [...new Set([...current.split("\n").map((line) => line.trim()).filter(Boolean), ...extra])].join("\n"));
  }, [extra]);
  const items = draft.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className="gateway-editor">
      <textarea value={draft} spellCheck={false} rows={Math.min(12, Math.max(3, items.length + 1))} disabled={disabled} placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)} aria-label={placeholder} />
      <div className="gateway-editor-actions">
        <button type="button" className="button button-ghost button-small" disabled={disabled || draft === initial} onClick={() => setDraft(initial)}>还原</button>
        <button type="button" className="button button-primary button-small" disabled={disabled || items.join("\n") === initial} onClick={() => void onSave(items)}><Save size={14} />应用</button>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, description, children, actions }: { icon: typeof Network; title: string; description: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="admin-card gateway-section">
      <div className="admin-card-heading"><div><Icon size={16} /><h3>{title}</h3></div>{actions}</div>
      <p className="gateway-description">{description}</p>
      {children}
    </section>
  );
}

function copy(text: string) { void navigator.clipboard?.writeText(text); }

export default function GatewayManagement() {
  const [info, setInfo] = useState<Info | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [devHosts, setDevHosts] = useState<DevHost[] | null>(null);
  const [publicHosts, setPublicHosts] = useState<string[]>([]);
  const [delays, setDelays] = useState<Record<string, number | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [force, setForce] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [extraDirect, setExtraDirect] = useState<string[]>([]);
  const updatePublicHosts = useCallback((urls: string[]) => {
    setPublicHosts(urls.filter((url) => url.startsWith("https://")).map((url) => new URL(url).hostname));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setInfo(await api<Info>("/admin/gateway"));
      const [latest, hosts, site] = await Promise.all([
        api<Overview>("/admin/gateway/overview"),
        api<DevHost[]>("/admin/gateway/dev-hosts").catch(() => null),
        api<{ publicUrls: string[] }>("/admin/site-access").catch(() => null),
      ]);
      setOverview(latest);
      setDevHosts(hosts);
      updatePublicHosts(site?.publicUrls ?? []);
    } catch (cause) {
      setOverview(null);
      setLoadError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [updatePublicHosts]);
  useEffect(() => { void load(); }, [load]);

  async function change(label: string, path: string, method: "PUT" | "POST", body: Record<string, unknown>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const result = await api<{ changed: boolean; revision?: number; confirmed?: boolean }>(path, { method, body: JSON.stringify({ ...body, force }) });
      setMessage(result.changed === false ? `${label}：配置没有变化。` : `${label}：已生效${result.revision ? `（版本 ${result.revision}${result.confirmed ? "，号池机验证通过" : ""}）` : ""}。`);
      setExtraDirect([]);
      await load();
    } catch (cause) {
      setError(`${label}失败：${errorText(cause)}`);
      if (!(cause instanceof ApiError && cause.status === 400)) await load();
    } finally {
      setBusy("");
    }
  }

  async function testDelay() {
    setBusy("测试延迟");
    try { setDelays(await api<Record<string, number | null>>("/admin/gateway/delay", { method: "POST", body: "{}" })); }
    catch (cause) { setError(`测试延迟失败：${errorText(cause)}`); }
    finally { setBusy(""); }
  }

  const disabled = !!busy || loading || !overview;
  const health = overview?.status.health;
  const state = overview?.state;
  const rolledBack = new Set((overview?.audit ?? []).filter((entry) => entry.status === "ROLLED_BACK").map((entry) => entry.revision));
  const hubByRevision = new Map((overview?.hubAudit ?? []).filter((row) => row.revision !== null).map((row) => [row.revision!, row]));
  const uncovered = (devHosts ?? []).flatMap((host) => host.endpoints.flatMap((endpoint) => endpoint.addresses
    .filter((item) => !item.covered).map((item) => ({ ...item, label: `${host.owner} / ${host.name}（${endpoint.host}）` }))));

  return (
    <div className="gateway-page" aria-busy={loading || !!busy}>
      <SiteAccessSettings onConfigLoaded={updatePublicHosts} />
      <section className="admin-card gateway-summary">
        <div className="gateway-summary-identity">
          <span className="admin-host-icon admin-host-icon-large"><Waypoints size={24} /></span>
          <div>
            <h3>网关控制面</h3>
            <p>{info?.target ?? "未配置 CLINAVAT_GATEWAY_HOST"}{info?.fingerprint ? ` · ${info.fingerprint}` : ""}</p>
          </div>
        </div>
        <div className="gateway-summary-actions">
          {overview && <label className="gateway-force">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={!!busy} />
            允许中断运行中的对话{overview.busySessions ? `（${overview.busySessions} 个运行中）` : ""}
          </label>}
          <button type="button" className="button button-secondary button-small" onClick={() => void load()} disabled={loading || !!busy}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />刷新
          </button>
        </div>
        {health && <div className="gateway-health">
          <Status ok={health.sing_box && health.tun} label={health.sing_box && health.tun ? "sing-box 运行中" : "sing-box 异常"} />
          <Status ok={health.guard} label={health.guard ? "防泄漏护栏已加载" : "护栏未加载"} />
          <Status ok={!!health.egress_ip} label={`代理出口 ${health.egress_ip ?? "不可用"}`} />
          <Status ok={health.upstream === "200"} label={`Web 上游 ${health.upstream ?? "—"}`} />
          {overview!.status.drift.length > 0 && <Status ok={false} label={`手工修改：${overview!.status.drift.join("、")}`} />}
          {overview!.status.pending && <Status ok={false} label={`版本 ${overview!.status.pending.revision} 待确认`} />}
        </div>}
        {health && health.problems.length > 0 && <p className="gateway-field-error" role="alert">{health.problems.join("；")}</p>}
      </section>

      {busy && <div className="gateway-progress" role="status"><LoaderCircle size={14} className="spin" />{busy}：正在应用并从号池机验证，未通过会自动回滚…</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {message && <p className="gateway-message" role="status"><Check size={13} />{message}</p>}

      {loadError && <Section icon={KeyRound} title="接入网关" description={`读取网关失败：${loadError}`}>
        {info && <div className="gateway-setup">
          <p>在网关上以 root 运行 <code>deploy/gateway/install.sh</code> 并附带下列参数，为 Hub 授权专用密钥（仅允许调用 <code>{info.gwctl}</code>，不能登录 shell）。已安装过的网关重复运行时不会改变现有配置。</p>
          <div className="gateway-copy"><code>{info.installCommand}</code><button type="button" className="icon-button" aria-label="复制命令" onClick={() => copy(info.installCommand)}><Copy size={14} /></button></div>
          <div className="gateway-copy"><code>{info.publicKey}</code><button type="button" className="icon-button" aria-label="复制公钥" onClick={() => copy(info.publicKey)}><Copy size={14} /></button></div>
        </div>}
      </Section>}

      {overview && state && <>
        <Section icon={Network} title="代理节点" description="出站流量经节点选择器 proxy 发出。切换节点不重启 sing-box；修改节点会重启 sing-box。密钥字段显示为 ***，保持不变即沿用原值。"
          actions={<button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => void testDelay()}><Zap size={14} />测试延迟</button>}>
          <div className="gateway-nodes">
            {state.nodes.map((node) => (
              <div className={`gateway-node${node.tag === state.selected ? " active" : ""}`} key={node.tag}>
                <div><strong>{node.tag}</strong><small>{node.type} · {node.server}:{node.server_port}</small></div>
                <span className="gateway-delay">{delays ? delays[node.tag] ? `${delays[node.tag]} ms` : "超时" : ""}</span>
                {node.tag === state.selected ? <span className="admin-status success">当前</span>
                  : <button type="button" className="button button-ghost button-small" disabled={disabled}
                    onClick={() => void change(`切换到 ${node.tag}`, "/admin/gateway/select", "POST", { tag: node.tag })}>设为当前</button>}
              </div>
            ))}
          </div>
          <details className="gateway-details"><summary><FileJson size={14} />编辑节点 JSON</summary>
            <JsonEditor value={state.nodes} disabled={disabled} hint="sing-box 出站数组。允许 vless / vmess / trojan / shadowsocks / hysteria(2) / tuic / anytls / naive，不允许 detour、bind_interface 等绕行字段。"
              onSave={(nodes) => change("修改节点", "/admin/gateway/nodes", "PUT", { nodes })} />
          </details>
        </Section>

        <Section icon={Route} title="分流规则" description="在默认走 proxy 的基础上追加 sing-box 路由规则。规则只能指向 proxy、某个节点，或 action=reject；直连仅由下方直连名单产生。">
          <JsonEditor value={state.rules} disabled={disabled}
            hint='示例：[{"domain_suffix": ["github.com"], "outbound": "proxy"}, {"domain_keyword": ["ads"], "action": "reject"}]。可用匹配字段：domain、domain_suffix、domain_keyword、domain_regex、ip_cidr、port、port_range、network、protocol。'
            onSave={(rules) => change("修改分流规则", "/admin/gateway/rules", "PUT", { rules })} />
        </Section>

        <Section icon={ShieldCheck} title="开发机直连" description={`这些公网地址不经代理，供 SSH 与同步直连；其余外网流量即使 sing-box 停止也不能直接出站。内网段由网关 infra.json 固定：${overview.infra.lan_direct.join("、")}。`}>
          <ListEditor value={state.dev_direct} extra={extraDirect} disabled={disabled} placeholder="每行一个 IPv4 CIDR，例如 203.0.113.7/32"
            onSave={(devDirect) => change("修改直连名单", "/admin/gateway/dev-direct", "PUT", { dev_direct: devDirect })} />
          {devHosts && <div className="gateway-dev-hosts">
            <h4>开发机地址</h4>
            {uncovered.length === 0 ? <p className="gateway-hint">所有开发机地址均已直连。</p> : uncovered.map((item) => (
              <div key={`${item.label}-${item.address}`} className="gateway-row">
                <span>{item.label}</span><code>{item.address}</code>
                <button type="button" className="button button-ghost button-small" disabled={disabled}
                  onClick={() => setExtraDirect((current) => [...new Set([...current, `${item.address}/32`])])}>加入草稿</button>
              </div>
            ))}
            {devHosts.some((host) => host.endpoints.some((endpoint) => !endpoint.resolved)) && <p className="gateway-hint">部分开发机主机名无法解析，请手动核对。</p>}
          </div>}
        </Section>

        <Section icon={Activity} title="端口映射" description={`网关 WAN（${overview.infra.wan_ip}）入站端口转发到号池机 ${overview.infra.pool_ip}。端口需 ≥ 1024，22 / 80 / 443 保留给网关。`}>
          <JsonEditor value={state.forwards} disabled={disabled} hint='示例：[{"proto": "tcp", "port": 2222, "to_port": 22, "note": "号池机 SSH"}]'
            onSave={(forwards) => change("修改端口映射", "/admin/gateway/forwards", "PUT", { forwards })} />
        </Section>

        <Section icon={Globe2} title="站点与证书" description="网关 Nginx 以 HTTPS 反代本系统；证书由 acme.sh 经 DNS-01 签发并每日检查续期。站点域名还需加入本页上方「访问配置」的公开地址，否则登录会被拒绝。">
          <div className="gateway-sites">
            {state.sites.map((site) => {
              const expiry = overview.status.certificates[site];
              return (
                <div className="gateway-row" key={site}>
                  <strong>{site}</strong>
                  <span className="gateway-hint">{expiry ? `证书到期 ${new Date(expiry).toLocaleDateString("zh-CN")}` : "尚无证书"} · 健康检查 {health?.sites[site] ?? "—"}</span>
                  {!publicHosts.includes(site) && <span className="admin-status warning">不在公开地址中</span>}
                  <button type="button" className="button button-ghost button-small" disabled={disabled}
                    onClick={() => void change(`签发 ${site} 证书`, "/admin/gateway/certs", "POST", { domain: site })}>{expiry ? "重新签发" : "签发证书"}</button>
                </div>
              );
            })}
          </div>
          <ListEditor value={state.sites} disabled={disabled || !overview.status.nginx_installed} placeholder="每行一个域名，例如 pool.example.com"
            onSave={(sites) => change("修改站点", "/admin/gateway/sites", "PUT", { sites })} />
        </Section>

        <Section icon={History} title="变更记录" description="每次变更保存快照；回滚恢复到该版本生效之前的配置。来源为 hub 的记录显示操作的管理员。">
          <div className="gateway-audit">
            {overview.audit.map((entry, index) => {
              const hub = entry.revision !== undefined ? hubByRevision.get(entry.revision) : undefined;
              const rollbackable = entry.revision !== undefined && ["PENDING", "APPLIED"].includes(entry.status)
                && overview.revisions.includes(entry.revision) && !rolledBack.has(entry.revision);
              return (
                <div className="gateway-row" key={`${entry.at}-${index}`}>
                  <time>{new Date(entry.at).toLocaleString("zh-CN")}</time>
                  <span>{actionLabels[entry.action] ?? entry.action}{entry.revision ? ` · 版本 ${entry.revision}` : ""}</span>
                  <span className={`admin-status${entry.status === "ROLLED_BACK" || entry.status === "FAILED" ? " warning" : ""}`}>{statusLabels[entry.status] ?? entry.status}</span>
                  <small className="gateway-hint">{entry.via === "hub" ? hub?.username ?? "hub" : "网关本机"}{entry.error || entry.problems ? ` · ${entry.error ?? entry.problems?.join("；")}` : ""}{entry.reason ? ` · ${entry.reason}` : ""}</small>
                  {rollbackable && <button type="button" className="button button-ghost button-small" disabled={disabled}
                    onClick={() => { if (window.confirm(`回滚到版本 ${entry.revision} 生效之前？之后的变更也会一并撤销。`)) void change(`回滚版本 ${entry.revision}`, "/admin/gateway/rollback", "POST", { revision: entry.revision }); }}>
                    <Undo2 size={13} />回滚</button>}
                </div>
              );
            })}
          </div>
        </Section>
      </>}
    </div>
  );
}
