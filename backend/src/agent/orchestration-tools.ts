import { getPermissionMode } from './permissions.js';
import type { AgentContext, HubToolResult, RunServices } from './types.js';

/** The namespace of the Hub's tools: Claude Code shows them as mcp__clinavat__<tool>, Codex as clinavat.<tool>. */
export const hubToolNamespace = 'clinavat';

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
