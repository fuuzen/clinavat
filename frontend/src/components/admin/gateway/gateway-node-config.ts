export interface GatewayProxyNode {
  tag: string; type: string; server?: string; server_port?: number; [key: string]: unknown;
}

export const proxyProtocols = ["shadowsocks", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "anytls", "naive", "socks", "http"];
const reservedTags = new Set(["proxy", "direct", "block", "dns", "tun-in", "unbound", "proxy-dns"]);
const forbiddenFields = ["detour", "bind_interface", "inet4_bind_address", "inet6_bind_address", "routing_mark", "netns", "reuse_addr", "bind_address_no_port"];

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function fieldText(value: unknown): string { return typeof value === "string" ? value : ""; }

export function protocolNode(type: string, base?: GatewayProxyNode): GatewayProxyNode {
  const node: GatewayProxyNode = { tag: base?.tag ?? "", type, server: base?.server ?? "", server_port: base?.server_port ?? 443 };
  if (type === "shadowsocks") Object.assign(node, { method: "aes-256-gcm", password: "" });
  if (type === "vmess") Object.assign(node, { uuid: "", security: "auto", alter_id: 0 });
  if (["vless", "tuic"].includes(type)) node.uuid = "";
  if (["trojan", "hysteria2", "tuic", "anytls", "naive"].includes(type)) node.password = "";
  return node;
}

export function withoutMasks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMasks);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "***").map(([key, item]) => [key, withoutMasks(item)]));
  return value;
}

function hasMask(value: unknown): boolean {
  return value === "***" || (Array.isArray(value) ? value.some(hasMask) : !!value && typeof value === "object" && Object.values(value).some(hasMask));
}

export function validateNode(value: unknown, occupiedTags: string[], originalTag?: string): GatewayProxyNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("节点配置必须是单个 JSON 对象。");
  const node = value as GatewayProxyNode;
  if (typeof node.tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(node.tag)
      || reservedTags.has(node.tag) || /^(src-|dns-|chain-)/.test(node.tag)) throw new Error("节点标识需为 1–64 位字母、数字、点、下划线或连字符，且不能使用系统保留名。");
  if (originalTag && node.tag !== originalTag) throw new Error("已有节点的标识不能修改。可复制为新节点，再重新配置引用。");
  if (occupiedTags.includes(node.tag)) throw new Error(`节点标识 ${node.tag} 已被其他节点或代理组使用。`);
  if (!proxyProtocols.includes(node.type)) throw new Error("请选择受支持的代理协议。");
  if (typeof node.server !== "string" || !node.server.trim()) throw new Error("请填写服务器地址。");
  if (!Number.isInteger(node.server_port) || Number(node.server_port) < 1 || Number(node.server_port) > 65535) throw new Error("服务器端口应为 1–65535 的整数。");
  const forbidden = forbiddenFields.filter((key) => key in node);
  if (forbidden.length) throw new Error(`请在链路编辑器配置代理顺序；节点不允许设置 ${forbidden.join("、")}。`);
  if (!originalTag && hasMask(node)) throw new Error("新节点不能使用 *** 作为凭据，请填写真实密钥。");
  if (node.type === "shadowsocks" && (!fieldText(node.method) || !fieldText(node.password))) throw new Error("Shadowsocks 节点需要加密方法和密码。");
  if (["vmess", "vless", "tuic"].includes(node.type) && !fieldText(node.uuid)) throw new Error("该协议需要填写 UUID。");
  if (["trojan", "hysteria2", "tuic", "anytls", "naive"].includes(node.type) && !fieldText(node.password)) throw new Error("该协议需要填写密码。");
  return { ...node, server: node.server.trim() };
}
