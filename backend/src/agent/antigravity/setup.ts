import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { privateSubdirectory } from '../../accounts/credential-files.js';
import { atomicWrite } from '../../runtime/process.js';
import { quoteShell, vmProjectRoot, vmWorkingDirectory } from '../environment.js';
import {
  isClientDirect, isClientMirrored, isSuperAgent, nativeReadDenied, superNativeReadLimit, superReadModeOf,
} from '../orchestration-tools.js';
import type { AgentContext } from '../types.js';
import { toolShimProgram } from './tool-bridge.js';
import { hookProgram } from './hook-program.js';

/**
 * Repository files agy loads at the start of every session, even in a folder it was never asked to trust. They run
 * commands in the slot's machine, which holds the account's login, so a project with any of them is refused.
 */
const executableCustomizations = ['.agents/hooks.json', '.agents/mcp_config.json', '.agents/plugins.json', '.agents/plugins'];

/** Project paths no agent may read or write, as for Claude Code; the last ones would let an agent plant the files above. */
const protectedTargets = ['.bin/', '.git/', '.claude/', '.codex/', ...executableCustomizations.map(file => file.endsWith('.json') ? file : `${file}/`)];

/** What agy prefixes to the output of a command a hook rewrote; its absence means a command ran without routing. */
export const rewrittenCommandNotice = 'A pre-tool hook changed the arguments of this tool call before it ran.';

/** The shared Stop log starts over at the next run beyond this size; runs still reading it notice and start from the top. */
const stopLogLimit = 1024 * 1024;

export interface AntigravityHome {
  /** Where the Stop hook records each end of agy's execution loop, for every agy on the slot. */
  stopLog: string;
  /** Where the log ended when this run prepared it; earlier records belong to other runs. */
  stopOffset: number;
  /** The wrapper commands are routed through; null where they run beside the CLI. */
  shell: string | null;
  /** The stdio MCP server that carries a master agent's calls to the Hub. */
  toolShim: string;
  hookEnvironment: NodeJS.ProcessEnv;
  resetReadBudget(): Promise<void>;
  close(): Promise<void>;
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Writes the settings and hooks agy reads from the slot home, before every start: a user's profile can bring older ones. */
export async function prepareAntigravityHome(context: AgentContext, workspaceDir?: string): Promise<AntigravityHome> {
  const direct = isClientDirect(context);
  const mirrored = isClientMirrored(context);
  const hubRoot = context.project.local_path;
  const vmRoot = vmProjectRoot(context, workspaceDir);
  const vmCwd = vmWorkingDirectory(context, workspaceDir);
  if (!direct) {
    const found = [];
    for (const file of executableCustomizations) if (await exists(path.join(hubRoot, file))) found.push(file);
    if (found.length) {
      throw new Error(`项目包含 Antigravity 会在槽位虚拟机中执行的工作区配置（${found.join('、')}），已拒绝启动。请移除这些文件或改用其他 CLI。`);
    }
  }
  const home = context.runtime_home;
  const local = context.project.execution_mode === 'local';
  const shell = direct ? null : local ? context.project.host_shell ?? null : path.posix.join(vmRoot, '.bin', 'remote-shell');
  const cli = await privateSubdirectory(home, '.gemini/antigravity-cli');
  const config = await privateSubdirectory(home, '.gemini/config');
  const hook = path.join(config, 'clinavat-hook.py');
  const stopLog = path.join(home, '.clinavat-agy-stop.jsonl');
  const toolShim = path.join(config, 'clinavat-mcp.py');
  const run = (...args: string[]) => ['python3', '-I', hook, ...args].map(quoteShell).join(' ');
  const superAgent = isSuperAgent(context);
  const readMode = direct ? 'off' : superAgent ? superReadModeOf(context.session) : 'normal';
  const counter = readMode === 'full' ? path.join(config, `clinavat-read-${randomUUID()}.count`) : undefined;
  const preToolUse = (matcher: string, ...args: string[]) =>
    ({ matcher, hooks: [{ type: 'command', command: run(...args), timeout: 30 }] });
  const hooks = { clinavat: {
    PreToolUse: direct
      ? [preToolUse('.*', 'btw-gate'), preToolUse('.*', 'direct')]
      : [
          preToolUse('.*', 'btw-gate'),
          preToolUse('^run_command$', 'command'),
          preToolUse('^(read_file|view_file|view_file_outline|grep_search|find_by_name|list_dir)$', 'read'),
          preToolUse('^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|run_workflow)$', 'write'),
          // A subagent's permission requests never reach an ACP client, so its commands would wait and fail.
          preToolUse('^(invoke_subagent|define_subagent|manage_subagents)$', 'deny', 'Subagents are disabled in this workspace; do the work yourself.'),
        ],
    Stop: [{ type: 'command', command: run('stop', stopLog), timeout: 10 }],
  } };
  const settings = {
    allowNonWorkspaceAccess: false, toolPermission: 'request-review', enableTerminalSandbox: false,
    // Spending paid credits once the plan's quota runs out is the account owner's decision, not a conversation's.
    useG1Credits: false,
    permissions: { deny: protectedTargets.flatMap(target => [`read_file(${target})`, `write_file(${target})`]) },
  };
  await atomicWrite(hook, hookProgram);
  await atomicWrite(path.join(config, 'hooks.json'), JSON.stringify(hooks));
  // The swarm plugin lets the agent start coordinated workers that spend quota in parallel.
  await atomicWrite(path.join(config, 'config.json'), JSON.stringify({ plugins: { swarm: { enabled: false } } }));
  await atomicWrite(path.join(cli, 'settings.json'), JSON.stringify(settings));
  // Other agy runs on the slot may still be reading the log, so it is only started over when it grows large.
  const stopEntry = await lstat(stopLog).catch(() => undefined);
  let stopOffset = stopEntry?.isFile() ? stopEntry.size : -1;
  if (stopOffset < 0 || stopOffset > stopLogLimit) {
    await atomicWrite(stopLog, '');
    stopOffset = 0;
  }
  await atomicWrite(toolShim, toolShimProgram);
  const hookEnvironment: NodeJS.ProcessEnv = {
    CLINAVAT_AGY_ROOT: vmRoot,
    CLINAVAT_AGY_CWD: vmCwd,
    CLINAVAT_AGY_BRAIN_ROOT: path.join(cli, 'brain'),
    CLINAVAT_AGY_ACCESS: superAgent ? 'super' : context.session.agent_access ?? 'write',
    CLINAVAT_AGY_MODE: readMode,
    CLINAVAT_AGY_SHELL: shell ?? '',
    CLINAVAT_AGY_READ_COUNTER: counter,
    CLINAVAT_AGY_READ_DENIAL: nativeReadDenied(context),
    CLINAVAT_AGY_READ_LIMIT: String(superNativeReadLimit),
    CLINAVAT_AGY_CLIENT_MODE: direct ? 'direct' : mirrored ? 'mirrored' : '',
    CLINAVAT_AGY_CLIENT_PLATFORM: context.host?.platform ?? '',
    CLINAVAT_AGY_CLIENT_ROOT: context.host?.kind === 'client' ? context.project.remote_path : '',
    CLINAVAT_AGY_VM_ROOT: vmRoot,
    CLINAVAT_AGY_AGENT_DIR: context.session.agent_directory ?? '',
  };
  return { stopLog, stopOffset, shell, toolShim, hookEnvironment,
    resetReadBudget: async () => { if (counter) await atomicWrite(counter, '0'); },
    close: async () => { if (counter) await rm(counter, { force: true }); } };
}
