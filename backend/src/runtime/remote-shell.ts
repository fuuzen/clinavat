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

/** Parses the arguments a CLI passes to its shell; sets command_mode, background and command_text. */
const shellArguments = (name: string) => `command_mode=false
background=false
while (($#)); do
  case "$1" in
    --background) background=true; shift ;;
    -c|-lc|-cl) command_mode=true; shift; break ;;
    -l|--login|--noprofile|--norc) shift ;;
    *) printf '%s\\n' '${name}: unsupported shell arguments' >&2; exit 64 ;;
  esac
done
if [[ "$command_mode" == true ]]; then
  (($#)) || { printf '%s\\n' '${name}: missing command' >&2; exit 64; }
  command_text="$1"
  shift
  case "$command_text" in
    env|printenv|'export -p') exec /bin/bash -c "$command_text" "$@" ;;
  esac
fi
`;

/**
 * Runs the runner script in $runner on the SSH target with the directory in $directory, then the command, and sets
 * command_status. The login shell there may be fish, so the payload travels base64-encoded and only Bash decodes it.
 */
const sshExecution = (runner: string, directory: string) => `printf -v quoted_runner '%q' "$${runner}"
printf -v quoted_directory '%q' "$${directory}"
remote_command="bash -c $quoted_runner -- $quoted_directory $command_mode"
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
fi`;

// Runs on the host as the SSH user: $1 the absolute directory, $2 whether a command follows, then the command.
const hostRunner = String.raw`set -uo pipefail
command_cwd="$1"; command_mode="$2"; shift 2
cd -L -- "$command_cwd" || exit 72
export PWD="$command_cwd"
unset SSH_CLIENT SSH_CONNECTION SSH_TTY
if [[ "$command_mode" == true ]]; then
  command_text="$1"; shift
  exec /bin/bash -l -c "$command_text" "$@"
fi
exec /bin/bash -l`;

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

${shellArguments('remote-shell')}
local_cwd="$(pwd -P)" || exit 72
case "$local_cwd" in
  "$LOCAL_ROOT") relative_cwd='' ;;
  "$LOCAL_ROOT/"*) relative_cwd="\${local_cwd#"$LOCAL_ROOT/"}" ;;
  *) printf '%s\\n' 'remote-shell: working directory is outside the project' >&2; exit 72 ;;
esac

umask 077
${barrier === 'relay' ? relayBarrier : localBarrier}
barrier_begin || exit $?
${sshExecution('REMOTE_RUNNER', 'relative_cwd')}
barrier_end || exit 74
exit "$command_status"
`;
}

/**
 * Runs a local project's commands on the Hub's own machine. The CLI stays in the slot machine, where the project is
 * mounted at its real path, and each command goes back to the host over SSH in the same directory.
 */
export function renderHostShell(sshBinary: string, sshConfig: string, sshTarget: string): string {
  const variables = { HOST_RUNNER: hostRunner, SSH_CONFIG: sshConfig, SSH_TARGET: sshTarget, SSH_BINARY: sshBinary };
  return `#!/bin/bash
set -uo pipefail
${Object.entries(variables).map(([key, value]) => `readonly ${key}=${shellQuote(value)}`).join('\n')}

${shellArguments('host-shell')}
command_cwd="$(pwd -P)" || exit 72
${sshExecution('HOST_RUNNER', 'command_cwd')}
exit "$command_status"
`;
}
