import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionHost } from '../execution/types.js';
import { atomicWrite, runCommand } from './process.js';
import type { DevHost } from './types.js';

export interface SshHandshakeOptions {
  userId: string;
  configPath: string;
  existingKnownHostsPath: string;
  host: DevHost;
  alias: string;
  jump?: DevHost;
  jumpAlias?: string;
  sshBinary: string;
  sshKeygenBinary: string;
  execution?: ExecutionHost;
  containerKnownHostsPath?: string;
}

export interface SshHandshakeResult {
  knownHostsContent: string;
  hostLines: string[];
  jumpLines: string[];
  fingerprint: string;
  jumpFingerprint?: string;
}

export function endpointAddress(endpoint: DevHost): string {
  return `${endpoint.username}@${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
}

function knownHostsTarget(endpoint: DevHost): string {
  return endpoint.port === 22 ? endpoint.host : `[${endpoint.host}]:${endpoint.port}`;
}

export function fingerprintBuffers(keys: Buffer[]): string {
  return keys
    .map(key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`)
    .join(', ');
}

export function parseKnownHostKeyLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('@'));
}

export function keyBuffersFromLines(lines: string[]): Buffer[] {
  return lines
    .map(line => {
      const fields = line.split(/\s+/);
      return Buffer.from(fields[2] ?? '', 'base64');
    })
    .filter(key => key.length > 0);
}

export async function lookupKnownHostLines(sshKeygenBinary: string, knownHostsFile: string, endpoint: DevHost): Promise<string[]> {
  const result = await runCommand(sshKeygenBinary, ['-F', knownHostsTarget(endpoint), '-f', knownHostsFile], { timeout: 10_000 });
  if (result.code !== 0) return [];
  return parseKnownHostKeyLines(result.stdout);
}

function formatHandshakeError(heading: string, output: string, hasJump: boolean): Error {
  // At LogLevel ERROR the jump host's refusal to open the forwarded connection is reported only as this line.
  const hint = hasJump && output.includes('stdio forwarding failed')
    ? '\n跳板机已连接，但无法访问开发机地址和端口，请确认开发机地址填写的是跳板机可访问的地址，且端口已开放。'
    : '';
  return new Error(`${heading}：\n${output}${hint}`);
}

const containerHandshakeScript = String.raw`set -u
existing_kh="$1"
kh="$2"
cfg="$3"
target_alias="$4"
jump_alias="$5"
cleanup() { rm -f -- "$kh"; }
trap cleanup EXIT
umask 077
if [ -r "$existing_kh" ]; then
  cp -- "$existing_kh" "$kh" || exit 12
else
  : > "$kh" || exit 12
fi
chmod 600 "$kh" 2>/dev/null || true
if [ -n "$jump_alias" ]; then
  if ! ssh -F "$cfg" -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$kh" "$jump_alias" 'exit 0' >/dev/null; then
    exit 10
  fi
fi
if ! ssh -F "$cfg" -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$kh" "$target_alias" 'exit 0' >/dev/null; then
  exit 11
fi
cat -- "$kh"
`;

async function extractHandshakeResult(
  sshKeygenBinary: string,
  knownHostsContent: string,
  host: DevHost,
  jump?: DevHost,
): Promise<SshHandshakeResult> {
  const hostTempKh = join(tmpdir(), `clinavat-kh-${randomUUID()}.kh`);
  try {
    await writeFile(hostTempKh, knownHostsContent, { mode: 0o600, flag: 'wx' });
    const hostLines = await lookupKnownHostLines(sshKeygenBinary, hostTempKh, host);
    const jumpLines = jump ? await lookupKnownHostLines(sshKeygenBinary, hostTempKh, jump) : [];
    return {
      knownHostsContent,
      hostLines,
      jumpLines,
      fingerprint: fingerprintBuffers(keyBuffersFromLines(hostLines)),
      ...(jump ? { jumpFingerprint: fingerprintBuffers(keyBuffersFromLines(jumpLines)) } : {}),
    };
  } finally {
    await rm(hostTempKh, { force: true });
  }
}

export function temporaryContainerKnownHostsPath(prefix: 'probe' | 'connect'): string {
  return `/tmp/clinavat-${prefix}-${randomBytes(8).toString('hex')}.kh`;
}

/**
 * Executes an isolated SSH handshake (never mutating the user's production known_hosts).
 * In LXD mode the handshake runs inside the user's workspace container using a /tmp known_hosts file.
 */
export async function runIsolatedHandshake(options: SshHandshakeOptions): Promise<SshHandshakeResult> {
  const { userId, configPath, existingKnownHostsPath, host, alias, jump, jumpAlias, sshBinary, sshKeygenBinary, execution } = options;

  if (execution?.kind === 'vm') {
    await execution.ensureWorkspace(userId);
    const containerKh = options.containerKnownHostsPath ?? temporaryContainerKnownHostsPath('probe');
    const result = await execution.run(
      '/bin/bash',
      ['-c', containerHandshakeScript, 'clinavat-ssh-handshake', existingKnownHostsPath, containerKh, configPath, alias, jump && jumpAlias ? jumpAlias : ''],
      { scope: { userId, paths: [] }, timeout: jump ? 60_000 : 30_000 },
    );
    if (result.code === 10 && jump) {
      throw formatHandshakeError(`跳板机 ${endpointAddress(jump)} 连接失败`, (result.stderr || `ssh 退出码 ${result.code}`).trim().slice(0, 4000), false);
    }
    if (result.code === 11) {
      throw formatHandshakeError(
        `开发机 ${endpointAddress(host)} ${jump ? '经跳板机连接失败' : '连接失败'}`,
        (result.stderr || `ssh 退出码 ${result.code}`).trim().slice(0, 4000),
        Boolean(jump),
      );
    }
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || `容器内 SSH 探测失败（退出码 ${result.code}）`).trim().slice(0, 4000));
    }
    return extractHandshakeResult(sshKeygenBinary, result.stdout, host, jump);
  }

  const hostKh = options.containerKnownHostsPath ?? join(tmpdir(), `clinavat-probe-${randomUUID()}.kh`);
  const existing = await readFile(existingKnownHostsPath, 'utf8').catch(() => '');
  await writeFile(hostKh, existing, { mode: 0o600 });
  try {
    const attempt = async (target: string, heading: string, timeout: number, hasJump: boolean) => {
      const res = await runCommand(
        sshBinary,
        ['-F', configPath, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${hostKh}`, target, 'exit 0'],
        { timeout },
      );
      if (res.code !== 0) {
        throw formatHandshakeError(heading, (res.stderr || res.stdout || `${sshBinary} 退出码 ${res.code}`).trim().slice(0, 4000), hasJump);
      }
    };
    if (jump && jumpAlias) await attempt(jumpAlias, `跳板机 ${endpointAddress(jump)} 连接失败`, 20_000, false);
    await attempt(alias, `开发机 ${endpointAddress(host)} ${jump ? '经跳板机连接失败' : '连接失败'}`, jump ? 35_000 : 20_000, Boolean(jump));
    const content = await readFile(hostKh, 'utf8').catch(() => '');
    return await extractHandshakeResult(sshKeygenBinary, content, host, jump);
  } finally {
    await rm(hostKh, { force: true });
  }
}

const knownHostsLocks = new Map<string, Promise<void>>();

/** Merges verified known_hosts lines into the user's production known_hosts file atomically. */
export async function mergeKnownHostLines(knownHostsPath: string, newLines: string[]): Promise<void> {
  if (!newLines.length) return;
  const previous = knownHostsLocks.get(knownHostsPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  knownHostsLocks.set(knownHostsPath, previous.then(() => current, () => current));
  await previous;
  try {
    const existing = await readFile(knownHostsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const existingLines = new Set(existing.split('\n').map(line => line.trim()).filter(Boolean));
    const additions = newLines.filter(line => line.trim() && !existingLines.has(line.trim()));
    if (!additions.length) return;
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
    await atomicWrite(knownHostsPath, `${prefix}${additions.join('\n')}\n`, 0o600);
  } finally {
    release();
    if (knownHostsLocks.get(knownHostsPath) === current) knownHostsLocks.delete(knownHostsPath);
  }
}
