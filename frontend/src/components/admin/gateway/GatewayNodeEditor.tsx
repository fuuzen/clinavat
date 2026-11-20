import { useId, useState } from "react";
import { Braces, Eye, EyeOff, Save, SlidersHorizontal, X } from "lucide-react";
import { errorText } from "../../../api";
import { fieldText, protocolNode, proxyProtocols, record, validateNode, type GatewayProxyNode } from "./gateway-node-config";
export type { GatewayProxyNode } from "./gateway-node-config";

export default function GatewayNodeEditor({ initial, originalTag, copied, occupiedTags, disabled, onSave, onCancel }: {
  initial: GatewayProxyNode; originalTag?: string; copied?: boolean; occupiedTags: string[]; disabled: boolean;
  onSave: (node: GatewayProxyNode) => void; onCancel: () => void;
}) {
  const prefix = useId();
  const [draft, setDraft] = useState(initial);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const tls = record(draft.tls);
  const transport = record(draft.transport);
  const tlsEnabled = tls.enabled === true;
  function update(changes: Partial<GatewayProxyNode>) { setDraft((current) => ({ ...current, ...changes })); setError(""); }
  function setField(key: string, value: unknown) {
    setDraft((current) => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next; });
    setError("");
  }
  function toggleAdvanced(next: boolean) {
    try {
      if (next) setJson(JSON.stringify(draft, null, 2));
      else {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("节点配置必须是单个 JSON 对象。");
        if (originalTag && (parsed as GatewayProxyNode).tag !== originalTag) throw new Error("已有节点的标识不能修改。");
        setDraft(parsed as GatewayProxyNode);
      }
      setAdvanced(next); setError("");
    } catch (cause) { setError(errorText(cause)); }
  }
  function save() {
    try { onSave(validateNode(advanced ? JSON.parse(json) : draft, occupiedTags, originalTag)); }
    catch (cause) { setError(errorText(cause)); }
  }
  function secretField(key: string, label: string) {
    return <label htmlFor={`${prefix}-${key}`}>{label}<input id={`${prefix}-${key}`} type={showSecret ? "text" : "password"}
      value={fieldText(draft[key])} disabled={disabled} autoComplete="off" spellCheck={false}
      onChange={(event) => setField(key, event.target.value)} /></label>;
  }
  return <section className="gateway-node-editor" aria-label={originalTag ? `编辑节点 ${originalTag}` : copied ? "复制节点" : "新增节点"}>
    <div className="gateway-node-editor-heading"><h4>{originalTag ? `编辑 ${originalTag}` : copied ? "复制为新节点" : "新增节点"}</h4>
      <button type="button" className="icon-button" aria-label="关闭节点编辑器" disabled={disabled} onClick={onCancel}><X size={15} /></button>
    </div>
    <p className="gateway-hint">保存后加入本页草稿，点击「应用全部更改」才会生效。{originalTag ? " 密钥保持 *** 即沿用现有值；节点标识固定。" : " 请填写新的节点标识和凭据。"}</p>
    {copied && <p className="gateway-hint">复制时已清除凭据掩码，请重新填写密码、UUID 或高级 JSON 中的嵌套密钥。</p>}
    <div className="gateway-node-editor-tabs" aria-label="节点编辑方式">
      <button type="button" className={`button button-small${advanced ? " button-ghost" : " button-secondary"}`} aria-pressed={!advanced} disabled={disabled} onClick={() => toggleAdvanced(false)}><SlidersHorizontal size={13} />常规配置</button>
      <button type="button" className={`button button-small${advanced ? " button-secondary" : " button-ghost"}`} aria-pressed={advanced} disabled={disabled} onClick={() => toggleAdvanced(true)}><Braces size={13} />高级 JSON</button>
    </div>
    {advanced ? <div className="gateway-editor"><p className="gateway-hint">编辑此节点的完整 sing-box 出站对象。协议的扩展字段会原样保留；代理顺序在下方链路中配置。</p>
      <textarea aria-label="单个代理节点 JSON" value={json} onChange={(event) => { setJson(event.target.value); setError(""); }} disabled={disabled} spellCheck={false} rows={15} />
    </div> : <div className="gateway-node-form">
      <label htmlFor={`${prefix}-tag`}>节点标识<input id={`${prefix}-tag`} value={draft.tag ?? ""} readOnly={!!originalTag} disabled={disabled} maxLength={64} spellCheck={false} placeholder="例如 tokyo-transit" onChange={(event) => update({ tag: event.target.value })} /></label>
      <label htmlFor={`${prefix}-type`}>协议<select id={`${prefix}-type`} value={draft.type} disabled={disabled} onChange={(event) => { setDraft(protocolNode(event.target.value, draft)); setError(""); }}>
        {proxyProtocols.map((type) => <option value={type} key={type}>{type}</option>)}
      </select></label>
      <label htmlFor={`${prefix}-server`}>服务器地址<input id={`${prefix}-server`} value={draft.server ?? ""} disabled={disabled} spellCheck={false} placeholder="服务器 IP 或域名" onChange={(event) => update({ server: event.target.value })} /></label>
      <label htmlFor={`${prefix}-port`}>端口<input id={`${prefix}-port`} type="number" min={1} max={65535} value={draft.server_port ?? ""} disabled={disabled} onChange={(event) => update({ server_port: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
      {draft.type === "shadowsocks" && <label htmlFor={`${prefix}-method`}>加密方法<input id={`${prefix}-method`} value={fieldText(draft.method)} list={`${prefix}-methods`} disabled={disabled} spellCheck={false} onChange={(event) => setField("method", event.target.value)} />
        <datalist id={`${prefix}-methods`}>{["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"].map((method) => <option key={method} value={method} />)}</datalist>
      </label>}
      {["vmess", "vless", "tuic"].includes(draft.type) && secretField("uuid", "UUID")}
      {["shadowsocks", "trojan", "hysteria2", "tuic", "anytls", "naive", "socks", "http"].includes(draft.type) && secretField("password", ["socks", "http"].includes(draft.type) ? "密码（可选）" : "密码")}
      {["socks", "http", "naive"].includes(draft.type) && <label htmlFor={`${prefix}-username`}>用户名{draft.type !== "naive" ? "（可选）" : ""}<input id={`${prefix}-username`} value={fieldText(draft.username)} disabled={disabled} autoComplete="off" onChange={(event) => setField("username", event.target.value || undefined)} /></label>}
      {draft.type === "vmess" && <>
        <label htmlFor={`${prefix}-security`}>加密方式<input id={`${prefix}-security`} value={fieldText(draft.security)} disabled={disabled} onChange={(event) => setField("security", event.target.value || undefined)} placeholder="auto" /></label>
        <label htmlFor={`${prefix}-alter-id`}>Alter ID<input id={`${prefix}-alter-id`} type="number" min={0} value={typeof draft.alter_id === "number" ? draft.alter_id : 0} disabled={disabled} onChange={(event) => setField("alter_id", Number(event.target.value))} /></label>
      </>}
      {["shadowsocks", "vmess", "vless", "trojan", "socks"].includes(draft.type) && <label htmlFor={`${prefix}-network`}>传输网络<select id={`${prefix}-network`} value={fieldText(draft.network)} disabled={disabled} onChange={(event) => setField("network", event.target.value || undefined)}><option value="">协议默认</option><option value="tcp">仅 TCP</option><option value="udp">仅 UDP</option></select></label>}
      <div className="gateway-node-form-wide gateway-node-form-notes"><p className="gateway-hint">切换协议会重置该协议的专用字段。高级 JSON 可配置 Reality、uTLS、UDP over TCP、拥塞控制等扩展；编辑常规字段会保留已有扩展。</p>
        <button type="button" className="button button-ghost button-small" aria-pressed={showSecret} disabled={disabled} onClick={() => setShowSecret((current) => !current)}>{showSecret ? <EyeOff size={13} /> : <Eye size={13} />}{showSecret ? "隐藏" : "显示"}输入的凭据</button>
      </div>
      {["vmess", "vless", "trojan"].includes(draft.type) && <fieldset className="gateway-node-form-wide gateway-node-options"><legend>传输配置</legend>
        <label htmlFor={`${prefix}-transport`}>传输方式<select id={`${prefix}-transport`} value={fieldText(transport.type)} disabled={disabled} onChange={(event) => setField("transport", event.target.value ? { type: event.target.value, ...(event.target.value === "ws" ? { path: "/" } : {}) } : undefined)}>
          <option value="">协议默认 TCP</option><option value="ws">WebSocket</option>{typeof transport.type === "string" && transport.type !== "ws" && <option value={fieldText(transport.type)}>{fieldText(transport.type)}（高级配置）</option>}
        </select></label>
        {transport.type === "ws" && <>
          <label htmlFor={`${prefix}-ws-path`}>WebSocket 路径<input id={`${prefix}-ws-path`} value={fieldText(transport.path)} disabled={disabled} onChange={(event) => setField("transport", { ...transport, path: event.target.value })} /></label>
          <label htmlFor={`${prefix}-ws-host`}>WebSocket Host<input id={`${prefix}-ws-host`} value={fieldText(record(transport.headers).Host)} disabled={disabled} spellCheck={false} onChange={(event) => { const headers = { ...record(transport.headers) }; if (event.target.value) headers.Host = event.target.value; else delete headers.Host; setField("transport", { ...transport, headers }); }} /></label>
        </>}
      </fieldset>}
      {!["shadowsocks", "socks"].includes(draft.type) && <fieldset className="gateway-node-form-wide gateway-node-options"><legend>TLS 配置</legend>
        <label className="gateway-node-checkbox"><input type="checkbox" checked={tlsEnabled} disabled={disabled} onChange={(event) => setField("tls", { ...tls, enabled: event.target.checked })} />启用 TLS</label>
        {tlsEnabled && <>
          <label htmlFor={`${prefix}-sni`}>服务器名称（SNI）<input id={`${prefix}-sni`} value={fieldText(tls.server_name)} disabled={disabled} spellCheck={false} onChange={(event) => setField("tls", { ...tls, server_name: event.target.value })} /></label>
          <label className="gateway-node-checkbox"><input type="checkbox" checked={tls.insecure === true} disabled={disabled} onChange={(event) => setField("tls", { ...tls, insecure: event.target.checked })} />跳过证书校验</label>
        </>}
      </fieldset>}
    </div>}
    {error && <p className="gateway-field-error" role="alert">{error}</p>}
    <div className="gateway-editor-actions"><button type="button" className="button button-ghost button-small" disabled={disabled} onClick={onCancel}>取消编辑</button>
      <button type="button" className="button button-primary button-small" disabled={disabled} onClick={save}><Save size={14} />保存到草稿</button>
    </div>
  </section>;
}
