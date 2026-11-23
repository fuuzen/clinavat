import path from 'node:path';
import { quoteShell, workspacePath } from '../environment.js';
import { getPermissionMode } from '../permissions.js';
import type { RunServices } from '../types.js';
import { answerClaudeQuestions } from './questions.js';
import { assertWritable, hubToolNamespace, isSuperAgent, orchestrates } from '../orchestration-tools.js';

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

export async function preToolUseDecision(services: RunServices, input: Record<string, unknown>): Promise<HookOutput> {
  const tool = String(input.tool_name ?? '');
  const args = input.tool_input as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return decision(false, '工具输入无效');
  const root = services.context.project.local_path;
  const planning = services.context.session.agent_mode === 'plan';
  const yolo = !planning && getPermissionMode(services.context.session) === 'yolo';
  try {
    await services.control.waitUntilRunning();
    if (tool === 'AskUserQuestion') {
      // Questions must reach the user even when native tool approvals are bypassed.
      const answer = await answerClaudeQuestions(services, args);
      return 'updatedInput' in answer ? decision(true, '用户已回答问题', answer.updatedInput) : decision(false, answer.reason);
    }
    if (tool.startsWith(`mcp__${hubToolNamespace}__`)) {
      return orchestrates(services.context) ? decision(true, '编排工具由本系统在执行时按授权模式审批') : decision(false, '当前对话未开启编排');
    }
    if (isSuperAgent(services.context) && ['Edit', 'Write', 'Bash', 'Agent'].includes(tool)) {
      return decision(false, '当前处于 Super Agent 只读统筹模式，不能直接修改文件、执行命令或调用原生子代理；请通过 clinavat 编排工具（start_agent / message_agent）委派子智能体实施。');
    }
    if (services.context.session.agent_access === 'read' && (tool === 'Edit' || tool === 'Write')) {
      return decision(false, '你是只读子智能体，不能修改文件；请在最终回复中说明需要的修改。');
    }
    if (tool === 'ExitPlanMode') return decision(false, '请在最终回复中展示方案并结束本轮；用户可以通过网页模式菜单切换到 Normal 后请求执行。');
    const cwd = await workspacePath(root, String(input.cwd ?? '.'));
    if (tool === 'Bash') {
      if (typeof args.command !== 'string') return decision(false, '命令无效');
      const background = args.run_in_background === true;
      await services.verifyShell();
      if (yolo) {
        const approved = await services.approve('Bash', { ...args, cwd });
        if (approved.decision !== 'allow') return decision(false, approved.reason ?? '用户拒绝执行');
        await services.verifyShell();
      }
      const local = services.context.project.execution_mode === 'local';
      const shell = local ? services.context.project.host_shell : path.join(root, '.bin', 'remote-shell');
      if (!shell) return yolo ? decision(true, 'YOLO：本系统自动批准') : nativeDecision();
      const updatedInput = {
        ...args,
        command: `cd ${quoteShell(cwd)} && ${quoteShell(shell)} ${background ? '--background ' : ''}-c ${quoteShell(args.command)}`,
      };
      return yolo ? decision(true, `YOLO：本系统自动批准，命令在${local ? '宿主机' : '开发机'}执行`, updatedInput) : nativeDecision(updatedInput);
    }
    if (['Read', 'Edit', 'Write'].includes(tool)) {
      if (typeof args.file_path !== 'string') return decision(false, '文件路径无效');
      const planRoot = path.join(services.context.runtime_home, '.claude', 'plans');
      const target = path.resolve(cwd, args.file_path);
      if (planning && target.startsWith(`${planRoot}${path.sep}`) && target.endsWith('.md')) {
        await workspacePath(planRoot, target, tool !== 'Read');
        return nativeDecision();
      }
      await workspacePath(root, path.resolve(cwd, args.file_path), tool !== 'Read');
      if (tool !== 'Read') await assertWritable(services.context, path.resolve(cwd, args.file_path));
      if (!yolo) return nativeDecision();
      const approved = await services.approve(tool, args);
      if (approved.decision === 'allow') await workspacePath(root, path.resolve(cwd, args.file_path), true);
      return decision(approved.decision === 'allow', approved.reason ?? '文件修改审批');
    }
    if (['Glob', 'Grep'].includes(tool)) {
      await workspacePath(root, path.resolve(cwd, String(args.path ?? '.')));
      const filePattern = String((tool === 'Glob' ? args.pattern : args.glob) ?? '');
      if (filePattern.split(/[\\/]/).some((part) => ['.bin', '.git', '.claude', '.codex'].includes(part))) {
        return decision(false, '不能搜索工作区运行配置或 Git 内部目录');
      }
      if (tool === 'Glob') {
        const pattern = String(args.pattern ?? '');
        if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
          return decision(false, 'Glob 模式必须位于当前项目目录内');
        }
      }
      if (!yolo) return nativeDecision();
      const approved = await services.approve(tool, args);
      return decision(approved.decision === 'allow', approved.reason ?? '搜索审批');
    }
    if (['WebFetch', 'WebSearch', 'Agent'].includes(tool)) {
      // A worktree agent writes Git internals, and a remote one runs in Anthropic's cloud, beyond these checks.
      if (tool === 'Agent' && args.isolation !== undefined) return decision(false, '当前工作台不支持 isolation，请在当前项目中直接运行子智能体');
      if (tool === 'Agent' && args.cwd !== undefined) await workspacePath(root, path.resolve(cwd, String(args.cwd)));
      if (!yolo) return nativeDecision();
      const approved = await services.approve(tool, args);
      return decision(approved.decision === 'allow', approved.reason ?? '工具审批');
    }
    // A subagent delivers its report to the conversation through this tool; it touches nothing else.
    if (tool === 'SubagentHandback') return nativeDecision();
    return decision(false, `当前工作台未启用工具 ${tool}`);
  } catch (error) {
    return decision(false, error instanceof Error ? error.message : '工具路径或审批校验失败');
  }
}
