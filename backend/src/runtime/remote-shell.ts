import { shellQuote, type WorkspaceProject } from './types.js';
import { renderRemoteRunner } from './remote-paths.js';
import { barrierClientProgram } from '../execution/guest-scripts.js';

/**
 * How remote-shell waits for synchronization. `local`: Mutagen and the project lock are on the same machine.
 * `relay`: commands run in a slot machine while Mutagen runs in the user's workspace machine, so the Hub holds the
 * project lock and runs the flush on the command's behalf.
 */
export type BarrierMode = 'local' | 'relay';

const localBarrier = String.raw`
# A single CLI turn may issue parallel commands; keep both synchronization barriers in one critical section.
# A background command must not hold the lock for its whole life, or every later command would time out waiting.
if [[ "$background" == false ]]; then
  exec 9>"$LOCAL_ROOT/.bin/command.lock" || {
    printf '%s\n' 'remote-shell: unable to create the project command lock' >&2
    exit 73
  }
  flock -w 120 9 || {
    printf '%s\n' 'remote-shell: another project command is still running; lock acquisition timed out' >&2
    exit 75
  }
fi
flush_sync() {
  timeout --signal=TERM --kill-after=5s 120s "$MUTAGEN_BINARY" sync flush "$SYNC_NAME" >/dev/null || {
    timeout --signal=TERM --kill-after=2s 10s "$MUTAGEN_BINARY" sync list "$SYNC_NAME" >&2 || true
    printf '%s\n' 'remote-shell: synchronization barrier failed; execution stopped' >&2
    return 74
  }
}
barrier_begin() { flush_sync; }
barrier_end() { flush_sync; }
`;

// The connection stays open for the whole command: if this script dies, the Hub releases the project lock.
const relayBarrier = String.raw`
barrier_begin() {
  local mode=lock reply=''
  [[ "$background" == true ]] && mode=nolock
  coproc BARRIER { exec python3 -I -c "$BARRIER_CLIENT" "$SYNC_NAME" "$mode"; }
  read -r -u "\${BARRIER[0]}" reply || true
  [[ "$reply" == ready ]] && return 0
  printf 'remote-shell: synchronization barrier failed; execution stopped: %s\n' "\${reply:-relay closed}" >&2
  [[ "$reply" == *'lock acquisition timed out'* ]] && return 75
  return 74
}
barrier_end() {
  local reply=''
  printf 'end\n' >&"\${BARRIER[1]}"
  read -r -u "\${BARRIER[0]}" reply || true
  [[ "$reply" == done ]] && return 0
  printf 'remote-shell: synchronization barrier failed after the command: %s\n' "\${reply:-relay closed}" >&2
  return 74
}
`.replaceAll('\\${', '${');

export function renderRemoteShell(binaries: { ssh: string; mutagen: string }, project: WorkspaceProject, sshConfig: string, sshTarget: string,
  environment: NodeJS.ProcessEnv, barrier: BarrierMode = 'local'): string {
  const variables = {
    LOCAL_ROOT: project.local_path, REMOTE_RUNNER: renderRemoteRunner(project),
    SYNC_NAME: project.sync_name, SSH_CONFIG: sshConfig, SSH_TARGET: sshTarget,
    SSH_BINARY: binaries.ssh, MUTAGEN_BINARY: binaries.mutagen,
    MUTAGEN_DATA_DIRECTORY: environment.MUTAGEN_DATA_DIRECTORY ?? '',
    MUTAGEN_SSH_PATH: environment.MUTAGEN_SSH_PATH ?? '',
    ...(barrier === 'relay' ? { BARRIER_CLIENT: barrierClientProgram } : {}),
  };
  return `#!/bin/bash
set -uo pipefail
${Object.entries(variables).map(([key, value]) => `readonly ${key}=${shellQuote(value)}`).join('\n')}
export MUTAGEN_DATA_DIRECTORY MUTAGEN_SSH_PATH

command_mode=false
background=false
while (($#)); do
  case "$1" in
    --background) background=true; shift ;;
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
  "$LOCAL_ROOT") relative_cwd='' ;;
  "$LOCAL_ROOT/"*) relative_cwd="\${local_cwd#"$LOCAL_ROOT/"}" ;;
  *) printf '%s\\n' 'remote-shell: working directory is outside the project' >&2; exit 72 ;;
esac

umask 077
${barrier === 'relay' ? relayBarrier : localBarrier}
barrier_begin || exit $?
printf -v quoted_runner '%q' "$REMOTE_RUNNER"
printf -v quoted_relative '%q' "$relative_cwd"
remote_command="bash -c $quoted_runner -- $quoted_relative $command_mode"
if [[ "$command_mode" == true ]]; then
  printf -v quoted_command '%q' "$command_text"
  remote_command+=" $quoted_command"
  for argument in "$@"; do
    printf -v quoted_argument '%q' "$argument"
    remote_command+=" $quoted_argument"
  done
fi
encoded_remote="$(printf '%s' "$remote_command" | base64 | tr -d '\\n')"
remote_entry="bash -c 'eval "
remote_entry+='"$(printf %s '
remote_entry+="$encoded_remote"
remote_entry+=' | base64 -d)"'
remote_entry+="'"
if [[ "$command_mode" == true ]]; then
  "$SSH_BINARY" -F "$SSH_CONFIG" -T "$SSH_TARGET" "$remote_entry"
  command_status=$?
else
  "$SSH_BINARY" -F "$SSH_CONFIG" -tt "$SSH_TARGET" "$remote_entry"
  command_status=$?
fi
barrier_end || exit 74
exit "$command_status"
`;
}
