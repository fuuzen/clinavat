#!/usr/bin/env node
// Builds a release from a commit, in a fresh clone. Agents can write to the working tree, its node_modules and its
// Git hooks, so none of those may run on the host; a commit is what an administrator can review.
//
//   node ~/.local/lib/clinavat/deploy/build-release.mjs --repo <repository> <commit>
//
// Run the installed copy of this script, not the one in the repository.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseRoot } from './environment.mjs';

// The build needs no Hub settings, and must not see any of them.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CLINAVAT_') && !name.startsWith('VITE_')));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim().slice(-1500)}`);
  return result.stdout.trim();
}

export async function buildRelease(repository, reference, root = releaseRoot()) {
  // Only reads objects; settings in the repository's own configuration do not apply to the fresh clone.
  const commit = run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repository, 'rev-parse', '--verify', `${reference}^{commit}`]);
  const label = commit.slice(0, 12);
  const source = join(root, `source-${label}`);
  const staging = join(root, `staging-${label}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const building = await mkdtemp(join(root, 'building-'));
  try {
    run('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', `file://${repository}`, building]);
    run('git', ['-C', building, 'checkout', '--quiet', '--detach', commit]);
    run('npm', ['ci', '--no-audit', '--no-fund'], building);
    run('npm', ['run', 'check'], building);
    run('npm', ['run', 'build'], building);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    await cp(join(building, 'backend/dist'), join(staging, 'backend'), { recursive: true });
    await cp(join(building, 'frontend/dist'), join(staging, 'frontend'), { recursive: true });
    await rm(source, { recursive: true, force: true });
    await rm(join(building, 'node_modules'), { recursive: true, force: true });
    await cp(building, source, { recursive: true, filter: file => !file.startsWith(join(building, '.git')) });
  } finally {
    await rm(building, { recursive: true, force: true });
  }
  return { commit, source, staging };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--repo');
  const reference = process.argv.slice(2).filter((_, index, all) => all[index] !== '--repo' && all[index - 1] !== '--repo')[0];
  if (flag < 0 || !process.argv[flag + 1] || !reference) {
    console.error('用法：node deploy/build-release.mjs --repo <仓库目录> <提交>');
    process.exitCode = 64;
  } else {
    try {
      const { commit, source, staging } = await buildRelease(resolve(process.argv[flag + 1]), reference);
      const scripts = dirname(fileURLToPath(import.meta.url));
      console.log(`已构建 ${commit}`);
      console.log(`只有代码变化时发布：node --no-warnings ${join(scripts, 'release.mjs')} publish ${staging}`);
      console.log(`依赖或部署脚本也变化时安装：node ${join(scripts, 'host.mjs')} install --source ${source}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
