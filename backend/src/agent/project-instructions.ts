import path from 'node:path';
import { quoteShell } from './environment.js';
import type { AgentEngine } from './engines.js';
import type { AgentContext, AgentWorkspaceBridge } from './types.js';
import { isClientDirect, isClientMirrored, isClientProject, isSuperAgent, orchestrates } from './orchestration-tools.js';
import { normalizePlatform } from '../client-host/path-utils.js';
import { childInstructions, masterInstructions, superAgentInstructions } from '../orchestration/instructions.js';

interface EngineInstructions {
  background: string;
  hostShell(shell: string): string;
  split(remoteShell: string): string;
  clientDirectPrefix: string;
}

const instructions: Record<AgentEngine, EngineInstructions> = {
  claude: {
    background: 'To run a command in the background, set `run_in_background: true` on the Bash tool call. Keep the command attached to its shell so Claude Code can track it, collect its output, and stop it.',
    hostShell: () => 'Use Read, Glob and Grep to inspect source files, and Edit and Write to modify them. Bash commands are automatically routed to the host machine over SSH, in the same directory. Do not invoke the host-shell wrapper manually inside Bash.',
    split: () => 'Use Read, Glob and Grep to inspect source files, and Edit and Write to modify them. Bash commands are automatically routed to the development host by the workspace hook, with synchronization barriers before and after execution. Do not invoke the remote-shell wrapper manually inside Bash.',
    clientDirectPrefix: 'mcp__clinavat__',
  },
  codex: {
    background: 'Do not start background or detached commands.',
    hostShell: shell => `Use native tools to read and search files, including local cat, sed and rg commands, and native apply_patch to edit them. Builds, tests, dependency installation, git operations, application commands and services MUST run on the host machine. Execute those through your native command tool using ${quoteShell(shell)} -c '<host command>', from the corresponding project working directory. Local read and search commands do not need this wrapper. If the workspace sandbox blocks SSH, request the sandbox permissions needed for the wrapper command; never fall back to running the workload locally.`,
    split: remoteShell => `Use native tools to read and search the local source mirror, including local cat, sed and rg commands. Use native apply_patch to edit local source files. Builds, tests, dependency installation, git operations, application commands and services MUST run on the development host. Execute those through your native command tool using ${quoteShell(remoteShell)} -c '<remote command>', from the corresponding local project working directory. Local read and search commands do not need this wrapper. If the workspace sandbox blocks SSH or Mutagen access, request the sandbox permissions needed for the wrapper command; never fall back to running the workload locally.`,
    clientDirectPrefix: 'clinavat.',
  },
  antigravity: {
    background: 'Run commands one at a time and wait for each to finish before starting the next. Start long-running services such as development servers as daemons.',
    hostShell: () => 'Use your file tools to read, search and edit files. Commands are automatically routed to the host machine over SSH, in the same directory. Do not invoke the host-shell wrapper yourself.',
    split: () => 'Use your file tools to read, search and edit the local source mirror. Commands are automatically routed to the development host, with synchronization barriers before and after execution. Do not invoke the remote-shell wrapper yourself.',
    clientDirectPrefix: 'mcp_clinavat_',
  },
};

const MAX_INSTRUCTION_FILE_BYTES = 32 * 1024;
const INSTRUCTION_READ_TIMEOUT_MS = 4_000;
const CLIENT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

function clientOsOverride(context: AgentContext): string {
  const host = context.host!;
  const platform = normalizePlatform(host.platform ?? (context.project.remote_path.match(/^[A-Za-z]:[\\/]/) ? 'windows' : 'linux'));
  const osLabel = platform === 'windows' ? 'Windows' : platform === 'macos' ? 'macOS' : 'Linux';
  const shell = host.default_shell || (platform === 'windows' ? 'powershell' : platform === 'macos' ? 'zsh' : 'bash');
  const workspaceDir = context.session.agent_directory
    ? (platform === 'windows'
      ? `${context.project.remote_path.replace(/[\\/]+$/, '')}\\${context.session.agent_directory.replace(/\//g, '\\')}`
      : `${context.project.remote_path.replace(/\/+$/, '')}/${context.session.agent_directory}`)
    : context.project.remote_path;
  const shellHint = platform === 'windows'
    ? 'Write commands compatible with Windows and its default shell (avoid POSIX-only syntax unless explicitly invoking bash).'
    : platform === 'macos'
      ? 'Write commands compatible with macOS / BSD userland tools (e.g. BSD sed/stat flags).'
      : 'Write commands compatible with Linux and the target shell.';
  return [
    '## Target OS & Shell Override',
    'IMPORTANT: Although this CLI process runs inside a Linux sandbox, the user\'s project lives on their client device. Always target the client environment below:',
    `- Target OS: ${osLabel}${host.os_version ? ` (${host.os_version})` : ''}${host.arch ? ` [${host.arch}]` : ''}`,
    ...(host.device_name ? [`- Client device: ${host.device_name}`] : []),
    `- Default shell: ${shell}`,
    `- Real client workspace path: ${JSON.stringify(workspaceDir)}`,
    `- Command guidance: ${shellHint}`,
  ].join('\n');
}

async function readSingleInstructionFile(
  workspaces: AgentWorkspaceBridge,
  hostId: string,
  remotePath: string,
  filename: string,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const readPromise = workspaces.readSlice(hostId, remotePath, filename, 0, MAX_INSTRUCTION_FILE_BYTES);
    void readPromise.catch(() => undefined);
    const slice = await Promise.race([
      readPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), INSTRUCTION_READ_TIMEOUT_MS);
      }),
    ]);
    if (slice.isBinary || !slice.buffer.length) return null;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(slice.buffer).trim();
    if (!text) return null;
    const truncated = slice.size > slice.buffer.length ? '\n[... truncated]' : '';
    return `## Project instructions (${filename})\n${text}${truncated}`;
  } catch {
    // Client offline, slow, or instruction file absent; degrade gracefully without interrupting the conversation.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readClientInstructionFiles(context: AgentContext, workspaces?: AgentWorkspaceBridge): Promise<string> {
  if (!isClientDirect(context) || !workspaces) return '';
  const hostId = context.project.dev_host_id || context.host?.id;
  if (!hostId) return '';
  const results = await Promise.all(
    CLIENT_INSTRUCTION_FILES.map(filename => readSingleInstructionFile(workspaces, hostId, context.project.remote_path, filename)),
  );
  const sections = results.filter((section): section is string => section !== null);
  return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}

function clientDirectInstructions(context: AgentContext, engine: AgentEngine): string {
  const prefix = instructions[engine].clientDirectPrefix;
  const readOnly = context.session.agent_access === 'read';
  const readTools = ['client_read_file', 'client_list_dir', 'client_glob', 'client_grep'].map(name => `\`${prefix}${name}\``).join(', ');
  const writeTools = ['client_write_file', 'client_edit_file', 'client_apply_patch', 'client_exec_command', 'client_manage_task']
    .map(name => `\`${prefix}${name}\``).join(', ');
  const scopeNote = context.session.agent_directory
    ? `Your workspace root is locked to the subdirectory ${JSON.stringify(context.session.agent_directory)}; you cannot access paths outside it.`
    : 'You may pass paths relative to the project root or native absolute paths inside the real client workspace path.';
  return [
    clientOsOverride(context),
    '',
    '## Client Direct Mode',
    'Built-in local filesystem and shell tools are DISABLED because this sandbox contains no copy of the repository.',
    `- Read & search tools: ${readTools}.`,
    readOnly
      ? '- You have read-only access: file editing and command execution tools are disabled.'
      : `- Edit & execution tools: ${writeTools}.`,
    `- Path rules: ${scopeNote} Never access .git or .bin internal directories.`,
  ].join('\n');
}

function clientMirroredInstructions(context: AgentContext, engine: AgentEngine): string {
  const vmRoot = context.project.vm_path || context.project.local_path;
  const platform = normalizePlatform(context.host?.platform ?? (context.project.remote_path.match(/^[A-Za-z]:[\\/]/) ? 'windows' : 'linux'));
  const remoteShell = path.posix.join(vmRoot, '.bin', 'remote-shell');
  const { background, split } = instructions[engine];
  const winNotes = platform === 'windows'
    ? engine === 'codex'
      ? ` The mirror is mounted in this VM at ${JSON.stringify(vmRoot)}. For native apply_patch, ALWAYS use workspace-relative POSIX paths (never include ':' or '\\').`
      : ` The mirror is mounted in this VM at ${JSON.stringify(vmRoot)} (native file tools also map Windows ${JSON.stringify(context.project.remote_path)} paths to ${JSON.stringify(vmRoot)} automatically).`
    : ` The mirror is mounted in this VM at ${JSON.stringify(vmRoot)}.`;
  return [
    clientOsOverride(context),
    '',
    `This project uses Client Mirrored Mode.${winNotes}`,
    split(remoteShell),
    `Edits are synchronized with the client device before and after commands. Do not edit .bin, .git, .claude, .codex or files outside this project. ${background}`,
  ].join('\n\n');
}

/** The project instructions, then what the conversation's place among master and child agents adds. */
export async function conversationInstructions(
  context: AgentContext,
  engine: AgentEngine,
  briefing?: string,
  workspaces?: AgentWorkspaceBridge,
): Promise<string> {
  if (isSuperAgent(context)) {
    const rootLine = isClientProject(context)
      ? `${clientOsOverride(context)}\n\nThe real client project root is ${JSON.stringify(context.project.remote_path)}.`
      : `The project root is ${JSON.stringify(context.project.local_path)}.`;
    return rootLine + superAgentInstructions(context.session, briefing);
  }
  const base = await projectInstructions(context, engine, workspaces);
  return base + childInstructions(context.session) + (orchestrates(context) ? masterInstructions(briefing) : '');
}

export async function projectInstructions(
  contextOrProject: AgentContext | AgentContext['project'],
  engine: AgentEngine,
  workspaces?: AgentWorkspaceBridge,
): Promise<string> {
  const isContext = 'project' in contextOrProject;
  const context = isContext ? contextOrProject : undefined;
  const project: AgentContext['project'] = isContext ? contextOrProject.project : contextOrProject;
  if (context && isClientDirect(context)) {
    return clientDirectInstructions(context, engine) + await readClientInstructionFiles(context, workspaces);
  }
  if (context && isClientMirrored(context)) {
    return clientMirroredInstructions(context, engine);
  }
  const { background, hostShell, split } = instructions[engine];
  if (project.execution_mode === 'local' && project.host_shell) {
    return `The project directory ${JSON.stringify(project.local_path)} is shared with the host machine at the same path, so file changes are visible there immediately.\n\n${hostShell(project.host_shell)}\n\nDo not edit Git internals or files outside this project. ${background}`;
  }
  if (project.execution_mode === 'local') {
    return `Work directly in the current project directory using native file and shell tools. Do not edit Git internals or files outside this project. ${background}`;
  }
  const paths = `The project root is ${JSON.stringify(project.local_path)}. File tools and project shell commands use this same project path.`;
  return `This project uses a split execution environment. ${paths}\n\n${split(path.join(project.local_path, '.bin', 'remote-shell'))}\n\nLocal source edits are synchronized to the development host. Do not edit .bin, .git, .claude, .codex or files outside this project. ${background}`;
}
