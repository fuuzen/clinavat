import path from 'node:path';
import { getPermissionMode } from './permissions.js';
import { workspacePath } from './environment.js';
import type { AgentContext, HubToolResult, RunServices } from './types.js';

/** The namespace of the Hub's tools: Claude Code shows them as mcp__clinavat__<tool>, Codex as clinavat.<tool>. */
export const hubToolNamespace = 'clinavat';

/** Where the CLI works: a child agent's directory, or the project root. */
export function workingDirectory(context: AgentContext): string {
  return context.session.agent_directory ? path.join(context.project.local_path, context.session.agent_directory) : context.project.local_path;
}

/** Refuses a change outside a child agent's directory; reading the rest of the project stays allowed. */
export async function assertWritable(context: AgentContext, target: string): Promise<void> {
  if (!context.session.agent_directory) return;
  try { await workspacePath(workingDirectory(context), target, true); }
  catch { throw new Error(`你的工作目录是 ${context.session.agent_directory}，只能修改其中的文件；需要改动其他位置时，请在最终回复中说明。`); }
}

export const orchestrationModes = ['off', 'hybrid', 'super'] as const;
export type OrchestrationMode = typeof orchestrationModes[number];

export const superReadModes = ['off', 'overview', 'full'] as const;
export type SuperReadMode = typeof superReadModes[number];

export function superReadModeOf(session: { super_read_mode?: string | null }): SuperReadMode {
  const mode = session.super_read_mode;
  return mode === 'off' || mode === 'full' ? mode : 'overview';
}

export function orchestrationModeOf(session: {
  orchestration?: number | boolean | null;
  orchestration_mode?: string | null;
  parent_session_id?: string | null;
}): OrchestrationMode {
  if (session.parent_session_id) return 'off';
  if (session.orchestration_mode === 'super' || session.orchestration_mode === 'hybrid' || session.orchestration_mode === 'off') {
    return session.orchestration_mode;
  }
  return session.orchestration ? 'hybrid' : 'off';
}

export function orchestrates(context: AgentContext): boolean {
  return orchestrationModeOf(context.session) !== 'off';
}

export function isSuperAgent(context: AgentContext): boolean {
  return orchestrationModeOf(context.session) === 'super';
}

export function canInspectProject(session: Parameters<typeof orchestrationModeOf>[0] & Parameters<typeof superReadModeOf>[0]): boolean {
  return orchestrationModeOf(session) === 'super' && superReadModeOf(session) !== 'off';
}

export function nativeReadsEnabled(context: AgentContext): boolean {
  return !isSuperAgent(context) || superReadModeOf(context.session) === 'full';
}

export const superNativeReadLimit = 12;

export function nativeReadDenied(context: AgentContext): string {
  return superReadModeOf(context.session) === 'off'
    ? 'Super Agent 当前读取档位为 off，请委派 explorer 子智能体检视项目。'
    : 'Super Agent 当前读取档位为 overview，请使用 clinavat.inspect 或委派 explorer 子智能体。';
}

/**
 * Runs a Hub tool call of the master agent. The CLIs' own approval policies do not reliably cover these tools (Codex
 * skips them entirely), so calls that make children act are approved here, by the master's mode.
 */
export async function callHubTool(services: RunServices, tool: string, args: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const host = services.config.orchestration;
  if (!host || !orchestrates(services.context)) return { text: '当前对话未开启编排', isError: true };
  if (!host.toolsFor(services.context).some(item => item.name === tool)) return { text: `当前对话未启用编排工具 ${tool}`, isError: true };
  try {
    await services.control.waitUntilRunning(signal);
    const mode = getPermissionMode(services.context.session);
    if (host.directs(tool) && (mode === 'manual' || mode === 'accept-edits')) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : { arguments: args };
      const approval = await services.approve(`${hubToolNamespace}.${tool}`, input, signal);
      if (approval.decision !== 'allow') return { text: approval.reason || '用户拒绝了这次编排操作', isError: true };
    }
    return await host.call(services.context, tool, args, signal);
  } catch (error) {
    return { text: error instanceof Error ? error.message : '编排工具调用失败', isError: true };
  }
}

/**
 * Answers one JSON-RPC message for the Hub's MCP server, as Claude Code's in-process server and Antigravity's stdio shim
 * both receive them. Notifications get no reply (undefined).
 */
export async function answerHubMcp(services: RunServices, message: { id?: unknown; method?: unknown; params?: any }, signal: AbortSignal)
  : Promise<{ result: unknown } | { error: { code: number; message: string } } | undefined> {
  const host = services.config.orchestration;
  const params = message.params ?? {};
  if (!host || !orchestrates(services.context)) return { error: { code: -32601, message: '当前对话未开启编排' } };
  if (typeof message.method === 'string' && message.method.startsWith('notifications/')) return undefined;
  if (message.method === 'initialize') {
    return { result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: hubToolNamespace, version: '1.0.0' } } };
  }
  if (message.method === 'ping') return { result: {} };
  if (message.method === 'tools/list') return { result: { tools: host.toolsFor(services.context) } };
  if (message.method === 'tools/call') {
    const result = await callHubTool(services, String(params.name ?? ''), params.arguments ?? {}, signal);
    return { result: { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) } };
  }
  return { error: { code: -32601, message: `不支持的 MCP 方法：${String(message.method ?? '')}` } };
}
