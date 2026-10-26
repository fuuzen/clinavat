export interface HostConnection {
  status: string;
  fingerprint?: string;
  jumpFingerprint?: string;
}

export function hostConnectionMessage(name: string, connection: HostConnection) {
  if (!connection.fingerprint) return `${name} 已连接`;
  const fingerprints = [`开发机指纹 ${connection.fingerprint}`];
  if (connection.jumpFingerprint) fingerprints.push(`跳板机指纹 ${connection.jumpFingerprint}`);
  return `连接成功 · ${fingerprints.join("；")}`;
}
