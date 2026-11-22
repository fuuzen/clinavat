import type { Store } from '../database.js';
import { HttpError } from '../models.js';
import { agentEnvironment, observeProcessClose, terminateProcess } from './environment.js';
import type { ExecutionScope } from '../execution/types.js';
import { readJsonLines } from './ndjson.js';
import { RpcClient } from './rpc.js';
import type { AgentConfig, AgentContext } from './types.js';
import type { AgentEngine } from './engines.js';

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

/** The catalog depends only on the account and the slot's CLI, never on a project. */
export type CatalogContext = Pick<AgentContext, 'user' | 'slot'> & { session: Pick<AgentContext['session'], 'engine'> };
type ProbeContext = Omit<AgentContext, 'project'>;

export interface SlotModelCatalog { models: AgentModel[]; refreshedAt: string }

/** Each slot's last catalog, kept until someone with access to the slot asks to read it again. */
export class SlotModelCatalogs {
  private reading = new Map<string, Promise<SlotModelCatalog>>();

  constructor(private readonly store: Store) {}

  read(slotId: string): SlotModelCatalog | undefined {
    const row = this.store.get<{ model_catalog: string | null; model_catalog_at: string | null }>(
      'SELECT model_catalog,model_catalog_at FROM account_slots WHERE id=?', slotId);
    if (!row?.model_catalog || !row.model_catalog_at) return undefined;
    return { models: JSON.parse(row.model_catalog) as AgentModel[], refreshedAt: row.model_catalog_at };
  }

  /** Concurrent requests for one slot share a single CLI start. */
  probe(slotId: string, read: () => Promise<AgentModel[]>): Promise<SlotModelCatalog> {
    const pending = this.reading.get(slotId);
    if (pending) return pending;
    const request = read().then(models => {
      const refreshedAt = new Date().toISOString();
      this.store.run('UPDATE account_slots SET model_catalog=?,model_catalog_at=? WHERE id=?', JSON.stringify(models), refreshedAt, slotId);
      return { models, refreshedAt };
    }).finally(() => this.reading.delete(slotId));
    this.reading.set(slotId, request);
    return request;
  }
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

const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const effortSuffix = new RegExp(`^(.+)-(${effortOrder.join('|')})$`);

/**
 * agy lists one model ID per thinking level, such as gemini-3.8-flash-high, while its conversations pick the base
 * model and the level separately. A suffix names a level only when the base has more than one of them:
 * gpt-oss-120b-medium is a model of its own.
 */
export function groupAntigravityModels(entries: { id: string; label: string }[]): AgentModel[] {
  const variants = new Map<string, string[]>();
  for (const { id } of entries) {
    const match = effortSuffix.exec(id);
    if (match) variants.set(match[1], [...variants.get(match[1]) ?? [], match[2]]);
  }
  const models = new Map<string, AgentModel>();
  for (const { id, label } of entries) {
    const match = effortSuffix.exec(id);
    const efforts = match ? variants.get(match[1])! : [];
    if (match && efforts.length > 1) {
      if (!models.has(match[1])) models.set(match[1], { id: match[1], name: label.replace(/\s*\([^)]*\)$/, ''),
        reasoningEfforts: [...efforts].sort((left, right) => effortOrder.indexOf(left) - effortOrder.indexOf(right)).map(effortOption) });
    } else models.set(id, { id, name: label, reasoningEfforts: [] });
  }
  return [...models.values()];
}

async function antigravityModels(config: AgentConfig, context: ProbeContext): Promise<AgentModel[]> {
  const { execution } = config;
  const scope = probeScope(context);
  // The output format must come before the subcommand.
  const result = await execution.run(await execution.binary(scope, 'agy'), ['--output-format', 'json', 'models'], {
    scope, cwd: context.runtime_home, env: agentEnvironment(execution, context, scope), timeout: 60_000, maxBytes: 1024 * 1024 });
  const line = result.stdout.split('\n').map(item => item.trim()).filter(item => item.startsWith('{')).at(-1);
  const models = line ? JSON.parse(line)?.command?.data?.models : undefined;
  if (!Array.isArray(models)) {
    throw new Error(`Antigravity 未返回有效模型目录：${(result.stderr || result.stdout).trim().slice(0, 300) || `退出码 ${result.code}`}`);
  }
  return groupAntigravityModels(models.filter((model: any) => typeof model?.id === 'string')
    .map((model: any) => ({ id: model.id, label: typeof model.label === 'string' ? model.label : model.id })));
}

/** Reads the models a slot's account may use from its CLI. */
const modelReaders: Record<AgentEngine, (config: AgentConfig, context: ProbeContext) => Promise<AgentModel[]>> = {
  claude: claudeModels,
  codex: codexModels,
  antigravity: antigravityModels,
};

async function probeModels(config: AgentConfig, context: CatalogContext): Promise<SlotModelCatalog> {
  const probeContext: ProbeContext = { user: context.user, slot: context.slot, runtime_home: context.slot.home_dir,
    runtime_kind: 'probe', session: { id: '', engine: context.session.engine } };
  return config.catalogs.probe(context.slot.id, async () => {
    const release = await config.credentials.acquire(probeContext);
    try {
      const result = await modelReaders[context.session.engine](config, probeContext);
      if (!result.length) throw new Error('当前 CLI 未提供可用模型');
      return result;
    } finally { await release(); }
  });
}

/** The slot's saved catalog; only a slot that has never been read starts its CLI here. */
export async function loadModelCatalog(config: AgentConfig, context: CatalogContext): Promise<SlotModelCatalog> {
  return config.catalogs.read(context.slot.id) ?? probeModels(config, context);
}

export async function loadAgentModels(config: AgentConfig, context: CatalogContext): Promise<AgentModel[]> {
  return (await loadModelCatalog(config, context)).models;
}

/** Reads the catalog from the slot's CLI again, as `context.user`, who must have access to the slot. */
export function refreshModelCatalog(config: AgentConfig, context: CatalogContext): Promise<SlotModelCatalog> {
  return probeModels(config, context);
}

export interface AgentPreference { model: string | null; reasoningEffort: string | null }

/**
 * Checks what a conversation chose against the slot's catalog and fills what it leaves to the default with the
 * user's own default where this slot's catalog offers it; anything left over follows the CLI's default.
 */
export async function resolveAgentSelection(config: AgentConfig, context: CatalogContext, selection: AgentSelection,
  preference?: AgentPreference): Promise<AgentPreference> {
  const chosen = { model: selection.model ?? null, reasoningEffort: selection.reasoningEffort ?? null };
  if (!chosen.model && !chosen.reasoningEffort && !preference?.model && !preference?.reasoningEffort) return chosen;
  let models: AgentModel[];
  try { models = await loadAgentModels(config, context); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, error instanceof Error ? error.message : '模型目录读取失败');
  }
  const find = (id: string | null) => id ? models.find(item => item.id === id) : models.find(item => item.isDefault);
  if ((chosen.model || chosen.reasoningEffort) && !find(chosen.model)) throw new HttpError(400, '当前 CLI 不支持所选模型，请重新选择');
  const model = chosen.model ?? (preference?.model && find(preference.model) ? preference.model : null);
  const supports = (effort: string) => !!find(model)?.reasoningEfforts.some(item => item.value === effort);
  if (chosen.reasoningEffort && !supports(chosen.reasoningEffort)) throw new HttpError(400, '所选模型不支持该思考强度，请重新选择');
  const reasoningEffort = chosen.reasoningEffort
    ?? (preference?.reasoningEffort && supports(preference.reasoningEffort) ? preference.reasoningEffort : null);
  return { model, reasoningEffort };
}

export async function validateAgentSelection(config: AgentConfig, context: CatalogContext, selection: AgentSelection): Promise<void> {
  await resolveAgentSelection(config, context, selection);
}
