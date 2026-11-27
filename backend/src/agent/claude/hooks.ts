import path from 'node:path';
import { quoteShell, vmProjectRoot, workspacePath } from '../environment.js';
import { getPermissionMode } from '../permissions.js';
import type { AgentContext, RunServices } from '../types.js';
import { answerClaudeQuestions } from './questions.js';
import {
  assertWritable, hasHubMcp, hubToolNamespace, hubToolsFor, isClientDirect, isClientMirrored,
  isSuperAgent, nativeReadDenied, nativeReadsEnabled, superNativeReadLimit, toHubMirrorPath,
} from '../orchestration-tools.js';
import { assertClientPath, clientToVmPath, isProtectedInternalSegment, normalizePlatform } from '../../client-host/path-utils.js';

const nativeReads = new Set(['Read', 'Glob', 'Grep']);
const directBlockedTools = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'NotebookEdit', 'Agent']);
const extraProtected = new Set(['.claude', '.codex']);
const readBudgets = new WeakMap<RunServices, { turnId: string | undefined; calls: number }>();

function decision(allowed: boolean, reason: string, updatedInput?: Record<string, unknown>) {
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: allowed ? 'allow' : 'deny',
    permissionDecisionReason: reason,
    ...(updatedInput ? { updatedInput } : {}),
  } };
}

function nativeDecision(updatedInput?: Record<string, unknown>) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...(updatedInput ? { updatedInput } : {}) } };
}

export type HookOutput = ReturnType<typeof decision> | ReturnType<typeof nativeDecision>;
export const denyHook = (reason: string) => decision(false, reason);

/** The CLI treats an invalid or failed callback answer as no opinion and runs the tool, so only well-formed answers leave the Hub. */
export function validHookOutput(value: unknown): HookOutput {
  const output = (value as { hookSpecificOutput?: Record<string, unknown> } | undefined)?.hookSpecificOutput;
  const updatedInput = output?.updatedInput;
  const valid = !!output && output.hookEventName === 'PreToolUse'
    && (output.permissionDecision === undefined || output.permissionDecision === 'allow' || output.permissionDecision === 'deny')
    && (updatedInput === undefined || (!!updatedInput && typeof updatedInput === 'object' && !Array.isArray(updatedInput)));
  return valid ? value as HookOutput : denyHook('平台审批结果无效，已拒绝');
}

function assertSafeSegments(raw: string, isWindows: boolean): void {
  if (/[\0\r\n]/.test(raw)) throw new Error('路径包含非法字符');
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new Error('不支持 UNC 网络路径');
  const body = isWindows && /^[A-Za-z]:[\\/]/.test(raw) ? raw.slice(3) : raw;
  for (const segment of body.split(/[\\/]+/)) {
    if (!segment) continue;
    if (isWindows && segment.includes(':')) throw new Error(`Windows 路径段不能包含冒号：${segment}`);
    const lower = segment.toLowerCase().replace(/[. ]+$/, '');
    if (isProtectedInternalSegment(segment) || extraProtected.has(lower)) {
      throw new Error('不能访问工作区运行配置或 Git 内部目录');
    }
  }
}

/**
 * Resolves a tool path for both standard and client-mirrored projects:
 * - Normalizes Windows `C:\...` paths in Windows mirrored mode to `vmRoot/...` (flagged via `rewritten`).
 * - Validates Hub-side realpath containment against `project.local_path`.
 */
async function resolveToolTarget(
  context: AgentContext,
  vmRoot: string,
  vmCwd: string,
  rawTarget: string,
  allowMissing: boolean,
): Promise<{ vmPath: string; hubPath: string; rewritten?: string }> {
  const mirrored = isClientMirrored(context);
  const isWindows = mirrored && normalizePlatform(context.host?.platform ?? undefined) === 'windows';
  assertSafeSegments(rawTarget, isWindows);

  let vmPath: string;
  let rewritten: string | undefined;
  if (isWindows && /^[A-Za-z]:[\\/]/.test(rawTarget)) {
    const normalizedClient = assertClientPath('windows', rawTarget);
    const mapped = clientToVmPath('windows', vmRoot, context.project.remote_path, normalizedClient);
    if (mapped !== vmRoot && !mapped.startsWith(`${vmRoot}/`)) {
      throw new Error('只能访问当前项目目录');
    }
    vmPath = mapped;
    rewritten = mapped;
  } else if (isWindows && /^[A-Za-z]:/.test(rawTarget)) {
    throw new Error('只能访问当前项目目录');
  } else {
    vmPath = path.posix.resolve(vmCwd, rawTarget);
    if (mirrored && vmPath !== vmRoot && !vmPath.startsWith(`${vmRoot}/`)) {
      throw new Error('只能访问当前项目目录');
    }
  }
  const hubTarget = mirrored ? toHubMirrorPath(context, vmPath) : vmPath;
  const hubPath = await workspacePath(context.project.local_path, hubTarget, allowMissing);
  return { vmPath, hubPath, rewritten };
}

function directDeniedMessage(context: AgentContext): string {
  if (isSuperAgent(context)) {
    return '当前为客户端直连模式的 Super Agent，内置本地工具已禁用；请使用 mcp__clinavat__inspect 或通过 mcp__clinavat__start_agent 委派子智能体。';
  }
  return context.session.agent_access === 'read'
    ? '当前为客户端直连只读模式，内置本地工具已禁用；请使用 mcp__clinavat__client_read_file / client_list_dir / client_glob / client_grep。'
    : '当前为客户端直连模式，内置本地工具已禁用；请使用 mcp__clinavat__client_* 工具（如 client_read_file、client_write_file、client_edit_file、client_apply_patch、client_exec_command 等）。';
}

export async function preToolUseDecision(services: RunServices, input: Record<string, unknown>): Promise<HookOutput> {
  const tool = String(input.tool_name ?? '');
  const args = input.tool_input as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return decision(false, '工具输入无效');
  const { context } = services;
  const root = context.project.local_path;
  const vmRoot = vmProjectRoot(context, services.config.workspaceDir);
  const planning = context.session.agent_mode === 'plan';
  const yolo = !planning && getPermissionMode(context.session) === 'yolo';
  try {
    await services.control.waitUntilRunning();
    if (tool === 'AskUserQuestion') {
      const answer = await answerClaudeQuestions(services, args);
      return 'updatedInput' in answer ? decision(true, '用户已回答问题', answer.updatedInput) : decision(false, answer.reason);
    }
    const mcpPrefix = `mcp__${hubToolNamespace}__`;
    if (tool.startsWith(mcpPrefix)) {
      const toolName = tool.slice(mcpPrefix.length);
      if (!hasHubMcp(context)) return decision(false, '当前对话未启用平台工具');
      const allowed = hubToolsFor(services.config, context).some(item => item.name === toolName);
      return allowed ? decision(true, '平台工具由本系统在执行时按授权模式审批') : decision(false, `当前对话未启用工具 ${tool}`);
    }
    if (isClientDirect(context) && directBlockedTools.has(tool)) {
      return decision(false, directDeniedMessage(context));
    }
    if (isSuperAgent(context) && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent'].includes(tool)) {
      return decision(false, '当前处于 Super Agent 只读统筹模式，不能直接修改文件、执行命令或调用原生子代理；请通过 clinavat 编排工具（start_agent / message_agent）委派子智能体实施。');
    }
    if (isSuperAgent(context) && nativeReads.has(tool)) {
      if (!nativeReadsEnabled(context)) return denyHook(nativeReadDenied(context));
      const turnId = context.session.turn_id;
      let budget = readBudgets.get(services);
      if (!budget || budget.turnId !== turnId) {
        budget = { turnId, calls: 0 };
        readBudgets.set(services, budget);
      }
      if (budget.calls >= superNativeReadLimit) return denyHook('本轮原生读取和搜索已达 12 次，请委派 explorer 子智能体。');
      budget.calls++;
    }
    if (context.session.agent_access === 'read' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      return decision(false, '你是只读子智能体，不能修改文件；请在最终回复中说明需要的修改。');
    }
    if (tool === 'ExitPlanMode') return decision(false, '请在最终回复中展示方案并结束本轮；用户可以通过网页模式菜单切换到 Normal 后请求执行。');
    if (['WebFetch', 'WebSearch'].includes(tool)) {
      if (!yolo) return nativeDecision();
      const approved = await services.approve(tool, args);
      return decision(approved.decision === 'allow', approved.reason ?? '工具审批');
    }
    if (tool === 'SubagentHandback') return nativeDecision();

    const rawCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : vmRoot;
    const resolvedCwd = await resolveToolTarget(context, vmRoot, vmRoot, rawCwd, false);
    if (tool === 'Bash') {
      if (typeof args.command !== 'string') return decision(false, '命令无效');
      const background = args.run_in_background === true;
      await services.verifyShell();
      if (yolo) {
        const approved = await services.approve('Bash', { ...args, cwd: resolvedCwd.vmPath });
        if (approved.decision !== 'allow') return decision(false, approved.reason ?? '用户拒绝执行');
        await services.verifyShell();
      }
      const local = context.project.execution_mode === 'local';
      const shell = local ? context.project.host_shell : path.posix.join(vmRoot, '.bin', 'remote-shell');
      if (!shell) return yolo ? decision(true, 'YOLO：本系统自动批准') : nativeDecision();
      const updatedInput = {
        ...args,
        command: `cd ${quoteShell(resolvedCwd.vmPath)} && ${quoteShell(shell)} ${background ? '--background ' : ''}-c ${quoteShell(args.command)}`,
      };
      return yolo ? decision(true, `YOLO：本系统自动批准，命令在${local ? '宿主机' : '开发机'}执行`, updatedInput) : nativeDecision(updatedInput);
    }
    if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const pathField = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      if (typeof args[pathField] !== 'string') return decision(false, '文件路径无效');
      const rawPath = args[pathField] as string;
      const planRoot = path.join(context.runtime_home, '.claude', 'plans');
      const lexicalPlan = path.resolve(resolvedCwd.hubPath, rawPath);
      if (planning && lexicalPlan.startsWith(`${planRoot}${path.sep}`) && lexicalPlan.endsWith('.md')) {
        await workspacePath(planRoot, lexicalPlan, tool !== 'Read');
        return nativeDecision();
      }
      const resolved = await resolveToolTarget(context, vmRoot, resolvedCwd.vmPath, rawPath, tool !== 'Read');
      if (tool !== 'Read') await assertWritable(context, resolved.vmPath);
      const updatedInput = resolved.rewritten ? { ...args, [pathField]: resolved.rewritten } : undefined;
      if (!yolo) return nativeDecision(updatedInput);
      const approved = await services.approve(tool, updatedInput ?? args);
      if (approved.decision === 'allow') await workspacePath(root, resolved.hubPath, true);
      return decision(approved.decision === 'allow', approved.reason ?? '文件修改审批', updatedInput);
    }
    if (['Glob', 'Grep'].includes(tool)) {
      const rawSearchPath = args.path === undefined ? '.' : String(args.path);
      const resolved = await resolveToolTarget(context, vmRoot, resolvedCwd.vmPath, rawSearchPath, false);
      const filePattern = String((tool === 'Glob' ? args.pattern : args.glob) ?? '');
      const isWin = isClientMirrored(context) && normalizePlatform(context.host?.platform ?? undefined) === 'windows';
      if (filePattern) assertSafeSegments(filePattern, isWin);
      if (tool === 'Glob') {
        const pattern = String(args.pattern ?? '');
        if (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
          return decision(false, 'Glob 模式必须位于当前项目目录内');
        }
      }
      const updatedInput = resolved.rewritten ? { ...args, path: resolved.rewritten } : undefined;
      if (!yolo) return nativeDecision(updatedInput);
      const approved = await services.approve(tool, updatedInput ?? args);
      return decision(approved.decision === 'allow', approved.reason ?? '搜索审批', updatedInput);
    }
    if (tool === 'Agent') {
      if (args.isolation !== undefined) return decision(false, '当前工作台不支持 isolation，请在当前项目中直接运行子智能体');
      let updatedInput: Record<string, unknown> | undefined;
      if (args.cwd !== undefined) {
        const resolved = await resolveToolTarget(context, vmRoot, resolvedCwd.vmPath, String(args.cwd), false);
        if (resolved.rewritten) updatedInput = { ...args, cwd: resolved.rewritten };
      }
      if (!yolo) return nativeDecision(updatedInput);
      const approved = await services.approve(tool, updatedInput ?? args);
      return decision(approved.decision === 'allow', approved.reason ?? '工具审批', updatedInput);
    }
    return decision(false, `当前工作台未启用工具 ${tool}`);
  } catch (error) {
    return decision(false, error instanceof Error ? error.message : '工具路径或审批校验失败');
  }
}
