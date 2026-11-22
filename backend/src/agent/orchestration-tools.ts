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

export function orchestrates(context: AgentContext): boolean {
  return !!context.session.orchestration && !context.session.parent_session_id;
}

/**
 * Runs a Hub tool call of the master agent. The CLIs' own approval policies do not reliably cover these tools (Codex
 * skips them entirely), so calls that make children act are approved here, by the master's mode.
 */
export async function callHubTool(services: RunServices, tool: string, args: unknown, signal: AbortSignal): Promise<HubToolResult> {
  const host = services.config.orchestration;
  if (!host || !orchestrates(services.context)) return { text: '当前对话未开启编排', isError: true };
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
