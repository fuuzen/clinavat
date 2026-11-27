import { lookup } from 'node:dns/promises';
import { createConnection, isIP, isIPv4, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { HttpError } from '../models.js';

export type TargetKind = 'public' | 'private';
export type TargetPolicyReason = 'invalid_port' | 'invalid_host' | 'ipv6_unsupported' | 'dns_failed' | 'denied_target';

export interface ClassifiedTarget {
  kind: TargetKind;
  pinnedIp: string;
  port: number;
  hostname: string;
}

export interface CidrBlock {
  source: string;
  network: number;
  mask: number;
  prefix: number;
}

export interface SshTargetPolicyOptions {
  vmBridge?: string;
  gatewayHost?: string;
  extraDeny?: string[];
}

export class TargetPolicyError extends HttpError {
  constructor(statusCode: number, readonly reason: TargetPolicyReason, message: string) {
    super(statusCode, message);
  }
}

const builtinDenySpecs = [
  '127.0.0.0/8',
  '0.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

const privateSpecs = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
];

const gatewayCacheTtlMs = 60_000;

export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`无效的 IPv4 地址：${ip}`);
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) throw new Error(`无效的 IPv4 地址：${ip}`);
    const octet = Number(part);
    if (octet > 255) throw new Error(`无效的 IPv4 地址：${ip}`);
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

export function parseCidr(spec: string): CidrBlock {
  const trimmed = spec.trim();
  const [ipPart, prefixPart, extra] = trimmed.split('/');
  if (!ipPart || extra !== undefined || !isIPv4(ipPart)) {
    throw new Error(`无效的 IPv4 CIDR 配置：${spec}`);
  }
  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || (prefixPart !== undefined && !/^\d+$/.test(prefixPart))) {
    throw new Error(`无效的 IPv4 CIDR 前缀长度：${spec}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4ToInt(ipPart) & mask) >>> 0;
  return { source: trimmed, network, mask, prefix };
}

function matchesCidr(ipInt: number, block: CidrBlock): boolean {
  return ((ipInt & block.mask) >>> 0) === block.network;
}

const builtinDenyBlocks = builtinDenySpecs.map(parseCidr);
const privateBlocks = privateSpecs.map(parseCidr);

export function isPrivateIpv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const ipInt = ipv4ToInt(ip);
  return privateBlocks.some(block => matchesCidr(ipInt, block));
}

function hostLocalIpv4Set(): Set<number> {
  const addresses = new Set<number>();
  for (const entries of Object.values(networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) {
      if ((entry.family === 'IPv4' || (entry.family as unknown) === 4) && isIPv4(entry.address)) {
        addresses.add(ipv4ToInt(entry.address));
      }
    }
  }
  return addresses;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TargetPolicyError(400, 'invalid_port', '目标端口必须在 1 到 65535 之间');
  }
}

export class SshTargetPolicy {
  private readonly staticDenyBlocks: CidrBlock[];
  private readonly gatewayHostname?: string;
  private gatewayCache?: { blocks: CidrBlock[]; expiresAt: number };

  constructor(options: SshTargetPolicyOptions = {}) {
    const blocks: CidrBlock[] = [...builtinDenyBlocks];
    if (options.vmBridge) blocks.push(parseCidr(options.vmBridge));
    const gatewayHost = options.gatewayHost?.trim();
    if (gatewayHost) {
      if (isIPv4(gatewayHost)) blocks.push(parseCidr(`${gatewayHost}/24`));
      else this.gatewayHostname = gatewayHost;
    }
    for (const entry of options.extraDeny ?? []) {
      const trimmed = entry.trim();
      if (trimmed) blocks.push(parseCidr(trimmed));
    }
    this.staticDenyBlocks = blocks;
  }

  async classifyTarget(hostname: string, port: number): Promise<ClassifiedTarget> {
    assertValidPort(port);
    const trimmed = hostname.trim();
    if (!trimmed || trimmed.length > 253 || /[\s\0]/.test(trimmed)) {
      throw new TargetPolicyError(400, 'invalid_host', '目标主机名或 IP 地址格式无效');
    }
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || trimmed.includes(':') || isIP(trimmed) === 6) {
      throw new TargetPolicyError(400, 'ipv6_unsupported', '首版仅支持 IPv4 地址或解析为 IPv4 的域名，暂不支持 IPv6');
    }

    let candidates: string[];
    if (isIPv4(trimmed)) {
      candidates = [trimmed];
    } else {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(trimmed)) {
        throw new TargetPolicyError(400, 'invalid_host', '目标主机名格式无效');
      }
      candidates = await this.resolveIpv4(trimmed);
    }

    const denyBlocks = await this.effectiveDenyBlocks();
    const localIps = hostLocalIpv4Set();
    for (const ip of candidates) {
      this.assertIpNotDenied(ip, denyBlocks, localIps);
    }

    const pinnedIp = candidates[0]!;
    return {
      kind: isPrivateIpv4(pinnedIp) ? 'private' : 'public',
      pinnedIp,
      port,
      hostname: trimmed,
    };
  }

  async assertNotDenied(ip: string): Promise<void> {
    if (!isIPv4(ip)) {
      throw new TargetPolicyError(400, 'invalid_host', '目标必须为合法的 IPv4 地址');
    }
    const denyBlocks = await this.effectiveDenyBlocks();
    this.assertIpNotDenied(ip, denyBlocks, hostLocalIpv4Set());
  }

  async dialAuthorizedTcp(pinnedIp: string, port: number, timeoutMs = 10_000): Promise<Socket> {
    assertValidPort(port);
    await this.assertNotDenied(pinnedIp);
    return dialAuthorizedTcp(pinnedIp, port, timeoutMs);
  }

  private assertIpNotDenied(ip: string, denyBlocks: CidrBlock[], localIps: Set<number>): void {
    const ipInt = ipv4ToInt(ip);
    if (localIps.has(ipInt)) {
      throw new TargetPolicyError(403, 'denied_target', `禁止连接宿主机本机地址 ${ip}`);
    }
    const matched = denyBlocks.find(block => matchesCidr(ipInt, block));
    if (matched) {
      throw new TargetPolicyError(403, 'denied_target', `禁止连接受保护或保留网段地址 ${ip}（命中规则 ${matched.source}）`);
    }
  }

  private async effectiveDenyBlocks(): Promise<CidrBlock[]> {
    if (!this.gatewayHostname) return this.staticDenyBlocks;
    const now = Date.now();
    if (this.gatewayCache && this.gatewayCache.expiresAt > now) {
      return [...this.staticDenyBlocks, ...this.gatewayCache.blocks];
    }
    try {
      const resolved = await lookup(this.gatewayHostname, { family: 4, all: true });
      const blocks = resolved.filter(entry => entry.family === 4 && isIPv4(entry.address))
        .map(entry => parseCidr(`${entry.address}/24`));
      this.gatewayCache = { blocks, expiresAt: now + gatewayCacheTtlMs };
      return [...this.staticDenyBlocks, ...blocks];
    } catch {
      throw new TargetPolicyError(503, 'dns_failed', `无法解析上游网关地址 ${this.gatewayHostname}，已拒绝本次目标判定`);
    }
  }

  private async resolveIpv4(hostname: string): Promise<string[]> {
    try {
      const records = await lookup(hostname, { family: 4, all: true });
      const unique: string[] = [];
      for (const record of records) {
        if (record.family === 4 && isIPv4(record.address) && !unique.includes(record.address)) {
          unique.push(record.address);
        }
      }
      if (!unique.length) {
        throw new TargetPolicyError(422, 'dns_failed', `域名 ${hostname} 未解析到有效的 IPv4 地址（首版仅支持 IPv4）`);
      }
      return unique;
    } catch (error) {
      if (error instanceof TargetPolicyError) throw error;
      throw new TargetPolicyError(422, 'dns_failed', `无法解析域名 ${hostname} 的 IPv4 地址（首版仅支持 IPv4）`);
    }
  }
}

/** Dials an already-validated numeric IPv4 address directly without any DNS lookup. */
export function dialAuthorizedTcp(pinnedIp: string, port: number, timeoutMs = 10_000): Promise<Socket> {
  assertValidPort(port);
  if (!isIPv4(pinnedIp)) {
    return Promise.reject(new TargetPolicyError(400, 'invalid_host', '拨号目标必须是已校验的数字 IPv4 地址'));
  }
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({
      host: pinnedIp,
      port,
      family: 4,
      autoSelectFamily: false,
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options?.all) {
          callback(null, [{ address: pinnedIp, family: 4 }]);
        } else {
          callback(null, pinnedIp, 4);
        }
      },
    });

    let settled = false;
    const swallowError = () => undefined;
    const guardLateErrors = () => {
      if (socket.closed) return;
      socket.on('error', swallowError);
      socket.once('close', () => socket.off('error', swallowError));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      // Keep an error guard across the async handoff until the caller attaches its own listeners or closes the socket.
      guardLateErrors();
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      guardLateErrors();
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      guardLateErrors();
      cleanup();
      const error = new Error(`连接目标 ${pinnedIp}:${port} 超时（${timeoutMs}ms）`);
      socket.destroy();
      reject(error);
    }, timeoutMs);
    timer.unref();

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}
