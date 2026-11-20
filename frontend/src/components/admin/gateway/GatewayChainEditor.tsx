import { ArrowDown, ArrowRight, ArrowUp, Link2, Plus, Trash2 } from "lucide-react";
import type { GatewayProxyNode } from "./GatewayNodeList";
import { chainSteps, type GatewayPreproxyState, type GatewayProxyProbe } from "./gateway-proxy-state";

export default function GatewayChainEditor({ exits, preproxy, applied, probe, disabled, onChange }: {
  exits: GatewayProxyNode[]; preproxy: GatewayPreproxyState; applied: GatewayPreproxyState;
  probe: GatewayProxyProbe | null; disabled: boolean;
  onChange: (routes: GatewayPreproxyState["routes"]) => void;
}) {
  const choices = [...preproxy.groups.map((group) => ({ tag: group.tag, members: group.nodes, kind: "group" })),
    ...preproxy.nodes.map((node) => ({ tag: node.tag, members: [node.tag], kind: "node" }))];
  const members = (tag: string) => choices.find((choice) => choice.tag === tag)?.members ?? [];

  function update(exit: string, steps: string[]) {
    const routes = { ...preproxy.routes };
    if (steps.length) routes[exit] = steps; else delete routes[exit];
    onChange(routes);
  }

  return <section className="admin-card gateway-section gateway-chain-editor">
    <div className="admin-card-heading"><div><Link2 size={16} /><h3>多级代理链</h3></div><span className="gateway-hint">按真实流量顺序配置 · 最多 8 级前置</span></div>
    <p className="gateway-description">从左到右依次经过前置节点或自动组，最后到达落地节点。网站看到的是落地节点的出口 IP；组内仍会自动选择和故障转移。上下移动可调整经过顺序。</p>
    <div className="gateway-chain-list">
      {exits.map((exit) => {
        const steps = chainSteps(preproxy.routes[exit.tag]);
        const liveSteps = chainSteps(applied.routes[exit.tag]);
        const changed = JSON.stringify(steps) !== JSON.stringify(liveSteps);
        const used = new Set(steps.flatMap(members));
        const next = choices.find((choice) => choice.members.length && choice.members.every((member) => !used.has(member)));
        function move(index: number, offset: number) {
          const updated = [...steps];
          [updated[index], updated[index + offset]] = [updated[index + offset], updated[index]];
          update(exit.tag, updated);
        }
        return <article className="gateway-chain-card" key={exit.tag}>
          <div className="gateway-chain-heading"><strong>{exit.tag}</strong><span className={`admin-status${changed ? " warning" : ""}`}>{changed ? "链路有草稿更改" : "链路与生效配置一致"}</span></div>
          <div className="gateway-chain-preview" aria-label={`${exit.tag} 的流量顺序`}>
            <span className="gateway-chain-endpoint">设备</span>
            {steps.map((tag, index) => <span className="gateway-chain-fragment" key={index}>
              <ArrowRight size={14} aria-hidden="true" /><span className={`gateway-chain-hop${!choices.some((choice) => choice.tag === tag) ? " invalid" : ""}`}>
                <small>前置 {index + 1} · {preproxy.groups.some((group) => group.tag === tag) ? "自动组" : "节点"}</small><strong>{tag || "未选择"}</strong>
              </span>
            </span>)}
            <ArrowRight size={14} aria-hidden="true" /><span className="gateway-chain-hop landing"><small>落地节点</small><strong>{exit.tag}</strong></span>
            <ArrowRight size={14} aria-hidden="true" /><span className="gateway-chain-endpoint">目标网站</span>
          </div>
          <p className="gateway-hint gateway-chain-live">生效中：{["设备", ...liveSteps, exit.tag, "目标网站"].join(" → ")}</p>
          <div className="gateway-chain-steps">
            {steps.map((tag, index) => {
              const others = new Set(steps.filter((_, position) => position !== index).flatMap(members));
              const selected = !changed ? probe?.chains?.[exit.tag]?.[index]?.selected : null;
              return <div className="gateway-chain-step" key={index}>
                <span className="gateway-chain-step-number">{index + 1}</span>
                <label><select aria-label={`${exit.tag} 的第 ${index + 1} 级前置`} value={tag} disabled={disabled} onChange={(event) => update(exit.tag, steps.map((step, position) => position === index ? event.target.value : step))}>
                    {!choices.some((choice) => choice.tag === tag) && <option value={tag}>{tag || "请选择"}（缺失）</option>}
                    <optgroup label="自动代理组">{preproxy.groups.map((group) => <option key={group.tag} value={group.tag} disabled={group.tag !== tag && group.nodes.some((member) => others.has(member))}>{group.tag}（{group.nodes.length} 个成员）</option>)}</optgroup>
                    <optgroup label="前置节点">{preproxy.nodes.map((node) => <option key={node.tag} value={node.tag} disabled={node.tag !== tag && others.has(node.tag)}>{node.tag}</option>)}</optgroup>
                  </select>
                </label>
                <div className="gateway-chain-step-actions">
                  <button type="button" className="icon-button" disabled={disabled || index === 0} aria-label={`${exit.tag} 第 ${index + 1} 级上移`} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
                  <button type="button" className="icon-button" disabled={disabled || index === steps.length - 1} aria-label={`${exit.tag} 第 ${index + 1} 级下移`} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
                  <button type="button" className="icon-button" disabled={disabled} aria-label={`移除 ${exit.tag} 第 ${index + 1} 级`} onClick={() => update(exit.tag, steps.filter((_, position) => position !== index))}><Trash2 size={14} /></button>
                </div>
                {selected && <small className="gateway-chain-selected">运行中选择：{selected}</small>}
              </div>;
            })}
          </div>
          <div className="gateway-chain-add"><button type="button" className="button button-secondary button-small" disabled={disabled || steps.length >= 8 || !next}
            onClick={() => { if (next) update(exit.tag, [...steps, next.tag]); }}><Plus size={14} />添加一级前置</button>
            {!steps.length && <span className="gateway-hint">当前直接连接落地节点。</span>}
            {steps.length > 0 && !next && <span className="gateway-hint">其余节点已在链中使用；同一链不能重复经过同一成员。</span>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
