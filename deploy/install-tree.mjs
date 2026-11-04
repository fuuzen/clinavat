import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const exists = path => access(path).then(() => true, () => false);

// The Hub never runs from the source tree: a local project, including this repository, is writable by agents.
const copied = ['package.json', 'package-lock.json', 'backend/package.json', 'frontend/package.json', 'backend/dist', 'frontend/dist', 'deploy'];

/** Builds a complete tree next to the target, with production dependencies installed from the lockfile. */
export async function stageInstall(source, target) {
  const next = `${target}.next`;
  await rm(next, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(next, { mode: 0o700 });
  for (const item of copied) {
    await mkdir(dirname(join(next, item)), { recursive: true, mode: 0o700 });
    await cp(join(source, item), join(next, item), { recursive: true, filter: file => basename(file) !== '__pycache__' });
  }
  const installed = spawnSync('npm', ['ci', '--omit=dev', '--workspace', 'backend', '--no-audit', '--no-fund'],
    { cwd: next, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (installed.status !== 0) throw new Error(`安装运行依赖失败：${(installed.stderr || installed.stdout).trim().slice(-800)}`);
  return next;
}

/** Puts a staged tree in place. Returns how to undo the switch, and how to discard the old tree once all is well. */
export async function switchInstall(next, target) {
  const previous = `${target}.previous`;
  await rm(previous, { recursive: true, force: true });
  const hadPrevious = await exists(target);
  if (hadPrevious) await rename(target, previous);
  await rename(next, target);
  return {
    undo: async () => {
      await rm(target, { recursive: true, force: true });
      if (hadPrevious) await rename(previous, target);
    },
    finish: () => rm(previous, { recursive: true, force: true }),
  };
}
