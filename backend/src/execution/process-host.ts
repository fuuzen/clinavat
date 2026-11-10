import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findExecutable } from '../agent/environment.js';
import { assertSlotProcessesStopped } from '../accounts/slot-runtime/processes.js';
import { childEnvironment, runCommand } from '../runtime/process.js';
import { shellQuote } from '../runtime/types.js';
import type { ExecutionBinary, ExecutionHost, ExecutionRunOptions, ExecutionSpawnOptions } from './types.js';

const inheritedVariables = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/** Runs every process directly on the Hub machine as the Hub's own system user. */
export class ProcessExecutionHost implements ExecutionHost {
  readonly kind = 'process' as const;
  private readonly binaries: Record<ExecutionBinary, string>;

  constructor(config: { claudeBinary: string; codexBinary: string; mutagenBinary: string; sshBinary: string }) {
    this.binaries = { claude: config.claudeBinary, codex: config.codexBinary, mutagen: config.mutagenBinary, ssh: config.sshBinary };
  }

  baseEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of inheritedVariables) if (process.env[name]) environment[name] = process.env[name];
    return environment;
  }

  async binary(_scope: unknown, name: ExecutionBinary): Promise<string> {
    return name === 'claude' || name === 'codex' ? findExecutable(this.binaries[name]) : this.binaries[name];
  }

  async spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
    return spawn(binary, args, {
      cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  }

  run(binary: string, args: string[], options: ExecutionRunOptions) {
    return runCommand(binary, args, {
      cwd: options.cwd, env: childEnvironment(options.env), timeout: options.timeout, maxBytes: options.maxBytes, input: options.input,
    });
  }

  assertReleased(home: string, sessionId?: string, workspaceCgroups?: ReadonlySet<string>): Promise<void> {
    return assertSlotProcessesStopped(home, sessionId, workspaceCgroups);
  }

  async loginCommand(_slotId: string, _home: string, argv: string[], env: Record<string, string>): Promise<string> {
    return [...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`), ...argv.map(shellQuote)].join(' ');
  }

  async revoke(): Promise<void> { /* Host processes already share one filesystem view. */ }

  async health() {
    const available = (binary: string) => findExecutable(binary).then(() => true, () => false);
    const [claude, codex, mutagen, ssh] = await Promise.all((['claude', 'codex', 'mutagen', 'ssh'] as const)
      .map(name => available(this.binaries[name])));
    return { kind: this.kind, claude, codex, mutagen, ssh };
  }
}
