// Passed to `bash -c` inside the guest, so the scripts always match the running Hub rather than the image.

const preamble = String.raw`set -u
groups=/sys/fs/cgroup/clinavat
markers=/run/clinavat
mkdir -p "$groups" "$markers"
reap() {
  for group in "$groups"/run-*; do
    [ -d "$group" ] || continue
    id="$(basename "$group")"
    wrapper="$(cat "$markers/$id" 2>/dev/null || echo 0)"
    [ "$wrapper" != 0 ] && kill -0 "$wrapper" 2>/dev/null && continue
    finish "$id"
  done
}
finish() {
  echo 1 > "$groups/$1/cgroup.kill" 2>/dev/null
  for _ in $(seq 1 100); do grep -q 'populated 0' "$groups/$1/cgroup.events" 2>/dev/null && break; sleep 0.05; done
  rmdir "$groups/$1" 2>/dev/null
  rm -f "$markers/$1"
}
`;

/** Runs a command as the unprivileged user in its own cgroup: $1 run id, $2 uid, $3 gid, $4 cwd, then the command. */
export const runScript = preamble + String.raw`
id="$1"; uid="$2"; gid="$3"; cwd="$4"; shift 4
group="$groups/$id"
mkdir "$group"
echo "$$" > "$markers/$id"
(
  echo "$BASHPID" > "$group/cgroup.procs"
  cd -- "$cwd" || exit 72
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
) <&0 &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP
status=0
while :; do
  wait "$child"; status=$?
  kill -0 "$child" 2>/dev/null || break
done
finish "$id"
exit "$status"
`;

/** Starts the user's Mutagen daemon in a cgroup that outlives the commands talking to it: $1 uid, $2 gid, $3 binary. */
export const daemonScript = preamble + String.raw`
uid="$1"; gid="$2"; binary="$3"
group="$groups/daemon-$uid"
mkdir -p "$group"
if ! grep -q . "$group/cgroup.procs" 2>/dev/null; then
  (
    echo "$BASHPID" > "$group/cgroup.procs"
    exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$binary" daemon start
  ) </dev/null >/dev/null
fi
`;

/**
 * Freezes one run: $1 run id. Prints BUSY while SSH or a synchronization barrier is in flight, because
 * freezing those would stall the remote side; otherwise prints FROZEN once the kernel confirms it.
 */
export const freezeScript = preamble + String.raw`
group="$groups/$1"
[ -d "$group" ] || { echo GONE; exit 0; }
while read -r pid; do
  arguments=()
  mapfile -d '' -t arguments < "/proc/$pid/cmdline" 2>/dev/null || continue
  executable="\${arguments[0]:-}"
  name="\${executable##*/}"
  case "$name" in ssh|sshpass|mutagen|timeout|remote-shell) echo BUSY; exit 0 ;; esac
  # CLI system instructions can mention remote-shell; only inspect shell execution arguments.
  case "$name" in
    bash|sh|dash|zsh)
      script="\${arguments[1]:-}"
      if [ "\${script##*/}" = remote-shell ]; then echo BUSY; exit 0; fi
      for index in "\${!arguments[@]}"; do
        if [[ "\${arguments[index]}" =~ ^-[a-z]*c[a-z]*$ ]]; then
          if grep -Eq 'remote-shell|\b(ssh|mutagen|timeout)\b' <<<"\${arguments[index+1]:-}"; then echo BUSY; exit 0; fi
          break
        fi
      done
      ;;
  esac
done < "$group/cgroup.procs"
echo 1 > "$group/cgroup.freeze"
for _ in $(seq 1 100); do
  if grep -q 'frozen 1' "$group/cgroup.events"; then echo FROZEN; exit 0; fi
  sleep 0.05
done
echo 0 > "$group/cgroup.freeze"
echo "cgroup did not freeze" >&2
exit 1
`.replaceAll('\\${', '${');

/** $1 run id. */
export const thawScript = String.raw`group="/sys/fs/cgroup/clinavat/$1"; if [ -d "$group" ]; then echo 0 > "$group/cgroup.freeze"; fi`;

/** Lists processes still using a slot home after reaping runs whose wrapper died: $1 home, $2 session id or empty. */
export const releasedScript = preamble + String.raw`
reap
home="$1"; session="$2"
for directory in /proc/[0-9]*; do
  pid="\${directory#/proc/}"
  [ "$pid" = "$$" ] && continue
  environment="$(tr '\0' '\n' < "$directory/environ" 2>/dev/null)" || continue
  [ -n "$session" ] && ! grep -qxF "CLINAVAT_SESSION_ID=$session" <<<"$environment" && continue
  if grep -qxF -e "HOME=$home" -e "CLAUDE_CONFIG_DIR=$home/.claude" -e "CODEX_HOME=$home/.codex" <<<"$environment"; then echo "$pid"; fi
done
`.replaceAll('\\${', '${');

/** Prepares a guest after boot or Hub restart: $1 uid, $2 gid, $3 SSH control directory. */
export const prepareScript = preamble + String.raw`
reap
install -d -m 700 -o "$1" -g "$2" "$3"
`;
