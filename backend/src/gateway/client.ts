import { access, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { KeyStore } from '../runtime/keys.js';
import { atomicWrite, checkedCommand, runCommand } from '../runtime/process.js';
import { HttpError } from '../models.js';

export type GatewayTarget = NonNullable<Config['gateway']>;
export const gwctlPath = '/usr/local/lib/cc-pool-gw/gwctl.py';

/** Calls the gateway controller through its forced-command SSH key; one JSON request per connection. */
export class GatewayClient {
  private readonly directory: string;
  private readonly runtime: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: Config, private readonly keys: KeyStore) {
    this.directory = join(config.dataDir, 'gateway');
    this.runtime = join(config.dataDir, 'run', 'gateway');
  }

  get target(): GatewayTarget | undefined { return this.config.gateway; }

  private requireTarget(): GatewayTarget {
    if (!this.config.gateway) throw new HttpError(409, '未配置网关地址（CLINAVAT_GATEWAY_HOST）');
    return this.config.gateway;
  }

  private get knownHosts() { return join(this.directory, 'known_hosts'); }

  /** The Hub's dedicated gateway key, separate from every user's development host keys. */
  async publicKey(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const privateKeyPath = await this.identity();
    return (await checkedCommand(this.config.sshKeygenBinary, ['-y', '-P', '', '-f', privateKeyPath])).stdout.trim();
  }

  private async identity(): Promise<string> {
    await mkdir(this.runtime, { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const privateKeyPath = join(this.runtime, 'id_ed25519');
    const encryptedPath = join(this.directory, 'id_ed25519.enc');
    try { await access(encryptedPath); } catch {
      await rm(privateKeyPath, { force: true });
      await checkedCommand(this.config.sshKeygenBinary, ['-q', '-t', 'ed25519', '-N', '', '-C', 'clinavat-gateway', '-f', privateKeyPath]);
      await atomicWrite(encryptedPath, this.keys.encrypt(await readFile(privateKeyPath, 'utf8')));
      await rm(`${privateKeyPath}.pub`, { force: true });
      return privateKeyPath;
    }
    await atomicWrite(privateKeyPath, this.keys.decrypt(await readFile(encryptedPath, 'utf8')));
    await chmod(privateKeyPath, 0o600);
    return privateKeyPath;
  }

  async fingerprint(): Promise<string | null> {
    const result = await runCommand(this.config.sshKeygenBinary, ['-l', '-f', this.knownHosts], { timeout: 5000 }).catch(() => undefined);
    if (!result || result.code !== 0) return null;
    return result.stdout.trim().split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean).join(', ') || null;
  }

  async call<T>(op: string, args: Record<string, unknown> = {}, timeout = 60_000): Promise<T> {
    const target = this.requireTarget();
    const identity = await this.identity();
    const result = await runCommand(this.config.sshBinary, [
      '-F', '/dev/null', '-i', identity, '-p', String(target.port),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
      // First use pins the host key; a changed key is refused afterwards.
      '-o', `UserKnownHostsFile=${this.knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=accept-new',
      '-T', `${target.username}@${target.host}`,
    ], { input: JSON.stringify({ op, args }), timeout, maxBytes: 4 * 1024 * 1024 });
    const line = result.stdout.trim().split('\n').pop() ?? '';
    let response: { ok: boolean; result?: T; error?: string };
    try { response = JSON.parse(line); } catch {
      const detail = result.stderr.trim() || line || `ssh 退出码 ${result.code}`;
      if (/Permission denied/i.test(detail)) throw new HttpError(502, '网关拒绝了 Hub 密钥，请先在网关授权该公钥');
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(detail)) {
        throw new HttpError(502, '网关主机密钥与首次记录不一致，已拒绝连接');
      }
      throw new HttpError(502, `无法连接网关：${detail.slice(0, 500)}`);
    }
    if (!response.ok) throw new HttpError(409, response.error ?? '网关返回未知错误');
    return response.result as T;
  }

  /** Mutations run one at a time so the gateway never sees two pending revisions from the Hub. */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
