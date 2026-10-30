import { isIP } from 'node:net';

export interface RuntimeConfig {
  dataDir: string;
  workspaceDir: string;
  encryptionKey: string;
  sshBinary?: string;
  scpBinary?: string;
  sshKeygenBinary?: string;
  mutagenBinary?: string;
}

export interface DevHost {
  id: string;
  user_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  kind?: 'ssh' | 'local';
  jump_host?: string | null;
  jump_port?: number | null;
  jump_username?: string | null;
}

export interface WorkspaceProject {
  id: string;
  user_id: string;
  dev_host_id: string;
  remote_path: string;
  local_path: string;
  sync_name: string;
  path_mode: 'auto' | 'direct' | 'bwrap' | 'symlink';
  execution_mode: 'direct' | 'bwrap' | 'symlink' | 'local' | null;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function assertIdentifier(value: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('无效的资源标识符');
}

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('命令参数包含无效字符');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function remoteBash(command: string): string {
  const encoded = Buffer.from(command).toString('base64');
  // The SSH login shell may be fish; only Bash decodes and interprets the command payload.
  return `bash -c 'eval "$(printf %s ${encoded} | base64 -d)"'`;
}

export function isValidSshHost(value: string): boolean {
  return value.length <= 253 && ((isIP(value) !== 0 && !value.includes('%'))
    || /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value));
}

export function assertHostOwner(userId: string, host: DevHost): void {
  assertIdentifier(userId);
  assertIdentifier(host.id);
  if (host.user_id !== userId) throw new Error('无权访问此开发机');
  if (host.kind === 'local') return;
  if (!isValidSshHost(host.host)) throw new Error('开发机地址格式无效');
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(host.username)) throw new Error('SSH 用户名格式无效');
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('SSH 端口无效');
  if (host.jump_host != null || host.jump_port != null || host.jump_username != null) {
    if (!host.jump_host || !isValidSshHost(host.jump_host)) throw new Error('跳板机地址格式无效');
    if (!host.jump_username || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(host.jump_username)) throw new Error('跳板机 SSH 用户名格式无效');
    if (!Number.isInteger(host.jump_port) || host.jump_port! < 1 || host.jump_port! > 65535) throw new Error('跳板机 SSH 端口无效');
  }
}

export function assertRemotePath(value: string): void {
  if (!value.startsWith('/') || /[\0\r\n]/.test(value) || value.length > 4096) {
    throw new Error('远端目录必须是有效的绝对路径');
  }
}
