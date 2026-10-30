import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { SshManager } from './ssh.js';
import { assertRemotePath, remoteBash, shellQuote, type DevHost, type RuntimeConfig, type WorkspaceProject } from './types.js';

export type RemoteExecutionMode = 'direct' | 'bwrap' | 'symlink';

export async function prepareRemotePath(
  config: RuntimeConfig, ssh: SshManager, userId: string, host: DevHost, project: WorkspaceProject,
): Promise<RemoteExecutionMode> {
  assertRemotePath(project.local_path);
  assertRemotePath(project.remote_path);
  const token = randomUUID();
  const marker = join(config.dataDir, `.remote-path-${token}`);
  await writeFile(marker, token, { flag: 'wx', mode: 0o600 });
  try {
    const command = [
      'set -eu', 'umask 077',
      `source_root=$(cd -P -- ${shellQuote(project.remote_path)} && pwd -P)`,
      `visible_root=${shellQuote(project.local_path)}`,
      `requested=${shellQuote(project.path_mode ?? 'auto')}`,
      `previous_mode=${shellQuote(project.execution_mode ?? '')}`,
      `same_host=false; if [ "$(cat -- ${shellQuote(marker)} 2>/dev/null)" = ${shellQuote(token)} ]; then same_host=true; fi`,
      'if [ "$source_root" = "$visible_root" ]; then',
      '  if [ "$same_host" = true ]; then printf "%s\\n" "不能对号池机自身的同一个目录建立双端同步，请选择已有源码目录并使用 bwrap" >&2; exit 73; fi',
      '  printf direct; exit',
      'fi',
      'if [ "$requested" = direct ]; then printf "%s\\n" "同路径模式要求远端项目目录与工作区路径一致" >&2; exit 73; fi',
      'if [ "$requested" != symlink ] && command -v bwrap >/dev/null 2>&1; then',
      '  if bwrap --die-with-parent --bind / / --dev-bind /dev /dev --chdir "$source_root" -- /bin/true >/dev/null 2>&1; then',
      `    parent=${shellQuote(posix.dirname(project.local_path))}`,
      '    if [ -L "$parent" ]; then printf "%s\\n" "远端工作区根目录不能是软链接" >&2; exit 73; fi',
      '    if [ ! -d "$parent" ]; then mkdir -m 1777 -- "$parent"; fi',
      '    if [ ! -w "$parent" ] || [ ! -x "$parent" ]; then printf "%s\\n" "当前 SSH 用户无法写入远端工作区根目录，请由管理员配置该目录权限" >&2; exit 73; fi',
      '    if [ -L "$visible_root" ]; then',
      '      existing=$(cd -P -- "$visible_root" && pwd -P)',
      '      if [ "$existing" != "$source_root" ]; then printf "%s\\n" "远端统一路径已被其他软链接占用" >&2; exit 73; fi',
      '      rm -- "$visible_root"',
      '    fi',
      '    created_mountpoint=false; if [ ! -e "$visible_root" ]; then mkdir -m 700 -- "$visible_root"; created_mountpoint=true; fi',
      '    if [ ! -d "$visible_root" ] || [ ! -O "$visible_root" ]; then printf "%s\\n" "远端统一路径不是当前用户拥有的目录" >&2; exit 73; fi',
      '    if bwrap --die-with-parent --bind / / --dev-bind /dev /dev --bind "$source_root" "$visible_root" --chdir "$visible_root" --setenv PWD "$visible_root" -- /bin/true >/dev/null 2>&1; then printf bwrap; exit; fi',
      '    if [ "$created_mountpoint" = true ]; then rmdir -- "$visible_root"; fi',
      '  fi',
      'fi',
      'if [ "$requested" = bwrap ]; then printf "%s\\n" "远端 bwrap 不可用，请安装 bubblewrap 并允许当前用户创建挂载命名空间，或选择软链接模式" >&2; exit 73; fi',
      'if [ "$same_host" = true ]; then printf "%s\\n" "连接号池机自身时不能用软链接覆盖本地镜像，请安装并启用 bwrap" >&2; exit 73; fi',
      `parent=${shellQuote(posix.dirname(project.local_path))}`,
      'if [ -L "$parent" ]; then printf "%s\\n" "远端工作区根目录不能是软链接" >&2; exit 73; fi',
      'if [ ! -d "$parent" ]; then mkdir -m 1777 -- "$parent"; fi',
      'if [ ! -w "$parent" ] || [ ! -x "$parent" ]; then printf "%s\\n" "当前 SSH 用户无法写入远端工作区根目录，请由管理员配置该目录权限" >&2; exit 73; fi',
      'if [ -L "$visible_root" ]; then',
      '  existing=$(cd -P -- "$visible_root" && pwd -P)',
      '  if [ "$existing" != "$source_root" ]; then printf "%s\\n" "远端统一路径已被其他软链接占用" >&2; exit 73; fi',
      'elif [ -e "$visible_root" ]; then',
      '  if [ "$previous_mode" = bwrap ] && [ -d "$visible_root" ] && [ -O "$visible_root" ]; then',
      '    if ! rmdir -- "$visible_root"; then printf "%s\\n" "原 bwrap 挂载点非空，保留目录并停止降级" >&2; exit 73; fi',
      '    ln -s -- "$source_root" "$visible_root"',
      '  else printf "%s\\n" "远端统一路径已存在，不能覆盖为软链接" >&2; exit 73; fi',
      'else ln -s -- "$source_root" "$visible_root"; fi',
      'printf symlink',
    ].join('\n');
    const result = await ssh.exec(userId, host, `bash -c ${shellQuote(command)}`);
    if (result.code !== 0) throw new Error(result.stderr.trim() || '远端统一路径准备失败');
    const mode = result.stdout.trim();
    if (mode !== 'direct' && mode !== 'bwrap' && mode !== 'symlink') throw new Error('无法识别远端路径模式');
    return mode;
  } finally { await rm(marker, { force: true }); }
}

export function renderRemoteRunner(project: WorkspaceProject): string {
  const mode = project.execution_mode;
  if (mode !== 'direct' && mode !== 'bwrap' && mode !== 'symlink') throw new Error('项目远端路径尚未准备好，请先重新同步');
  // Existing project scripts may still use CC_POOL_PROJECT_ROOT; both names describe the same visible path.
  return `set -uo pipefail
readonly visible_root=${shellQuote(project.local_path)}
readonly source_root=${shellQuote(project.remote_path)}
readonly mode=${shellQuote(mode)}
if [[ "$mode" == symlink ]]; then
  expected_source="$(cd -P -- "$source_root" && pwd -P)" || exit 72
  actual_source="$(cd -P -- "$visible_root" && pwd -P)" || exit 72
  if [[ ! -L "$visible_root" || "$actual_source" != "$expected_source" ]]; then
    printf '%s\\n' 'remote-shell: project symlink changed; execution stopped' >&2
    exit 72
  fi
fi
relative_cwd="$1"; command_mode="$2"; shift 2
case "$relative_cwd" in
  ''|.) command_cwd="$visible_root" ;;
  /*|..|../*|*/../*|*/..) printf '%s\\n' 'remote-shell: invalid project-relative directory' >&2; exit 72 ;;
  *) command_cwd="$visible_root/$relative_cwd" ;;
esac
if [[ "$command_mode" == true ]]; then
  command_text="$1"; shift
  execution=(/bin/bash -l -c "$command_text" "$@")
else
  execution=(/bin/bash -l)
fi
if [[ "$mode" == bwrap ]]; then
  exec bwrap --die-with-parent --bind / / --dev-bind /dev /dev --bind "$source_root" "$visible_root" --chdir "$command_cwd" \\
    --setenv PWD "$command_cwd" --setenv CLINAVAT_PROJECT_ROOT "$visible_root" --setenv CC_POOL_PROJECT_ROOT "$visible_root" \\
    --unsetenv SSH_CLIENT --unsetenv SSH_CONNECTION --unsetenv SSH_TTY -- "\${execution[@]}"
fi
cd -L -- "$command_cwd" || exit 72
export PWD="$command_cwd" CLINAVAT_PROJECT_ROOT="$visible_root" CC_POOL_PROJECT_ROOT="$visible_root"
unset SSH_CLIENT SSH_CONNECTION SSH_TTY
exec "\${execution[@]}"`;
}

export function remoteCommand(project: WorkspaceProject, command?: string, cwdRelative = '', args: string[] = []): string {
  if (posix.isAbsolute(cwdRelative) || cwdRelative.split('/').includes('..')) throw new Error('远端工作目录必须位于当前项目内');
  return remoteBash(['bash', '-c', shellQuote(renderRemoteRunner(project)), '--', shellQuote(cwdRelative),
    shellQuote(command === undefined ? 'false' : 'true'), ...(command === undefined ? [] : [shellQuote(command), ...args.map(shellQuote)])].join(' '));
}
