import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RotateCcw, Save, Zap } from "lucide-react";
import { api, errorText } from "../../../api";
import GatewayNodeList, { type GatewayProxyNode } from "./GatewayNodeList";
import GatewayChainEditor from "./GatewayChainEditor";
import GatewayGroupEditor from "./GatewayGroupEditor";
import { chainSteps, proxyDraft, validateProxyDraft, type GatewayPreproxyState, type GatewayProxyDraft, type GatewayProxyProbe } from "./gateway-proxy-state";
import "../../../styles/admin-gateway-proxies.css";

export default function GatewayProxyConfiguration({ nodes, preproxy, selected, boundTags, disabled, revision, onApply, onSelect, onDirtyChange }: {
  nodes: GatewayProxyNode[]; preproxy?: GatewayPreproxyState; selected: string; boundTags: string[]; disabled: boolean; revision?: string;
  onApply: (draft: GatewayProxyDraft & { expected_revision?: string }) => Promise<boolean>;
  onSelect: (tag: string) => Promise<unknown>; onDirtyChange: (dirty: boolean) => void;
}) {
  const saved = JSON.stringify(proxyDraft(nodes, preproxy));
  const [draft, setDraft] = useState<GatewayProxyDraft>(() => JSON.parse(saved));
  const [baseline, setBaseline] = useState(saved);
  const baselineRevision = useRef(revision);
  const [resetGeneration, setResetGeneration] = useState(0);
  const [nodeEditing, setNodeEditing] = useState({ exit: false, front: false });
  const [probe, setProbe] = useState<GatewayProxyProbe | null>(null);
  const [delays, setDelays] = useState<Record<string, number | null> | null>(null);
  const [probing, setProbing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== baseline;
  const editing = nodeEditing.exit || nodeEditing.front;
  const changed = dirty || editing;
  const remoteChanged = saved !== baseline || revision !== baselineRevision.current;
  const problems = validateProxyDraft(draft);
  const locked = disabled || probing || applying;
  const latest = useRef({ saved, revision });
  latest.current = { saved, revision };
  useEffect(() => {
    if (!remoteChanged || changed || applying) return;
    setDraft(JSON.parse(saved)); setBaseline(saved); baselineRevision.current = revision; setProbe(null);
  }, [saved, revision, baseline, changed, applying, remoteChanged]);
  useEffect(() => { onDirtyChange(changed); }, [changed, onDirtyChange]);
  useEffect(() => {
    if (!changed) return;
    const beforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeLeave);
    return () => window.removeEventListener("beforeunload", beforeLeave);
  }, [changed]);
  function restore() {
    const value = latest.current;
    setDraft(JSON.parse(value.saved)); setBaseline(value.saved); baselineRevision.current = value.revision;
    setNodeEditing({ exit: false, front: false }); setResetGeneration((current) => current + 1); setError(""); setProbe(null);
  }
  function updateNodes(kind: "exit" | "front", updated: GatewayProxyNode[]) {
    setDraft((current) => {
      if (kind === "front") return { ...current, preproxy: { ...current.preproxy, nodes: updated } };
      const tags = new Set(updated.map((node) => node.tag));
      return { nodes: updated, preproxy: { ...current.preproxy, routes: Object.fromEntries(Object.entries(current.preproxy.routes).filter(([tag]) => tags.has(tag))) } };
    });
  }
  function renameGroup(previous: string, next: string) {
    setDraft((current) => ({ ...current, preproxy: { ...current.preproxy,
      routes: Object.fromEntries(Object.entries(current.preproxy.routes).map(([tag, route]) => [tag, chainSteps(route).map((step) => step === previous ? next : step)])) } }));
  }
  async function test() {
    setProbing(true); setError("");
    try {
      const [front, exit] = await Promise.all([
        api<GatewayProxyProbe>("/admin/gateway/preproxy/delay", { method: "POST", body: "{}" }),
        api<Record<string, number | null>>("/admin/gateway/delay", { method: "POST", body: "{}" }),
      ]);
      setProbe(front); setDelays(exit);
    } catch (cause) { setError(`测速失败：${errorText(cause)}`); }
    finally { setProbing(false); }
  }
  async function apply() {
    setError(""); setApplying(true);
    try {
      if (await onApply({ ...draft, ...(baselineRevision.current ? { expected_revision: baselineRevision.current } : {}) })) restore();
    } catch (cause) { setError(errorText(cause)); }
    finally { setApplying(false); }
  }
  const frontInUse = [...new Set([...draft.preproxy.groups.flatMap((group) => group.nodes), ...Object.values(draft.preproxy.routes).flatMap(chainSteps)])];
  const groupTags = draft.preproxy.groups.map((group) => group.tag);
  return <div className="gateway-proxy-configuration">
    <section className="admin-card gateway-proxy-draft-summary">
      <div><strong>节点与链路统一配置</strong><p>逐个编辑节点，选择代理组，再安排每一级的流量顺序。所有修改先加入草稿，最后一次应用。</p></div>
      <span className={`admin-status${changed ? " warning" : " success"}`}>{changed ? "有尚未应用的更改" : "已与网关同步"}</span>
      <button type="button" className="button button-secondary button-small" disabled={locked || changed} onClick={() => void test()}>{probing ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}测试已生效节点</button>
    </section>
    {remoteChanged && changed && <p className="gateway-proxy-notice" role="status">网关上的节点配置已发生变化，你的草稿已保留。请放弃草稿后载入最新配置，再重新编辑。</p>}
    <section className="admin-card gateway-section">
      <GatewayNodeList key={`exit-${resetGeneration}`} title="落地节点" description="作为网站最终看到的出口。编辑节点后保存到草稿，可继续修改它的前置链，再统一应用。已被来源绑定或规则使用的节点需先解除引用才能删除。"
        nodes={draft.nodes} occupiedTags={[...draft.preproxy.nodes.map((node) => node.tag), ...groupTags]} lockedTags={[selected, ...boundTags]} disabled={locked}
        onChange={(updated) => updateNodes("exit", updated)} onDirtyChange={(value) => setNodeEditing((current) => ({ ...current, exit: value }))}
        renderNodeMeta={(node) => <>{node.tag === selected && <span className="admin-status success">共享出口当前选择</span>}{delays && Object.hasOwn(delays, node.tag) && <span className="gateway-delay">{delays[node.tag] === null ? "不可用" : `${delays[node.tag]} ms`}</span>}</>}
        renderNodeActions={(node) => nodes.some((item) => item.tag === node.tag) && node.tag !== selected
          ? <button type="button" className="button button-ghost button-small" disabled={locked || changed} onClick={() => void onSelect(node.tag)}>设为共享出口</button> : null} />
    </section>
    <section className="admin-card gateway-section">
      <GatewayNodeList key={`front-${resetGeneration}`} title="前置节点" description="可作为链路中的一级，也可加入自动代理组。节点与组可以在多条链中复用，每条链的顺序独立生效。删除前请先从组和链中移除引用。"
        nodes={draft.preproxy.nodes} occupiedTags={[...draft.nodes.map((node) => node.tag), ...groupTags]} lockedTags={frontInUse} disabled={locked}
        onChange={(updated) => updateNodes("front", updated)} onDirtyChange={(value) => setNodeEditing((current) => ({ ...current, front: value }))}
        renderNodeMeta={(node) => probe && Object.hasOwn(probe.nodes, node.tag) ? <span className="gateway-delay" title={Object.hasOwn(probe.errors, node.tag) ? probe.errors[node.tag] : undefined}>{probe.nodes[node.tag] === null ? "独立测速不可用" : `独立测速 ${probe.nodes[node.tag]} ms`}</span> : null} />
    </section>
    <GatewayGroupEditor key={`groups-${resetGeneration}`} groups={draft.preproxy.groups} nodes={draft.preproxy.nodes} exits={draft.nodes} routes={draft.preproxy.routes} probe={probe} disabled={locked || editing}
      onChange={(groups) => setDraft((current) => ({ ...current, preproxy: { ...current.preproxy, groups } }))} onRename={renameGroup} />
    <GatewayChainEditor exits={draft.nodes} preproxy={draft.preproxy} applied={proxyDraft(nodes, preproxy).preproxy} probe={probe} disabled={locked || editing}
      onChange={(routes) => setDraft((current) => ({ ...current, preproxy: { ...current.preproxy, routes } }))} />
    <section className="admin-card gateway-proxy-apply">
      <div className="gateway-proxy-apply-copy"><strong>{changed ? "统一应用节点和代理链" : "配置已生效"}</strong><p>一次提交会同时更新所有节点、代理组与链路，重启 sing-box。健康检查失败会回滚，前置切换可能中断已有链式连接。</p></div>
      {editing && <p className="gateway-field-error" role="status">还有节点正在编辑，请先保存到草稿或取消编辑。</p>}
      {problems.length > 0 && <div className="gateway-proxy-problems" role="alert">{problems.map((problem) => <p key={problem}>{problem}</p>)}</div>}
      {error && <p className="gateway-field-error" role="alert">{error}</p>}
      <div className="gateway-editor-actions"><button type="button" className="button button-ghost button-small" disabled={locked || !changed} onClick={restore}><RotateCcw size={14} />{remoteChanged ? "放弃草稿并载入最新配置" : "放弃全部草稿"}</button>
        <button type="button" className="button button-primary button-small" disabled={locked || !dirty || editing || problems.length > 0 || remoteChanged} onClick={() => void apply()}>{applying ? <LoaderCircle size={14} className="spin" /> : dirty ? <Save size={14} /> : <Check size={14} />}应用全部更改</button>
      </div>
    </section>
  </div>;
}
