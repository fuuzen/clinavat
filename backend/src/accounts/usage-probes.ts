import { join } from 'node:path';
import { observeProcessClose, terminateProcess } from '../agent/environment.js';
import { readJsonLines } from '../agent/ndjson.js';
import { RpcClient } from '../agent/rpc.js';
import type { ExecutionHost, ExecutionScope } from '../execution/types.js';
import type { AgentEngine } from '../agent/engines.js';
import { parseClaudeUsage, parseCodexRead, type UsageUpdate } from './usage-parsers.js';

const PROBE_TIMEOUT = 30_000;

export interface Probe { execution: ExecutionHost; scope: ExecutionScope; binary: string; home: string }

export function probeEnvironment({ execution, scope, home }: Probe): NodeJS.ProcessEnv {
  return { ...execution.baseEnvironment(scope), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), SHELL: '/bin/bash' };
}

export async function claudeProbe(probe: Probe): Promise<UsageUpdate> {
  const child = await probe.execution.spawn(probe.binary, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--disable-slash-commands', '--no-session-persistence',
  ], { scope: probe.scope, cwd: probe.home, env: probeEnvironment(probe) });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  let closeLines: (() => void) | undefined;
  try {
    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude 额度查询超时')), PROBE_TIMEOUT);
      const settle = (error?: Error, value?: unknown) => { clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const lines = readJsonLines(child.stdout, event => {
        if (event.type !== 'control_response' || event.response?.request_id !== 'usage') return;
        if (event.response.subtype !== 'success') {
          const message = String(event.response.error || 'Claude 额度查询失败');
          settle(new Error(message.includes('not supported') ? '当前 Claude Code 版本不支持额度查询' : message));
        } else settle(undefined, event.response.response);
      }, error => settle(error));
      closeLines = lines.close;
      child.once('error', error => settle(error));
      child.once('close', () => settle(new Error('Claude 在返回额度前退出')));
      child.stdin.once('error', error => settle(error));
      for (const request of [{ request_id: 'initialize', request: { subtype: 'initialize' } },
        { request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }]) {
        child.stdin.write(JSON.stringify({ type: 'control_request', ...request }) + '\n');
      }
    });
    return parseClaudeUsage(response);
  } finally {
    closeLines?.();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}

export async function codexProbe(probe: Probe): Promise<UsageUpdate> {
  return withCodexServer(probe, async rpc => parseCodexRead(await rpc.request('account/rateLimits/read', {}, PROBE_TIMEOUT)));
}

/** A short-lived app-server on the probe's login, answering nothing the server asks of a client. */
export async function withCodexServer<T>(probe: Probe, task: (rpc: RpcClient) => Promise<T>): Promise<T> {
  const child = await probe.execution.spawn(probe.binary, ['-c', 'cli_auth_credentials_store="file"', 'app-server'], {
    scope: probe.scope, cwd: probe.home, env: probeEnvironment(probe),
  });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  const rpc = new RpcClient(child, async message => {
    if (message.id !== undefined && message.method) rpc.send({ id: message.id, error: { code: -32601, message: 'Usage probe only' } });
  }, () => undefined);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'clinavat_usage', title: 'Clinavat Usage', version: '0.1.0' }, capabilities: { experimentalApi: true },
    }, PROBE_TIMEOUT);
    rpc.send({ method: 'initialized', params: {} });
    return await task(rpc);
  } finally {
    rpc.close();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}

/** Reads a slot's subscription quota through its CLI, without starting a conversation. */
export const usageProbes: Record<AgentEngine, (probe: Probe) => Promise<UsageUpdate>> = {
  claude: claudeProbe,
  codex: codexProbe,
};
