#!/usr/bin/env node
// Builds a release from a commit, in a fresh clone. Agents can write to the working tree, its node_modules and its
// Git hooks, so none of those may run on the host; a commit is what an administrator can review.
//
//   node ~/.local/lib/clinavat/deploy/build-release.mjs --repo <repository> <commit>
//   node ~/.local/lib/clinavat/deploy/build-release.mjs --repo <repository> --working-tree
//
// --working-tree builds HEAD plus every change in the working tree, committed or not: the files Git tracks and the
// untracked ones it does not ignore. Only their content is copied into the fresh clone; the repository's
// node_modules, configuration and hooks still never run. What gets built has not been reviewed as a commit, so the
// difference from HEAD is saved as a patch beside the build.
//
// Run the installed copy of this script, not the one in the repository.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseRoot } from './environment.mjs';

// The build needs no Hub settings, and must not see any of them.
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CLINAVAT_') && !name.startsWith('VITE_')));

function run(command, args, cwd, raw = false) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${(result.stderr || result.stdout).trim().slice(-1500)}`);
  return raw ? result.stdout : result.stdout.trim();
}

// No command named in a repository's configuration runs: neither an fsmonitor nor a hook.
const git = (repository, args, raw = false) => run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], undefined, raw);

/**
 * Replaces the clone's files with the working tree's. Git only lists paths here; listing runs no filter, diff driver
 * or other configured command, and the patch is made in the clone, whose configuration is Git's own.
 */
async function copyWorkingTree(repository, clone) {
  const root = await realpath(repository);
  const paths = new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], true).split('\0').filter(Boolean));
  for (const entry of await readdir(clone)) if (entry !== '.git') await rm(join(clone, entry), { recursive: true, force: true });
  for (const path of paths) {
    const from = join(root, path);
    const metadata = await lstat(from).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; });
    // Deleted in the working tree, or a submodule.
    if (!metadata || metadata.isDirectory()) continue;
    // A tracked path below a directory since replaced by a symbolic link would be read from outside the tree.
    const parent = await realpath(dirname(from));
    if (parent !== root && !parent.startsWith(root + sep)) throw new Error(`工作区路径经符号链接指向仓库之外：${path}`);
    const to = join(clone, path);
    await mkdir(dirname(to), { recursive: true });
    if (metadata.isSymbolicLink()) await symlink(await readlink(from), to);
    else if (metadata.isFile()) {
      await copyFile(from, to);
      await chmod(to, metadata.mode & 0o777);
    } else throw new Error(`工作区包含特殊文件：${path}`);
  }
  git(clone, ['add', '--all']);
  return { patch: git(clone, ['diff', '--cached', '--binary', 'HEAD'], true), summary: git(clone, ['diff', '--cached', '--shortstat', 'HEAD']) };
}

/** `reference` is a commit, or null for HEAD with the working tree's changes. */
export async function buildRelease(repository, reference, root = releaseRoot()) {
  // Only reads objects; settings in the repository's own configuration do not apply to the fresh clone.
  const commit = git(repository, ['rev-parse', '--verify', `${reference ?? 'HEAD'}^{commit}`]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const building = await mkdtemp(join(root, 'building-'));
  let label = commit.slice(0, 12);
  let changes;
  let patch = '';
  try {
    run('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', `file://${repository}`, building]);
    run('git', ['-C', building, 'checkout', '--quiet', '--detach', commit]);
    if (reference === null) {
      const copied = await copyWorkingTree(repository, building);
      patch = copied.patch;
      if (patch) {
        label += `-worktree-${createHash('sha256').update(patch).digest('hex').slice(0, 8)}`;
        changes = { summary: copied.summary, patch: join(root, `${label}.patch`) };
      }
    }
    run('npm', ['ci', '--no-audit', '--no-fund'], building);
    run('npm', ['run', 'check'], building);
    run('npm', ['run', 'build'], building);
    const staging = join(root, `staging-${label}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    await cp(join(building, 'backend/dist'), join(staging, 'backend'), { recursive: true });
    await cp(join(building, 'frontend/dist'), join(staging, 'frontend'), { recursive: true });
    const source = join(root, `source-${label}`);
    await rm(source, { recursive: true, force: true });
    await rm(join(building, 'node_modules'), { recursive: true, force: true });
    // Links keep their own targets; resolved, they would point into the deleted build directory.
    await cp(building, source, { recursive: true, verbatimSymlinks: true, filter: file => !file.startsWith(join(building, '.git')) });
    if (changes) await writeFile(changes.patch, patch, { mode: 0o600 });
    return { commit, source, staging, changes };
  } finally {
    await rm(building, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--repo');
  const workingTree = process.argv.includes('--working-tree');
  const references = process.argv.slice(2).filter((item, index, all) => item !== '--repo' && all[index - 1] !== '--repo' && item !== '--working-tree');
  if (flag < 0 || !process.argv[flag + 1] || references.length !== (workingTree ? 0 : 1)) {
    console.error('用法：node deploy/build-release.mjs --repo <仓库目录> <提交>\n      node deploy/build-release.mjs --repo <仓库目录> --working-tree');
    process.exitCode = 64;
  } else {
    try {
      const { commit, source, staging, changes } = await buildRelease(resolve(process.argv[flag + 1]), workingTree ? null : references[0]);
      const scripts = dirname(fileURLToPath(import.meta.url));
      if (!workingTree) console.log(`已构建 ${commit}`);
      else if (!changes) console.log(`工作区与 ${commit} 相同，已按该提交构建`);
      else console.log(`已构建 ${commit} 加工作区修改（${changes.summary}），补丁：${changes.patch}`);
      console.log(`只有代码变化时发布：node --no-warnings ${join(scripts, 'release.mjs')} publish ${staging}`);
      console.log(`依赖或部署脚本也变化时安装：node ${join(scripts, 'host.mjs')} install --source ${source}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
