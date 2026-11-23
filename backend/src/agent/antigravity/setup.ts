import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { privateSubdirectory } from '../../accounts/credential-files.js';
import { atomicWrite } from '../../runtime/process.js';
import { quoteShell } from '../environment.js';
import { isSuperAgent } from '../orchestration-tools.js';
import type { AgentContext } from '../types.js';
import { toolShimProgram } from './tool-bridge.js';

/**
 * Repository files agy loads at the start of every session, even in a folder it was never asked to trust. They run
 * commands in the slot's machine, which holds the account's login, so a project with any of them is refused.
 */
const executableCustomizations = ['.agents/hooks.json', '.agents/mcp_config.json', '.agents/plugins.json', '.agents/plugins'];

/** Project paths no agent may read or write, as for Claude Code; the last ones would let an agent plant the files above. */
const protectedTargets = ['.bin/', '.git/', '.claude/', '.codex/', ...executableCustomizations.map(file => file.endsWith('.json') ? file : `${file}/`)];

/** Answers agy's lifecycle hooks; see `hooks` below. Any failure denies, so a broken hook never runs a command in place. */
const hookProgram = String.raw`
import json, shlex, sys
mode = sys.argv[1]
try:
    payload = json.load(sys.stdin)
    if mode == 'stop':
        fields = ('conversationId', 'fullyIdle', 'terminationReason')
        with open(sys.argv[2], 'a') as log:
            log.write(json.dumps({key: payload.get(key) for key in fields}) + '\n')
        print('{}')
    elif mode == 'deny':
        print(json.dumps({'decision': 'deny', 'reason': sys.argv[2]}))
    else:
        shell = sys.argv[2]
        arguments = (payload.get('toolCall') or {}).get('args') or {}
        command = arguments.get('CommandLine')
        if not shell:
            print(json.dumps({'decision': 'ask'}))
        else:
            if not isinstance(command, str):
                raise ValueError('missing command')
            background = ' --background' if arguments.get('IsDaemon') is True else ''
            directory = payload.get('cwd') or '.'
            routed = 'cd %s && %s%s -c %s' % (shlex.quote(directory), shlex.quote(shell), background, shlex.quote(command))
            print(json.dumps({'decision': 'ask', 'overwrite': {'CommandLine': routed}}))
except Exception as error:
    print(json.dumps({'decision': 'deny', 'reason': 'Clinavat hook failed: %s' % error}))
`;

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
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Writes the settings and hooks agy reads from the slot home, before every start: a user's profile can bring older ones. */
export async function prepareAntigravityHome(context: AgentContext): Promise<AntigravityHome> {
  const root = context.project.local_path;
  const found = [];
  for (const file of executableCustomizations) if (await exists(path.join(root, file))) found.push(file);
  if (found.length) {
    throw new Error(`项目包含 Antigravity 会在槽位虚拟机中执行的工作区配置（${found.join('、')}），已拒绝启动。请移除这些文件或改用其他 CLI。`);
  }
  const home = context.runtime_home;
  const local = context.project.execution_mode === 'local';
  const shell = local ? context.project.host_shell ?? null : path.join(root, '.bin', 'remote-shell');
  const cli = await privateSubdirectory(home, '.gemini/antigravity-cli');
  const config = await privateSubdirectory(home, '.gemini/config');
  const hook = path.join(config, 'clinavat-hook.py');
  const stopLog = path.join(home, '.clinavat-agy-stop.jsonl');
  const toolShim = path.join(config, 'clinavat-mcp.py');
  const run = (...args: string[]) => ['python3', '-I', hook, ...args].map(quoteShell).join(' ');
  const superAgent = isSuperAgent(context);
  const deny = (tool: string, reason = 'Subagents are disabled in this workspace; do the work yourself.') =>
    ({ matcher: tool, hooks: [{ type: 'command', command: run('deny', reason), timeout: 30 }] });
  const superDenyReason = 'You are running in Super Agent (delegate-first) mode and cannot directly edit files or run commands; delegate implementation and command execution to child agents using the clinavat tools.';
  const readOnlyDenyReason = 'You are a read-only child agent and cannot modify files; describe the changes you need in your final reply.';
  const hooks = { clinavat: {
    PreToolUse: [
      ...(superAgent
        ? ['run_command', 'write_file', 'edit_file', 'run_workflow'].map(tool => deny(tool, superDenyReason))
        : [{ matcher: 'run_command', hooks: [{ type: 'command', command: run('command', shell ?? ''), timeout: 30 }] }]),
      // A subagent's permission requests never reach an ACP client, so its commands would wait and fail.
      ...['invoke_subagent', 'define_subagent', 'manage_subagents'].map(tool => deny(tool)),
      ...(!superAgent && context.session.agent_access === 'read'
        ? ['write_file', 'edit_file'].map(tool => deny(tool, readOnlyDenyReason))
        : []),
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
  return { stopLog, stopOffset, shell, toolShim };
}
