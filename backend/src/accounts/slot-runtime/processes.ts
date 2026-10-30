import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const sessionManagers = new Set(['systemd', '(sd-pam)', 'ssh-agent', 'sshd', 'sshd-session']);
interface ProcessIdentity { start: string; state: string }

async function processIdentity(pid: string): Promise<ProcessIdentity> {
  const contents = await readFile(join('/proc', pid, 'stat'), 'utf8');
  const fields = contents.slice(contents.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error('进程身份无效');
  return { start: fields[19], state: fields[0]! };
}

const exited = (identity: ProcessIdentity) => ['Z', 'X', 'x'].includes(identity.state);

export async function assertSlotProcessesStopped(home: string, sessionId?: string): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('槽位交接需要 Linux /proc 进程检查');
  const expected = resolve(home);
  const survivors: string[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let identity: ProcessIdentity | undefined;
    try {
      if ((await stat(join('/proc', pid))).uid !== process.getuid()) continue;
      identity = await processIdentity(pid);
      if (exited(identity)) continue;
      const environment = await readFile(join('/proc', pid, 'environ'));
      const entries = environment.toString().split('\0');
      if (sessionId && !entries.includes(`CLINAVAT_SESSION_ID=${sessionId}`) && !entries.includes(`CC_POOL_SESSION_ID=${sessionId}`)) continue;
      const matches = entries.some(entry => {
        if (entry.startsWith('HOME=')) return resolve(entry.slice(5)) === expected;
        if (entry.startsWith('CODEX_HOME=')) return resolve(dirname(entry.slice(11))) === expected;
        if (entry.startsWith('CLAUDE_CONFIG_DIR=')) return resolve(dirname(entry.slice(18))) === expected;
        return false;
      });
      if (matches) survivors.push(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || '';
      if (['ENOENT', 'ESRCH'].includes(code)) continue;
      if (['EACCES', 'EPERM'].includes(code)) {
        const current = await processIdentity(pid).catch((failure: NodeJS.ErrnoException) => {
          if (['ENOENT', 'ESRCH'].includes(failure.code ?? '')) return undefined;
          throw new Error(`无法确认进程 ${pid} 是否已释放槽位，已暂停槽位交接`);
        });
        if (!current || exited(current)) continue;
        const name = await readFile(join('/proc', pid, 'comm'), 'utf8').catch(() => '');
        if (identity?.start === current.start && sessionManagers.has(name.trim())) continue;
      }
      throw new Error(`无法确认进程 ${pid} 是否已释放槽位，已暂停槽位交接`);
    }
  }
  if (survivors.length) throw new Error(`槽位仍有后台进程 ${survivors.join(', ')}，已保留用户数据并暂停交接，请停止进程后重启 Hub`);
}
