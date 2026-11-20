import type { GatewayProxyNode } from "./GatewayNodeList";

export interface GatewayProxyGroup { tag: string; nodes: string[]; url?: string; interval?: string; tolerance?: number }
export interface GatewayPreproxyState {
  nodes: GatewayProxyNode[]; groups: GatewayProxyGroup[]; routes: Record<string, string | string[]>;
}
export interface GatewayProxyDraft { nodes: GatewayProxyNode[]; preproxy: GatewayPreproxyState }
export interface GatewayProxyProbe {
  nodes: Record<string, number | null>;
  groups: Record<string, { selected: string | null; nodes: string[] }>;
  errors: Record<string, string>;
  chains?: Record<string, { tag: string; selected?: string | null; nodes?: string[] }[]>;
}
export const emptyPreproxy: GatewayPreproxyState = { nodes: [], groups: [], routes: {} };
export const tagPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function chainSteps(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

export function proxyDraft(nodes: GatewayProxyNode[], preproxy?: GatewayPreproxyState): GatewayProxyDraft {
  return JSON.parse(JSON.stringify({ nodes, preproxy: preproxy ?? emptyPreproxy })) as GatewayProxyDraft;
}

export function validateProxyDraft(draft: GatewayProxyDraft): string[] {
  const { nodes, preproxy } = draft;
  const problems: string[] = [];
  if (!nodes.length) problems.push("至少保留一个落地节点。");
  if (nodes.length > 64 || preproxy.nodes.length > 64) problems.push("落地节点和前置节点分别最多 64 个。");
  if (preproxy.groups.length > 16) problems.push("自动代理组最多 16 个。");
  const front = new Map(preproxy.nodes.map((node) => [node.tag, node]));
  const groups = new Map(preproxy.groups.map((group) => [group.tag, group]));
  const allTags = [...nodes.map((node) => node.tag), ...front.keys(), ...groups.keys()];
  if (new Set(allTags).size !== nodes.length + preproxy.nodes.length + preproxy.groups.length) problems.push("节点与代理组的标识不能重复。");
  for (const tag of allTags) {
    if (!tagPattern.test(tag) || ["proxy", "direct", "block", "dns", "tun-in", "unbound", "proxy-dns"].includes(tag)
      || ["src-", "dns-", "chain-"].some((prefix) => tag.startsWith(prefix))) problems.push(`标识「${tag || "空"}」无效或为系统保留名称。`);
  }
  for (const group of preproxy.groups) {
    if (!group.nodes.length) problems.push(`代理组 ${group.tag} 至少需要一个前置节点。`);
    if (new Set(group.nodes).size !== group.nodes.length) problems.push(`代理组 ${group.tag} 有重复成员。`);
    if (group.nodes.some((tag) => !front.has(tag))) problems.push(`代理组 ${group.tag} 引用了不存在的前置节点。`);
    if (!/^(?:[1-9][0-9]*)(?:s|m|h)$/.test(group.interval ?? "30s")) problems.push(`代理组 ${group.tag} 的测速间隔格式无效，例如 30s、3m。`);
    else {
      const match = (group.interval ?? "30s").match(/^([0-9]+)(s|m|h)$/)!;
      const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]] ?? 0);
      if (seconds < 10 || seconds > 3600) problems.push(`代理组 ${group.tag} 的测速间隔需在 10s 到 1h 之间。`);
    }
    if (!Number.isInteger(group.tolerance ?? 50) || (group.tolerance ?? 50) < 0 || (group.tolerance ?? 50) > 10000) problems.push(`代理组 ${group.tag} 的切换容差需为 0 到 10000 毫秒。`);
    try {
      const url = new URL(group.url ?? "https://www.gstatic.com/generate_204");
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch { problems.push(`代理组 ${group.tag} 的测速地址需为不含认证信息的 HTTPS 地址。`); }
  }
  for (const [exit, value] of Object.entries(preproxy.routes)) {
    if (!nodes.some((node) => node.tag === exit)) problems.push(`代理链引用了不存在的落地节点 ${exit}。`);
    const chain = chainSteps(value);
    if (chain.length > 8) problems.push(`${exit} 的前置链最多 8 级。`);
    const seen = new Set<string>();
    for (const tag of chain) {
      const members = front.has(tag) ? [tag] : groups.get(tag)?.nodes;
      if (!members) { problems.push(`${exit} 的代理链中「${tag || "未选择"}」不存在。`); continue; }
      if (members.some((member) => seen.has(member))) problems.push(`${exit} 的代理链重复经过同一节点或有成员重叠的组。`);
      members.forEach((member) => seen.add(member));
    }
  }
  return [...new Set(problems)];
}
