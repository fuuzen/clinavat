import { codexTotals, codexUsage, type CodexTotals } from '../token-usage/meters.js';
import type { createCodexRequests } from './codex-requests.js';
import type { RpcMessage } from './rpc.js';
import type { RunServices } from './types.js';

const toolItems = ['webSearch', 'commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall'];

/**
 * Threads that Codex spawns for sub-agents. Their approvals and questions reach the user even after the
 * conversation's turn has ended, their tool calls show under their names, and their text stays out of the reply.
 */
export class CodexSubagents {
  private names = new Map<string, string>();
  private models = new Map<string, string>();
  private runningTurns = new Map<string, string>();
  // Codex repeats unchanged thread totals, so each thread counts only its growth.
  private counted = new Map<string, CodexTotals>();

  constructor(
    private services: RunServices,
    readonly requests: ReturnType<typeof createCodexRequests>,
    private fallbackModel: () => string,
  ) {}

  /** A sub-agent still has a turn running. */
  busy(): boolean { return this.runningTurns.size > 0; }

  /** Learns the threads a collab call of the conversation's thread spawned, before their own notifications. */
  observeCall(item: Record<string, any>): void {
    if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent' || !Array.isArray(item.receiverThreadIds)) return;
    for (const id of item.receiverThreadIds) {
      if (!this.names.has(String(id))) this.names.set(String(id), '子智能体');
      if (typeof item.model === 'string' && item.model) this.models.set(String(id), item.model);
    }
  }

  /** Handles a notification of a thread other than the conversation's. */
  observe(message: RpcMessage): void {
    const params = message.params ?? {};
    const thread = String(params.threadId ?? params.thread?.id ?? '');
    if (message.method === 'thread/started' && params.thread?.parentThreadId) {
      this.names.set(thread, String(params.thread.agentNickname || params.thread.agentRole || this.names.get(thread) || '子智能体'));
      if (typeof params.thread.model === 'string' && params.thread.model) this.models.set(thread, params.thread.model);
    }
    if (message.method === 'thread/tokenUsage/updated') this.count(thread, params.tokenUsage);
    if (message.method === 'serverRequest/resolved') this.requests.resolved(params.requestId);
    const agent = this.names.get(thread);
    if (!agent) return;
    if (message.method === 'turn/started') this.runningTurns.set(thread, String(params.turn?.id ?? ''));
    if (message.method === 'turn/completed') {
      this.runningTurns.delete(thread);
      this.services.activityChanged();
    }
    const item = params.item;
    if (message.method === 'item/started' && item) this.requests.record(item);
    if (message.method === 'item/completed' && item?.id) this.requests.forget(String(item.id));
    if ((message.method === 'item/started' || message.method === 'item/completed') && item) {
      const event = this.toolEvent(item, message.method === 'item/completed', agent);
      if (event) this.services.event('tool', event);
    }
    if (message.method === 'item/commandExecution/outputDelta') {
      this.services.event('tool', { id: params.itemId, tool: 'commandExecution', output: String(params.delta ?? '').slice(0, 128 * 1024),
        status: 'running', append: true, agent });
    }
  }

  /** The web view's tool event for a native item; undefined for items that are not tool calls. */
  toolEvent(item: Record<string, any>, completed: boolean, agent?: string): Record<string, unknown> | undefined {
    if (!toolItems.includes(item.type)) return undefined;
    const collab = item.type === 'collabAgentToolCall';
    const event = {
      id: item.id, tool: item.type === 'fileChange' ? 'apply_patch' : collab ? `agent.${String(item.tool)}` : item.type,
      input: collab ? { prompt: item.prompt, model: item.model, agents: this.agentNames(item.receiverThreadIds) }
        : item.command ?? item.action ?? item.arguments ?? item.changes,
      ...(agent ? { agent } : {}),
    };
    if (!completed) return { ...event, status: 'running' };
    const states = collab && item.agentsStates && typeof item.agentsStates === 'object'
      ? Object.entries(item.agentsStates as Record<string, { status?: string; message?: string | null }>) : [];
    return {
      ...event,
      output: collab ? states.map(([id, state]) => `${this.names.get(id) ?? id}：${state.status ?? ''}${state.message ? `\n${state.message}` : ''}`)
        .join('\n\n').slice(0, 128 * 1024) || undefined
        : typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 128 * 1024) : undefined,
      status: item.status === 'declined' ? 'declined'
        : ['cancelled', 'canceled', 'interrupted'].includes(item.status) ? 'interrupted'
        : item.status === 'failed' || item.exitCode > 0 ? 'failed' : 'completed',
    };
  }

  close(): void { this.requests.close(); }

  private agentNames(threads: unknown): string[] | undefined {
    return Array.isArray(threads) ? threads.map(id => this.names.get(String(id)) ?? String(id)) : undefined;
  }

  private count(thread: string, tokenUsage: { total?: unknown; last?: unknown } | undefined): void {
    const total = codexTotals(tokenUsage?.total), last = codexTotals(tokenUsage?.last);
    if (!thread || !total || !last) return;
    const record = codexUsage(this.models.get(thread) ?? this.fallbackModel(), total, last, this.counted.get(thread) ?? null);
    this.counted.set(thread, total);
    if (record) this.services.recordTokenUsage({ records: [record] });
  }
}
