import { useState } from "react";
import { Layers3, Plus, Trash2 } from "lucide-react";
import type { GatewayProxyNode } from "./GatewayNodeList";
import { chainSteps, tagPattern, type GatewayProxyGroup, type GatewayProxyProbe } from "./gateway-proxy-state";

export default function GatewayGroupEditor({ groups, nodes, exits, routes, disabled, probe, onChange, onRename }: {
  groups: GatewayProxyGroup[]; nodes: GatewayProxyNode[]; exits: GatewayProxyNode[];
  routes: Record<string, string | string[]>; disabled: boolean; probe: GatewayProxyProbe | null;
  onChange: (groups: GatewayProxyGroup[]) => void; onRename: (previous: string, next: string) => void;
}) {
  const [renameError, setRenameError] = useState("");
  function update(index: number, changes: Partial<GatewayProxyGroup>) {
    onChange(groups.map((group, position) => position === index ? { ...group, ...changes } : group));
  }
  function rename(index: number, input: HTMLInputElement) {
    const next = input.value.trim();
    const previous = groups[index].tag;
    if (next === previous) { setRenameError(""); return; }
    const occupied = new Set([...nodes.map((node) => node.tag), ...exits.map((node) => node.tag), ...groups.filter((_, position) => position !== index).map((group) => group.tag)]);
    if (!tagPattern.test(next) || occupied.has(next) || ["src-", "dns-", "chain-"].some((prefix) => next.startsWith(prefix))
      || ["proxy", "direct", "block", "dns", "tun-in", "unbound", "proxy-dns"].includes(next)) {
      setRenameError(`代理组标识未修改：${next || "空标识"} 无效、为保留名或已被其他节点/组使用。`);
      input.value = previous;
      return;
    }
    update(index, { tag: next }); onRename(previous, next); setRenameError("");
  }
  function add() {
    const occupied = new Set([...nodes.map((node) => node.tag), ...exits.map((node) => node.tag), ...groups.map((group) => group.tag)]);
    let tag = "preproxy-auto";
    for (let suffix = 2; occupied.has(tag); suffix++) tag = `preproxy-auto-${suffix}`;
    onChange([...groups, { tag, nodes: nodes.map((node) => node.tag), interval: "30s", tolerance: 50 }]);
  }
  return <section className="admin-card gateway-section">
    <div className="admin-card-heading"><div><Layers3 size={16} /><h3>自动代理组</h3></div><button type="button" className="button button-secondary button-small" disabled={disabled || !nodes.length || groups.length >= 16} onClick={add}><Plus size={14} />添加代理组</button></div>
    <p className="gateway-description">一组中的节点是可相互切换的候选；在代理链中选择该组，就会自动测速择优并在故障时切换。组与组之间的先后顺序在下方代理链中配置。</p>
    {renameError && <p className="gateway-field-error" role="alert">{renameError}</p>}
    {!groups.length && <p className="gateway-hint">可先添加前置节点，再创建自动代理组。单个前置节点也可以直接加入代理链。</p>}
    <div className="gateway-proxy-groups">
      {groups.map((group, index) => {
        const references = Object.values(routes).filter((route) => chainSteps(route).includes(group.tag)).length;
        const members = [...new Set([...nodes.map((node) => node.tag), ...group.nodes])];
        return <details className="gateway-proxy-group" key={index} open>
          <summary><strong>{group.tag || "未命名代理组"}</strong><span>{group.nodes.length} 个成员 · 用于 {references} 条链</span></summary>
          <div className="gateway-proxy-group-fields">
            <label>代理组标识<input key={group.tag} defaultValue={group.tag} maxLength={64} disabled={disabled} onBlur={(event) => rename(index, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
            <label>测速间隔<input value={group.interval ?? "30s"} placeholder="30s" disabled={disabled} onChange={(event) => update(index, { interval: event.target.value })} /></label>
            <label>切换容差（ms）<input type="number" min={0} max={10000} value={group.tolerance ?? 50} disabled={disabled} onChange={(event) => update(index, { tolerance: Number(event.target.value) })} /></label>
            <button type="button" className="icon-button" disabled={disabled || references > 0} title={references ? "请先从代理链中移除该组" : "删除代理组"} aria-label={`删除代理组 ${group.tag}`} onClick={() => onChange(groups.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
            <label className="gateway-proxy-group-url">测速地址<input type="url" value={group.url ?? "https://www.gstatic.com/generate_204"} disabled={disabled} onChange={(event) => update(index, { url: event.target.value })} /></label>
          </div>
          <div className="gateway-proxy-members" role="group" aria-label={`${group.tag} 成员`}>
            {members.map((tag) => <label key={tag}><input type="checkbox" checked={group.nodes.includes(tag)} disabled={disabled}
              onChange={(event) => update(index, { nodes: event.target.checked ? [...group.nodes, tag] : group.nodes.filter((member) => member !== tag) })} />{tag}{!nodes.some((node) => node.tag === tag) ? "（已移除）" : ""}</label>)}
          </div>
          {probe?.groups[group.tag]?.selected && <p className="gateway-hint">独立测速选择：{probe.groups[group.tag].selected}。链路实际选择可在下方各级查看。</p>}
        </details>;
      })}
    </div>
  </section>;
}
