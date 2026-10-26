import { shellQuote, type RuntimeConfig, type WorkspaceProject } from './types.js';

export function renderRemoteShell(config: RuntimeConfig, project: WorkspaceProject, sshConfig: string, sshTarget: string, environment: NodeJS.ProcessEnv): string {
  const variables = {
    LOCAL_ROOT: project.local_path, REMOTE_ROOT: project.remote_path,
    SYNC_NAME: project.sync_name, SSH_CONFIG: sshConfig, SSH_TARGET: sshTarget,
    SSH_BINARY: config.sshBinary ?? 'ssh', MUTAGEN_BINARY: config.mutagenBinary ?? 'mutagen',
    MUTAGEN_DATA_DIRECTORY: environment.MUTAGEN_DATA_DIRECTORY ?? '',
    MUTAGEN_SSH_PATH: environment.MUTAGEN_SSH_PATH ?? '',
  };
  return `#!/bin/bash
set -uo pipefail
${Object.entries(variables).map(([key, value]) => `readonly ${key}=${shellQuote(value)}`).join('\n')}
export MUTAGEN_DATA_DIRECTORY MUTAGEN_SSH_PATH

command_mode=false
while (($#)); do
  case "$1" in
    -c|-lc|-cl) command_mode=true; shift; break ;;
    -l|--login|--noprofile|--norc) shift ;;
    *) printf '%s\\n' 'remote-shell: unsupported shell arguments' >&2; exit 64 ;;
  esac
done
if [[ "$command_mode" == true ]]; then
  (($#)) || { printf '%s\\n' 'remote-shell: missing command' >&2; exit 64; }
  command_text="$1"
  shift
  case "$command_text" in
    env|printenv|'export -p') exec /bin/bash -c "$command_text" "$@" ;;
  esac
fi

local_cwd="$(pwd -P)" || exit 72
case "$local_cwd" in
  "$LOCAL_ROOT") remote_cwd="$REMOTE_ROOT" ;;
  "$LOCAL_ROOT/"*) remote_cwd="$REMOTE_ROOT\${local_cwd#"$LOCAL_ROOT"}" ;;
  *) printf '%s\\n' 'remote-shell: working directory is outside the project' >&2; exit 72 ;;
esac

# A single CLI turn may issue parallel commands; keep both synchronization barriers in one critical section.
umask 077
exec 9>"$LOCAL_ROOT/.bin/command.lock" || {
  printf '%s\\n' 'remote-shell: unable to create the project command lock' >&2
  exit 73
}
flock -w 120 9 || {
  printf '%s\\n' 'remote-shell: another project command is still running; lock acquisition timed out' >&2
  exit 75
}

flush_sync() {
  timeout --signal=TERM --kill-after=5s 120s "$MUTAGEN_BINARY" sync flush "$SYNC_NAME" >/dev/null || {
    printf '%s\\n' 'remote-shell: synchronization barrier failed; execution stopped' >&2
    return 74
  }
}
flush_sync || exit 74
printf -v quoted_cwd '%q' "$remote_cwd"
if [[ "$command_mode" == true ]]; then
  printf -v quoted_command '%q' "$command_text"
  remote_command="cd -- $quoted_cwd && { unset SSH_CLIENT SSH_CONNECTION SSH_TTY; bash -l -c $quoted_command"
  for argument in "$@"; do
    printf -v quoted_argument '%q' "$argument"
    remote_command+=" $quoted_argument"
  done
  remote_command+='; }'
  printf -v quoted_remote '%q' "$remote_command"
  "$SSH_BINARY" -F "$SSH_CONFIG" -T "$SSH_TARGET" "bash -c $quoted_remote"
  command_status=$?
else
  "$SSH_BINARY" -F "$SSH_CONFIG" -tt "$SSH_TARGET" "cd -- $quoted_cwd && exec bash -l"
  command_status=$?
fi
flush_sync || exit 74
exit "$command_status"
`;
}
