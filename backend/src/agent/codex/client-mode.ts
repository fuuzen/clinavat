import path from 'node:path';
import type { AgentConfig, AgentContext, AgentHostInfo, AgentPrompt } from '../types.js';
import type { Project } from '../../models.js';
import { vmProjectRoot, workspacePath } from '../environment.js';
import {
  assertWritable, canInspectProject, hubToolNamespace, hubToolsFor, isClientDirect,
  isClientMirrored, isSuperAgent, nativeReadsEnabled, orchestrationModeOf, toHubMirrorPath,
} from '../orchestration-tools.js';
import { isProtectedInternalSegment, normalizePlatform } from '../../client-host/path-utils.js';

export type CodexInput = { type: 'text'; text: string } | { type: 'image'; url: string };

export const codexInput = (prompt: AgentPrompt): CodexInput[] => [
  ...prompt.images.map(image => ({ type: 'image' as const, url: `data:${image.mediaType};base64,${image.data}` })),
  ...(prompt.text ? [{ type: 'text' as const, text: prompt.text }] : []),
];

export function buildCodexThreadParams(options: {
  context: AgentContext;
  root: string;
  permissions: { sandbox: string; approvalPolicy: string; approvalsReviewer: string };
  developerInstructions: string;
  model?: string;
  effort?: string;
}) {
  const shell = nativeReadsEnabled(options.context);
  return {
    cwd: options.root,
    sandbox: options.permissions.sandbox,
    approvalPolicy: options.permissions.approvalPolicy,
    approvalsReviewer: options.permissions.approvalsReviewer,
    developerInstructions: options.developerInstructions,
    ...(options.model ? { model: options.model } : {}),
    config: {
      'features.shell_tool': shell,
      'features.unified_exec': shell,
      'features.multi_agent': !isSuperAgent(options.context),
      'features.goals': true,
      model_reasoning_summary: 'detailed',
      ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
    },
  };
}

export function buildCodexTurnSettings(options: {
  threadId: string;
  root: string;
  permissions: { approvalPolicy: string; approvalsReviewer: string; sandboxPolicy: Record<string, unknown> };
  agentMode?: string | null;
  model?: string;
  effort?: string;
}) {
  return {
    threadId: options.threadId,
    cwd: options.root,
    approvalPolicy: options.permissions.approvalPolicy,
    approvalsReviewer: options.permissions.approvalsReviewer,
    sandboxPolicy: options.permissions.sandboxPolicy,
    summary: 'detailed',
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.model ? {
      collaborationMode: {
        mode: options.agentMode === 'plan' ? 'plan' : 'default',
        settings: { model: options.model, reasoning_effort: options.effort ?? null, developer_instructions: null },
      },
    } : {}),
  };
}

const extraProtected = new Set(['.claude', '.codex']);

type SessionLike = Pick<AgentContext['session'], 'engine' | 'native_session_id' | 'orchestration' | 'orchestration_mode' | 'super_read_mode' | 'parent_session_id' | 'agent_access'> & {
  native_inspect_tools?: number | null;
};
type ProjectLike = Pick<Project, 'client_mode'>;
type HostLike = Pick<AgentHostInfo, 'kind'>;

/**
 * Encodes Codex's thread-bound dynamic toolset as an integer bitmask stored in `native_inspect_tools`:
 * - bit 0 (1): Super Agent `inspect` tool enabled
 * - bit 1 (2): Mode 1 (client direct) read tools enabled
 * - bit 2 (4): Mode 1 (client direct) write/exec tools enabled
 */
export function codexNativeToolsState(
  session: Omit<SessionLike, 'native_session_id' | 'native_inspect_tools'>,
  project?: ProjectLike | null,
  host?: HostLike | null,
): number {
  let state = canInspectProject(session) ? 1 : 0;
  const direct = host?.kind === 'client' && project?.client_mode !== 'mirrored';
  if (direct && orchestrationModeOf(session) !== 'super') {
    state |= 2;
    if (session.agent_access !== 'read') state |= 4;
  }
  return state;
}

/** True when Codex's persisted native thread was started with a different dynamic toolset and must be renewed. */
export function codexInspectToolsChanged(session: SessionLike, project?: ProjectLike | null, host?: HostLike | null): boolean {
  if (session.engine !== 'codex' || !session.native_session_id) return false;
  return (session.native_inspect_tools ?? 0) !== codexNativeToolsState(session, project, host);
}

/** Builds the `dynamicTools` namespace payload for `thread/start`, or undefined when no Hub tools are exposed. */
export function codexDynamicToolsPayload(config: Pick<AgentConfig, 'orchestration'>, context: AgentContext) {
  const tools = hubToolsFor(config, context);
  if (!tools.length) return undefined;
  return [{
    type: 'namespace',
    name: hubToolNamespace,
    description: isClientDirect(context)
      ? 'Clinavat tools for client workspace file/shell operations and child agent orchestration.'
      : 'Clinavat tools for starting and directing child agents.',
    tools: tools.map(tool => ({ type: 'function', ...tool })),
  }];
}

export function directDeclineHint(fileChange: boolean): string {
  return fileChange
    ? '客户端直连模式已禁用内置 apply_patch，请使用 clinavat.client_apply_patch、clinavat.client_write_file 或 clinavat.client_edit_file 修改客户端文件。'
    : '客户端直连模式已禁用内置 shell 命令执行，请使用 clinavat.client_exec_command 在客户端执行命令。';
}

/**
 * Validates file change targets in Mode 2 (client mirrored) Codex approvals:
 * - On Windows mirrored projects, rejects paths containing `:` or `\` and guides Codex to workspace-relative POSIX paths.
 * - Rejects UNC, `.git`/`.bin`/`.claude`/`.codex`, ADS `:`, Windows 8.3 short names, invisible chars, and out-of-bounds paths.
 */
export async function validateCodexMirroredFileChanges(
  context: AgentContext,
  cwd: string,
  changes: { path?: unknown }[],
  workspaceDir?: string,
): Promise<string | null> {
  if (!isClientMirrored(context)) return null;
  const isWindows = normalizePlatform(context.host?.platform ?? undefined) === 'windows';
  const vmRoot = vmProjectRoot(context, workspaceDir);
  for (const change of changes) {
    if (typeof change.path !== 'string' || !change.path.trim()) return '补丁包含无效的文件路径';
    const raw = change.path.trim();
    if (/[\0\r\n]/.test(raw)) return '补丁路径包含非法控制字符';
    if (raw.startsWith('\\\\') || raw.startsWith('//')) return '补丁不能使用 UNC 网络路径';
    if (isWindows && (raw.includes(':') || raw.includes('\\'))) {
      return `Windows 镜像模式下内置 apply_patch 请使用相对工作区的 POSIX 路径（不能包含 ":" 或 "\\"，收到：${raw}）。`;
    }
    for (const segment of raw.split(/[\\/]+/)) {
      if (!segment) continue;
      const lower = segment.toLowerCase().replace(/[. ]+$/, '');
      if (isProtectedInternalSegment(segment) || extraProtected.has(lower)) {
        return `不能修改受保护的内部或 Git 目录：${raw}`;
      }
    }
    const vmTarget = path.posix.resolve(cwd, raw);
    if (vmTarget !== vmRoot && !vmTarget.startsWith(`${vmRoot}/`)) {
      return `补丁路径超出项目目录范围：${raw}`;
    }
    try {
      await workspacePath(context.project.local_path, toHubMirrorPath(context, vmTarget), true);
      await assertWritable(context, vmTarget);
    } catch (error) {
      return error instanceof Error ? error.message : '补丁路径校验失败';
    }
  }
  return null;
}
