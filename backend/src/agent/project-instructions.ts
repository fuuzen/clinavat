import path from 'node:path';
import { quoteShell } from './environment.js';
import type { AgentContext } from './types.js';

export function projectInstructions(project: AgentContext['project'], engine: 'claude' | 'codex'): string {
  if (project.execution_mode === 'local') {
    return 'Work directly in the current project directory using native file and shell tools. Do not edit Git internals or files outside this project. Do not start background or detached commands.';
  }
  const paths = `The project root is ${JSON.stringify(project.local_path)}. File tools and project shell commands use this same project path.`;
  const execution = engine === 'codex'
    ? `Use native tools to read and search the local source mirror, including local cat, sed and rg commands. Use native apply_patch to edit local source files. Builds, tests, dependency installation, git operations, application commands and services MUST run on the development host. Execute those through your native command tool using ${quoteShell(path.join(project.local_path, '.bin', 'remote-shell'))} -c '<remote command>', from the corresponding local project working directory. Local read and search commands do not need this wrapper. If the workspace sandbox blocks SSH or Mutagen access, request the sandbox permissions needed for the wrapper command; never fall back to running the workload locally. Do not use legacy remote_command or workspace_* tools.`
    : 'Use Read, Glob and Grep to inspect source files, and Edit and Write to modify them. Bash commands are automatically routed to the development host by the workspace hook, with synchronization barriers before and after execution. Do not invoke the remote-shell wrapper manually inside Bash.';
  return `This project uses a split execution environment. ${paths}\n\n${execution}\n\nLocal source edits are synchronized to the development host. Do not edit .bin, .git, .claude, .codex or files outside this project. Do not start background or detached commands.`;
}
