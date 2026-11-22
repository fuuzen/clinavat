import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { privateSubdirectory } from '../../accounts/credential-files.js';
import { atomicWrite } from '../../runtime/process.js';
import { quoteShell } from '../environment.js';
import type { AgentContext } from '../types.js';

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

export interface AntigravityHome {
  /** Where the Stop hook records each end of agy's execution loop. */
  stopLog: string;
  /** The wrapper commands are routed through; null where they run beside the CLI. */
  shell: string | null;
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
  const run = (...args: string[]) => ['python3', '-I', hook, ...args].map(quoteShell).join(' ');
  const deny = (tool: string) => ({ matcher: tool, hooks: [{ type: 'command', command: run('deny',
    'Subagents are disabled in this workspace; do the work yourself.'), timeout: 30 }] });
  const hooks = { clinavat: {
    PreToolUse: [
      { matcher: 'run_command', hooks: [{ type: 'command', command: run('command', shell ?? ''), timeout: 30 }] },
      // A subagent's permission requests never reach an ACP client, so its commands would wait and fail.
      ...['invoke_subagent', 'define_subagent', 'manage_subagents'].map(deny),
      ...(context.session.agent_access === 'read' ? [{ matcher: 'write_file', hooks: [{ type: 'command', command: run('deny',
        'You are a read-only child agent and cannot modify files; describe the changes you need in your final reply.'), timeout: 30 }] }] : []),
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
  await atomicWrite(stopLog, '');
  return { stopLog, shell };
}
