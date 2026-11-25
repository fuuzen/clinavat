export interface HostApprovalHint {
  id: string;
  hostname: string;
  pinned_ip: string;
  port: number;
  status: string;
  hop: string;
}

export interface HostConnection {
  status: string;
  fingerprint?: string;
  jumpFingerprint?: string;
  message?: string;
  pendingApproval?: boolean;
  viaRelay?: boolean;
  approval?: HostApprovalHint;
}

export function hostConnectionMessage(name: string, connection: HostConnection) {
  if (connection.pendingApproval) {
    return connection.message || `${name} 等待管理员审批内网访问`;
  }
  const relayHint = connection.viaRelay ? "（已通过安全中继连通）" : "";
  if (!connection.fingerprint) return `${name} 已连接${relayHint}`;
  const fingerprints = [`开发机指纹 ${connection.fingerprint}`];
  if (connection.jumpFingerprint) fingerprints.push(`跳板机指纹 ${connection.jumpFingerprint}`);
  return `连接成功${relayHint} · ${fingerprints.join("；")}`;
}
