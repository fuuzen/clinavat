import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import GatewayNodeEditor from "./GatewayNodeEditor";
import { protocolNode, withoutMasks, type GatewayProxyNode } from "./gateway-node-config";
import "../../../styles/admin-gateway-nodes.css";
export type { GatewayProxyNode } from "./gateway-node-config";

interface NodeChange { renamed?: { from: string; to: string }; deleted?: string }
interface EditingNode { node: GatewayProxyNode; originalTag?: string; copied?: boolean; key: number }

export default function GatewayNodeList({ title, description, nodes, disabled, occupiedTags = [], lockedTags = [], selected, delays,
  onSelect, onChange, onDirtyChange, renderNodeMeta, renderNodeActions }: {
  title: string; description?: string; nodes: GatewayProxyNode[]; disabled: boolean; occupiedTags?: string[]; lockedTags?: string[];
  selected?: string; delays?: Record<string, number | null>; onSelect?: (tag: string) => void;
  onChange: (nodes: GatewayProxyNode[], change?: NodeChange) => void; onDirtyChange?: (dirty: boolean) => void;
  renderNodeMeta?: (node: GatewayProxyNode) => ReactNode; renderNodeActions?: (node: GatewayProxyNode) => ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("");
  const [editor, setEditor] = useState<EditingNode | null>(null);
  const editing = editor !== null;
  const dirtyListener = useRef(onDirtyChange);
  dirtyListener.current = onDirtyChange;
  useEffect(() => { dirtyListener.current?.(editing); }, [editing]);
  const query = search.trim().toLowerCase();
  const filtered = nodes.filter((node) => (!protocol || node.type === protocol)
    && (!query || [node.tag, node.type, node.server, node.server_port].join(" ").toLowerCase().includes(query)));
  const protocols = [...new Set(nodes.map((node) => node.type))].sort();
  const locked = disabled || editing;

  function edit(node: GatewayProxyNode) { setEditor({ node: structuredClone(node), originalTag: node.tag, key: Date.now() }); }
  function duplicate(node: GatewayProxyNode) {
    const occupied = new Set([...occupiedTags, ...nodes.map((item) => item.tag)]);
    let suffix = "-copy";
    let tag = node.tag.slice(0, 64 - suffix.length) + suffix;
    for (let index = 2; occupied.has(tag); index++) { suffix = `-copy-${index}`; tag = node.tag.slice(0, 64 - suffix.length) + suffix; }
    setEditor({ node: { ...withoutMasks(node) as GatewayProxyNode, tag }, copied: true, key: Date.now() });
  }
  function save(node: GatewayProxyNode) {
    const next = editor?.originalTag ? nodes.map((item) => item.tag === editor.originalTag ? node : item) : [...nodes, node];
    onChange(next);
    setEditor(null);
  }
  return <div className="gateway-node-list">
    <div className="gateway-node-list-heading"><div><h4>{title}<span>{nodes.length}</span></h4>{description && <p className="gateway-hint">{description}</p>}</div>
      <button type="button" className="button button-secondary button-small" disabled={locked} onClick={() => setEditor({ node: protocolNode("shadowsocks"), key: Date.now() })}><Plus size={14} />新增节点</button>
    </div>
    <div className="gateway-node-list-filter"><label><Search size={14} /><input type="search" aria-label={`搜索${title}`} placeholder="搜索名称、服务器或协议" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <select aria-label={`筛选${title}协议`} value={protocol} onChange={(event) => setProtocol(event.target.value)}><option value="">全部协议</option>{protocols.map((type) => <option key={type} value={type}>{type}</option>)}</select>
      {(query || protocol) && <span>{filtered.length} / {nodes.length} 个节点</span>}
    </div>
    {editor && <GatewayNodeEditor key={editor.key} initial={editor.node} originalTag={editor.originalTag} copied={editor.copied}
      occupiedTags={[...occupiedTags, ...nodes.filter((node) => node.tag !== editor.originalTag).map((node) => node.tag)]}
      disabled={disabled} onSave={save} onCancel={() => setEditor(null)} />}
    <div className="gateway-node-cards">
      {filtered.map((node) => <article className={`gateway-node-card${selected === node.tag ? " selected" : ""}`} key={node.tag}>
        <div className="gateway-node-card-identity"><div><strong>{node.tag}</strong><span className="gateway-node-protocol">{node.type}</span>{selected === node.tag && <span className="admin-status success"><Check size={11} />当前共享出口</span>}</div>
          <code>{node.server}:{node.server_port}</code>
          {renderNodeMeta?.(node)}
        </div>
        {delays && Object.hasOwn(delays, node.tag) && <span className={`gateway-node-card-delay${delays[node.tag] === null ? " unavailable" : ""}`}>{delays[node.tag] === null ? "不可用" : `${delays[node.tag]} ms`}</span>}
        <div className="gateway-node-card-actions">
          {onSelect && selected !== node.tag && <button type="button" className="button button-ghost button-small" disabled={locked} onClick={() => onSelect(node.tag)}>设为共享出口</button>}
          {renderNodeActions?.(node)}
          <button type="button" className="button button-ghost button-small" disabled={locked} onClick={() => edit(node)} aria-label={`编辑节点 ${node.tag}`}><Pencil size={13} />编辑</button>
          <button type="button" className="icon-button" disabled={locked} onClick={() => duplicate(node)} aria-label={`复制节点 ${node.tag}`} title="复制为新节点"><Copy size={14} /></button>
          <button type="button" className="icon-button" disabled={locked || lockedTags.includes(node.tag)} onClick={() => onChange(nodes.filter((item) => item.tag !== node.tag), { deleted: node.tag })}
            aria-label={`删除节点 ${node.tag}`} title={lockedTags.includes(node.tag) ? "此节点仍被来源、代理组或链路引用，请先移除引用" : "从草稿删除节点"}><Trash2 size={14} /></button>
        </div>
      </article>)}
      {!filtered.length && <p className="gateway-node-empty">{nodes.length ? "没有匹配的节点。" : "暂无节点，点击「新增节点」添加。"}</p>}
    </div>
  </div>;
}
