import path from 'node:path';
import { quoteShell } from './environment.js';
import type { AgentEngine } from './engines.js';
import type { AgentContext } from './types.js';

interface EngineInstructions {
  background: string;
  /** How a local project's commands reach the host through `shell`. */
  hostShell(shell: string): string;
  /** How a mirrored project's commands reach the development host through `remoteShell`. */
  split(remoteShell: string): string;
}

const instructions: Record<AgentEngine, EngineInstructions> = {
  claude: {
    background: 'To run a command in the background, set `run_in_background: true` on the Bash tool call. Keep the command attached to its shell so Claude Code can track it, collect its output, and stop it.',
    hostShell: () => 'Use Read, Glob and Grep to inspect source files, and Edit and Write to modify them. Bash commands are automatically routed to the host machine over SSH, in the same directory. Do not invoke the host-shell wrapper manually inside Bash.',
    split: () => 'Use Read, Glob and Grep to inspect source files, and Edit and Write to modify them. Bash commands are automatically routed to the development host by the workspace hook, with synchronization barriers before and after execution. Do not invoke the remote-shell wrapper manually inside Bash.',
  },
  codex: {
    background: 'Do not start background or detached commands.',
    hostShell: shell => `Use native tools to read and search files, including local cat, sed and rg commands, and native apply_patch to edit them. Builds, tests, dependency installation, git operations, application commands and services MUST run on the host machine. Execute those through your native command tool using ${quoteShell(shell)} -c '<host command>', from the corresponding project working directory. Local read and search commands do not need this wrapper. If the workspace sandbox blocks SSH, request the sandbox permissions needed for the wrapper command; never fall back to running the workload locally.`,
    split: remoteShell => `Use native tools to read and search the local source mirror, including local cat, sed and rg commands. Use native apply_patch to edit local source files. Builds, tests, dependency installation, git operations, application commands and services MUST run on the development host. Execute those through your native command tool using ${quoteShell(remoteShell)} -c '<remote command>', from the corresponding local project working directory. Local read and search commands do not need this wrapper. If the workspace sandbox blocks SSH or Mutagen access, request the sandbox permissions needed for the wrapper command; never fall back to running the workload locally.`,
  },
  // A hook rewrites every run_command; each command holds the project's command lock until it ends, daemons excepted.
  antigravity: {
    background: 'Run commands one at a time and wait for each to finish before starting the next. Start long-running services such as development servers as daemons.',
    hostShell: () => 'Use your file tools to read, search and edit files. Commands are automatically routed to the host machine over SSH, in the same directory. Do not invoke the host-shell wrapper yourself.',
    split: () => 'Use your file tools to read, search and edit the local source mirror. Commands are automatically routed to the development host, with synchronization barriers before and after execution. Do not invoke the remote-shell wrapper yourself.',
  },
};

export function projectInstructions(project: AgentContext['project'], engine: AgentEngine): string {
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
