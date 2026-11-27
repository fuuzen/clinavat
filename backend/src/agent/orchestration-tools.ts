import path from 'node:path';
import { getPermissionMode } from './permissions.js';
import { workspacePath } from './environment.js';
import { clientDirectToolsFor, isClientDirectToolName } from '../client-host/agent-tools.js';
import { callClientDirectTool } from '../client-host/agent-tool-handlers.js';
import type { AgentConfig, AgentContext, HubTool, HubToolResult, RunServices } from './types.js';

/** The namespace of the Hub's tools: Claude Code shows them as mcp__clinavat__<tool>, Codex as clinavat.<tool>. */
export const hubToolNamespace = 'clinavat';

export function isClientProject(context: Pick<AgentContext, 'host'>): boolean {
  return context.host?.kind === 'client';
}

export function isClientDirect(context: Pick<AgentContext, 'host' | 'project'>): boolean {
  return context.host?.kind === 'client' && context.project.client_mode !== 'mirrored';
}

export function isClientMirrored(context: Pick<AgentContext, 'host' | 'project'>): boolean {
  return context.host?.kind === 'client' && context.project.client_mode === 'mirrored';
}

/** Where the Hub stores/checks the project locally: a child agent's directory, or the project root. */
export function workingDirectory(context: AgentContext): string {
  return context.session.agent_directory ? path.join(context.project.local_path, context.session.agent_directory) : context.project.local_path;
}

/** Maps a VM-perspective mirrored path (`project.vm_path/...`) back to the Hub mirror path (`project.local_path/...`). */
export function toHubMirrorPath(context: Pick<AgentContext, 'host' | 'project'>, target: string): string {
  if (!isClientMirrored(context)) return target;
  const vmRoot = (context.project.vm_path || context.project.local_path).replace(/\/+$/, '') || '/';
  const cleanTarget = target.replace(/\/+$/, '') || '/';
  if (cleanTarget === vmRoot) return context.project.local_path;
  if (cleanTarget.startsWith(`${vmRoot}/`)) {
    return path.join(context.project.local_path, cleanTarget.slice(vmRoot.length + 1));
  }
  return target;
}

/** Refuses a change outside a child agent's directory; reading the rest of the project stays allowed. */
export async function assertWritable(context: AgentContext, target: string): Promise<void> {
  if (!context.session.agent_directory) return;
  try { await workspacePath(workingDirectory(context), toHubMirrorPath(context, target), true); }
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

export function orchestrates(context: Pick<AgentContext, 'session'>): boolean {
  return orchestrationModeOf(context.session) !== 'off';
}

export function isSuperAgent(context: Pick<AgentContext, 'session'>): boolean {
  return orchestrationModeOf(context.session) === 'super';
}

export function hasClientDirectTools(context: Pick<AgentContext, 'host' | 'project' | 'session'>): boolean {
  return isClientDirect(context) && !isSuperAgent(context);
}

export function hasHubMcp(context: Pick<AgentContext, 'host' | 'project' | 'session'>): boolean {
  return orchestrates(context) || hasClientDirectTools(context);
}

/** Returns the merged Hub toolset for this session (orchestration + client-direct tools, deduplicated). */
export function hubToolsFor(config: Pick<AgentConfig, 'orchestration'>, context: AgentContext): HubTool[] {
  const tools: HubTool[] = [];
  if (orchestrates(context) && config.orchestration) {
    tools.push(...config.orchestration.toolsFor(context));
  }
  if (hasClientDirectTools(context)) {
    const names = new Set(tools.map(item => item.name));
    for (const tool of clientDirectToolsFor(context)) {
      if (!names.has(tool.name)) tools.push(tool);
    }
  }
  return tools;
}

export function canInspectProject(session: Parameters<typeof orchestrationModeOf>[0] & Parameters<typeof superReadModeOf>[0]): boolean {
  return orchestrationModeOf(session) === 'super' && superReadModeOf(session) !== 'off';
}

export function nativeReadsEnabled(context: AgentContext): boolean {
  if (isClientDirect(context)) return false;
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
  if (!hasHubMcp(services.context)) return { text: '当前对话未启用平台工具', isError: true };
  if (isClientDirectToolName(tool)) {
    if (!hasClientDirectTools(services.context)) {
      return { text: `当前对话未启用客户端工具 ${tool}`, isError: true };
    }
    if (!clientDirectToolsFor(services.context).some(item => item.name === tool)) {
      return { text: `只读子智能体不能调用写/执行工具 ${tool}`, isError: true };
    }
    try {
      await services.control.waitUntilRunning(signal);
      // Client tools run their own diff/dry-run preview + approval flow to avoid double approval prompts.
      return await callClientDirectTool(services, tool, args, signal);
    } catch (error) {
      return { text: error instanceof Error ? error.message : '客户端工具调用失败', isError: true };
    }
  }
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
  const params = message.params ?? {};
  if (!hasHubMcp(services.context)) return { error: { code: -32601, message: '当前对话未启用平台工具' } };
  if (typeof message.method === 'string' && message.method.startsWith('notifications/')) return undefined;
  if (message.method === 'initialize') {
    return { result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: hubToolNamespace, version: '1.0.0' } } };
  }
  if (message.method === 'ping') return { result: {} };
  if (message.method === 'tools/list') return { result: { tools: hubToolsFor(services.config, services.context) } };
  if (message.method === 'tools/call') {
    const result = await callHubTool(services, String(params.name ?? ''), params.arguments ?? {}, signal);
    return { result: { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) } };
  }
  return { error: { code: -32601, message: `不支持的 MCP 方法：${String(message.method ?? '')}` } };
}
