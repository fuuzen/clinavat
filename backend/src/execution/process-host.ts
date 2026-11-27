import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
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

  constructor(config: { claudeBinary: string; codexBinary: string; agyBinary: string; mutagenBinary: string; sshBinary: string }) {
    this.binaries = { claude: config.claudeBinary, codex: config.codexBinary, agy: config.agyBinary, mutagen: config.mutagenBinary,
      ssh: config.sshBinary };
  }

  baseEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of inheritedVariables) if (process.env[name]) environment[name] = process.env[name];
    return environment;
  }

  async binary(_scope: unknown, name: ExecutionBinary): Promise<string> {
    return ['claude', 'codex', 'agy'].includes(name) ? findExecutable(this.binaries[name]) : this.binaries[name];
  }

  async spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
    let cwd = options.cwd;
    for (const mount of options.scope.mounts ?? []) {
      const target = mount.target ?? mount.source;
      if (target === mount.source) continue;
      if (cwd === target) { cwd = mount.source; break; }
      if (cwd.startsWith(`${target}/`)) { cwd = join(mount.source, cwd.slice(target.length + 1)); break; }
    }
    return spawn(binary, args, {
      cwd, env: { ...options.env, ...options.secrets }, detached: process.platform !== 'win32',
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  }

  run(binary: string, args: string[], options: ExecutionRunOptions) {
    return runCommand(binary, args, {
      cwd: options.cwd, env: childEnvironment(options.env), timeout: options.timeout, maxBytes: options.maxBytes, input: options.input,
    });
  }

  async ensureWorkspace(): Promise<void> { /* Host processes run directly on the Hub machine. */ }

  assertReleased(home: string, sessionId?: string, workspaceCgroups?: ReadonlySet<string>): Promise<void> {
    return assertSlotProcessesStopped(home, sessionId, workspaceCgroups);
  }

  async loginCommand(_slotId: string, _home: string, argv: string[], env: Record<string, string>): Promise<string> {
    return [...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`), ...argv.map(shellQuote)].join(' ');
  }

  async revoke(): Promise<void> { /* Host processes already share one filesystem view. */ }

  async retire(): Promise<void> { /* Host processes have no machine of their own. */ }

  async health() {
    const available = (binary: string) => findExecutable(binary).then(() => true, () => false);
    const [claude, codex, agy, mutagen, ssh] = await Promise.all((['claude', 'codex', 'agy', 'mutagen', 'ssh'] as const)
      .map(name => available(this.binaries[name])));
    return { kind: this.kind, claude, codex, agy, mutagen, ssh };
  }
}
