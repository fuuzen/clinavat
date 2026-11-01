import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findExecutable } from '../agent/environment.js';
import { assertSlotProcessesStopped } from '../accounts/slot-runtime/processes.js';
import { runCommand } from '../runtime/process.js';
import type { ExecutionBinaries, ExecutionHost, ExecutionRunOptions, ExecutionSpawnOptions } from './types.js';

const inheritedVariables = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

/** Runs every process directly on the Hub machine as the Hub's own system user. */
export class ProcessExecutionHost implements ExecutionHost {
  readonly kind = 'process' as const;
  readonly binaries: ExecutionBinaries;

  constructor(config: { claudeBinary: string; codexBinary: string; mutagenBinary: string; sshBinary: string }) {
    this.binaries = {
      claude: config.claudeBinary, codex: config.codexBinary, mutagen: config.mutagenBinary,
      ssh: config.sshBinary,
    };
  }

  baseEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of inheritedVariables) if (process.env[name]) environment[name] = process.env[name];
    return environment;
  }

  resolveBinary(_userId: string, binary: string): Promise<string> { return findExecutable(binary); }

  async spawn(binary: string, args: string[], options: ExecutionSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
    return spawn(binary, args, {
      cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  }

  run(binary: string, args: string[], options: ExecutionRunOptions) {
    return runCommand(binary, args, {
      cwd: options.cwd, env: options.env, timeout: options.timeout, maxBytes: options.maxBytes, input: options.input,
    });
  }

  assertReleased(home: string, sessionId?: string): Promise<void> { return assertSlotProcessesStopped(home, sessionId); }

  async revoke(): Promise<void> { /* Host processes already share one filesystem view. */ }

  async health() {
    const available = (binary: string) => findExecutable(binary).then(() => true, () => false);
    const [claude, codex, mutagen, ssh] = await Promise.all([
      available(this.binaries.claude), available(this.binaries.codex), available(this.binaries.mutagen), available(this.binaries.ssh),
    ]);
    return { kind: this.kind, claude, codex, mutagen, ssh };
  }
}
