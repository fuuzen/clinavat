import { HttpError } from '../models.js';
import { agentEnvironment, observeProcessClose, terminateProcess } from './environment.js';
import type { ExecutionScope } from '../execution/types.js';
import { readJsonLines } from './ndjson.js';
import { RpcClient } from './rpc.js';
import type { AgentConfig, AgentContext } from './types.js';

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: { value: string; label: string }[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

export interface AgentSelection {
  model?: string | null;
  reasoningEffort?: string | null;
}

/** The catalog depends only on the account and the user's CLI profile in the slot, never on a project. */
export type CatalogContext = Pick<AgentContext, 'user' | 'slot'> & { session: Pick<AgentContext['session'], 'engine'> };
type ProbeContext = Omit<AgentContext, 'project'>;

const cache = new Map<string, { userId: string; expires: number; models: Promise<AgentModel[]> }>();

export function invalidateUserModels(userId: string): void {
  for (const [key, entry] of cache) if (entry.userId === userId) cache.delete(key);
}

// Effort names stay in the CLIs' own English terms.
const effortLabels: Record<string, string> = { xhigh: 'Extra High' };
const effortOption = (value: string) => ({ value, label: effortLabels[value] || value.charAt(0).toUpperCase() + value.slice(1) });

// Runs in the slot's home, so no project is mounted into the slot machine just to read the catalog.
const probeScope = (context: ProbeContext): ExecutionScope => ({ userId: context.user.id, slotId: context.slot.id, paths: [context.runtime_home] });

async function codexModels(config: AgentConfig, context: ProbeContext): Promise<AgentModel[]> {
  const { execution } = config;
  const scope = probeScope(context);
  const binary = await execution.binary(scope, 'codex');
  const child = await execution.spawn(binary, ['-c', 'cli_auth_credentials_store="file"', '-c', `projects.${JSON.stringify(context.runtime_home)}.trust_level="untrusted"`, 'app-server'], {
    scope, cwd: context.runtime_home, env: agentEnvironment(execution, context, scope),
  });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  const rpc = new RpcClient(child, async message => {
    if (message.id !== undefined && message.method) rpc.send({ id: message.id, error: { code: -32601, message: 'Model discovery only' } });
  }, () => undefined);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'clinavat_models', title: 'Clinavat Models', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 15000);
    rpc.send({ method: 'initialized', params: {} });
    const models: AgentModel[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 15000);
      if (!Array.isArray(page?.data)) throw new Error('Codex 未返回有效模型目录');
      for (const model of page.data) {
        if (typeof model.model !== 'string' || model.hidden === true) continue;
        models.push({
          id: model.model, name: String(model.displayName || model.model),
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
          reasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.filter((item: any) => typeof item.reasoningEffort === 'string')
              .map((item: any) => effortOption(item.reasoningEffort)) : [],
          ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
          isDefault: model.isDefault === true,
        });
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (models.length > 1000) throw new Error('Codex 模型目录过大');
    } while (cursor);
    const settings = await rpc.request('config/read', { includeLayers: false }, 15000);
    const configuredModel = typeof settings?.config?.model === 'string' ? settings.config.model : undefined;
    const configuredEffort = typeof settings?.config?.model_reasoning_effort === 'string' ? settings.config.model_reasoning_effort : undefined;
    const defaultId = configuredModel || models.find(model => model.isDefault)?.id;
    if (configuredModel && !models.some(model => model.id === configuredModel)) {
      models.unshift({ id: configuredModel, name: configuredModel, description: 'CLI 配置的默认模型，未提供思考强度能力信息', reasoningEfforts: [], isDefault: true });
    }
    return models.map(model => ({
      ...model,
      isDefault: model.id === defaultId,
      ...(model.id === defaultId && configuredEffort && model.reasoningEfforts.some(option => option.value === configuredEffort)
        ? { defaultReasoningEffort: configuredEffort } : {}),
    }));
  } finally {
    rpc.close();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}

async function claudeModels(config: AgentConfig, context: ProbeContext): Promise<AgentModel[]> {
  const { execution } = config;
  const scope = probeScope(context);
  const binary = await execution.binary(scope, 'claude');
  const child = await execution.spawn(binary, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--disable-slash-commands', '--no-session-persistence',
  ], {
    scope, cwd: context.runtime_home, env: agentEnvironment(execution, context, scope),
    secrets: await config.credentials.secretEnvironment(context.slot.id),
  });
  const closed = observeProcessClose(child);
  child.stderr.resume();
  let closeLines: (() => void) | undefined;
  try {
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude 模型目录查询超时')), 20000);
      const settle = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const lines = readJsonLines(child.stdout, event => {
        if (event.type !== 'control_response' || event.response?.request_id !== 'model-catalog') return;
        if (event.response.subtype !== 'success') settle(new Error(String(event.response.error || 'Claude 模型目录查询失败')));
        else settle(undefined, event.response.response);
      }, error => settle(error));
      closeLines = lines.close;
      child.once('error', error => settle(error));
      child.once('close', () => settle(new Error('Claude 在返回模型目录前退出')));
      child.stdin.once('error', error => settle(error));
      child.stdin.write(JSON.stringify({
        type: 'control_request', request_id: 'model-catalog', request: { subtype: 'initialize' },
      }) + '\n');
    });
    if (!Array.isArray(result?.models)) throw new Error('Claude 未返回有效模型目录，请升级官方 CLI');
    return result.models.filter((model: any) => typeof model.value === 'string').map((model: any) => ({
      id: model.value, name: String(model.displayName || model.value),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      reasoningEfforts: model.supportsEffort && Array.isArray(model.supportedEffortLevels)
        ? model.supportedEffortLevels.filter((value: unknown) => typeof value === 'string').map(effortOption) : [],
      isDefault: model.value === 'default',
    }));
  } finally {
    closeLines?.();
    child.stdin.end();
    terminateProcess(child);
    await closed;
  }
}

export async function loadAgentModels(config: AgentConfig, context: CatalogContext): Promise<AgentModel[]> {
  const probeContext: ProbeContext = { user: context.user, slot: context.slot, runtime_home: context.slot.home_dir,
    runtime_kind: 'probe', session: { id: '', engine: context.session.engine } };
  // The fingerprint checks access without a lease, so a cached catalog never waits for the slot.
  const credentialFingerprint = await config.credentials.fingerprint(probeContext);
  const key = JSON.stringify([context.user.id, probeContext.runtime_home, context.slot.id, context.slot.credential_revision,
    context.slot.updated_at, credentialFingerprint, context.session.engine]);
  for (const [cachedKey, entry] of cache) if (entry.expires <= Date.now()) cache.delete(cachedKey);
  const existing = cache.get(key);
  if (existing) return existing.models;
  const models = (async () => {
    const release = await config.credentials.acquire(probeContext);
    try {
      const result = await (context.session.engine === 'codex' ? codexModels(config, probeContext) : claudeModels(config, probeContext));
      if (!result.length) throw new Error('当前 CLI 未提供可用模型');
      return result;
    } finally { await release(); }
  })();
  cache.set(key, { userId: context.user.id, expires: Date.now() + 300000, models });
  try { return await models; }
  catch (error) { if (cache.get(key)?.models === models) cache.delete(key); throw error; }
}

export async function validateAgentSelection(config: AgentConfig, context: CatalogContext, selection: AgentSelection): Promise<void> {
  if (!selection.model && !selection.reasoningEffort) return;
  let models: AgentModel[];
  try { models = await loadAgentModels(config, context); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, error instanceof Error ? error.message : '模型目录读取失败');
  }
  const model = selection.model ? models.find(item => item.id === selection.model) : models.find(item => item.isDefault);
  if (!model) throw new HttpError(400, '当前 CLI 不支持所选模型，请重新选择');
  if (selection.reasoningEffort && !model.reasoningEfforts.some(item => item.value === selection.reasoningEffort)) {
    throw new HttpError(400, '所选模型不支持该思考强度，请重新选择');
  }
}
