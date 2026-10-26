import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { CommandResult } from './types.js';

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBytes?: number;
}

export async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, {mode, flag: 'wx'});
    await rename(temporary, path);
  } finally { await rm(temporary, {force: true}); }
}

export function runCommand(binary: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd, env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const terminate = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => {
      failure = new Error(`${binary} 执行超时`);
      terminate();
    }, options.timeout ?? 30_000);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) {
        failure = new Error(`${binary} 输出超过大小限制`);
        terminate();
      } else target.push(chunk);
    };
    child.stdout.on('data', collect(output));
    child.stderr.on('data', collect(errors));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      resolve({stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString(), code: code ?? 1});
    });
  });
}

export async function checkedCommand(binary: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const result = await runCommand(binary, args, options);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${binary} 退出码 ${result.code}`).trim().slice(0, 4000));
  return result;
}
