// Passed to `bash -c` inside the guest, so the scripts always match the running Hub rather than the image.

const preamble = String.raw`set -u
groups=/sys/fs/cgroup/clinavat
markers=/run/clinavat
mkdir -p "$groups" "$markers"
reap() {
  for group in "$groups"/run-* "$groups"/probe-*; do
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

/**
 * Prepares a guest after boot or Hub restart: $1 uid, $2 gid, $3 SSH control directory, then for a slot machine
 * $4 hostname and $5 machine ID. Both persist in the Hub, so the account keeps one identity across rebuilds.
 */
export const prepareScript = preamble + String.raw`
reap
install -d -m 700 -o "$1" -g "$2" "$3" /run/clinavat-relay
if [ -n "\${4:-}" ] && [ "$(hostname)" != "$4" ]; then
  echo "$4" > /etc/hostname
  hostname "$4"
fi
if [ -n "\${5:-}" ] && [ "$(cat /etc/machine-id 2>/dev/null)" != "$5" ]; then
  echo "$5" > /etc/machine-id
fi
`.replaceAll('\\${', '${');

/**
 * Clears a slot machine before another user takes it: $1 uid, $2 SSH control directory. Every process of the
 * unprivileged user ends, and everything it could write outside mounted directories is emptied. Without root it
 * cannot have left anything elsewhere.
 */
export const handoverScript = preamble + String.raw`
uid="$1"; control="$2"
for group in "$groups"/*; do
  [ -d "$group" ] || continue
  echo 1 > "$group/cgroup.kill" 2>/dev/null
done
pkill -KILL -u "$uid" 2>/dev/null
for _ in $(seq 1 100); do pgrep -u "$uid" >/dev/null || break; sleep 0.05; done
if pgrep -u "$uid" >/dev/null; then echo "processes of the previous user did not exit" >&2; exit 1; fi
for group in "$groups"/*; do [ -d "$group" ] && rmdir "$group" 2>/dev/null; done
rm -f "$markers"/*
for directory in /tmp /var/tmp /dev/shm /home/clinavat "$control" /run/clinavat-relay; do
  [ -d "$directory" ] && find "$directory" -mindepth 1 -delete
done
exit 0
`;

/** Lists user runs still alive after reaping those whose wrapper died; usage probes do not count. */
export const liveRunsScript = preamble + String.raw`
reap
for group in "$groups"/run-*; do [ -d "$group" ] && echo "\${group##*/}"; done
exit 0
`.replaceAll('\\${', '${');

/** Runs a long-lived helper as the unprivileged user in its own cgroup: $1 name, $2 uid, $3 gid, then the command. */
export const serviceScript = preamble + String.raw`
name="$1"; uid="$2"; gid="$3"; shift 3
group="$groups/$name"
[ -d "$group" ] && { echo 1 > "$group/cgroup.kill" 2>/dev/null; sleep 0.2; rmdir "$group" 2>/dev/null; }
mkdir -p "$group"
echo "$$" > "$group/cgroup.procs"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs -- "$@"
`;

/**
 * The sync barrier relay in a slot machine. remote-shell connects to the local socket; each request goes to the
 * Hub over this process's own stdio and back. A connection that closes before its end request releases the lock.
 */
export const relayProgram = String.raw`
import json, os, socket, sys, threading
path = sys.argv[1]
output = threading.Lock()
pending, counter = {}, [0]
def send(message):
    with output:
        sys.stdout.write(json.dumps(message) + '\n'); sys.stdout.flush()
def replies():
    for line in sys.stdin:
        message = json.loads(line)
        entry = pending.pop(message.get('id'), None)
        if entry: entry['reply'] = message; entry['done'].set()
    os._exit(0)
def request(message):
    with output:
        counter[0] += 1; number = counter[0]
    entry = {'done': threading.Event()}
    pending[number] = entry
    send({**message, 'id': number})
    entry['done'].wait()
    return entry['reply']
def serve(connection, number):
    with connection:
        stream = connection.makefile('rwb')
        try:
            first = json.loads(stream.readline() or b'{}')
            sync, lock = first.get('sync'), first.get('lock') is True
            if first.get('op') != 'begin' or not isinstance(sync, str): return
            reply = request({'op': 'begin', 'conn': number, 'sync': sync, 'lock': lock})
            stream.write((json.dumps(reply) + '\n').encode()); stream.flush()
            if not reply.get('ok'): return
            if stream.readline():
                reply = request({'op': 'end', 'conn': number, 'sync': sync})
                stream.write((json.dumps(reply) + '\n').encode()); stream.flush()
                return
        except Exception:
            pass
        send({'op': 'abort', 'conn': number})
os.umask(0o077)
try: os.unlink(path)
except FileNotFoundError: pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path); server.listen(64)
threading.Thread(target=replies, daemon=True).start()
send({'op': 'ready'})
connections = 0
while True:
    connection, _ = server.accept()
    connections += 1
    threading.Thread(target=serve, args=(connection, connections), daemon=True).start()
`;

/** Runs sync barriers in a workspace machine for the Hub: one JSON request per line, answered in any order. */
export const flushProgram = String.raw`
import json, subprocess, sys, threading
binary = sys.argv[1]
output = threading.Lock()
def flush(message):
    try:
        result = subprocess.run([binary, 'sync', 'flush', message['sync']], capture_output=True, text=True, timeout=120)
        reply = {'id': message['id'], 'ok': result.returncode == 0, 'error': (result.stderr or result.stdout)[-2000:]}
    except Exception as error:
        reply = {'id': message['id'], 'ok': False, 'error': str(error)}
    with output:
        sys.stdout.write(json.dumps(reply) + '\n'); sys.stdout.flush()
for line in sys.stdin:
    threading.Thread(target=flush, args=(json.loads(line),), daemon=True).start()
`;

/**
 * remote-shell's side of the barrier: $1 sync name, $2 lock or nolock. Prints ready once the Hub has taken the
 * project lock and flushed, then waits for "end" on stdin and prints done after the closing flush.
 */
export const barrierClientProgram = String.raw`
import json, socket, sys
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    connection.connect('/run/clinavat-relay/barrier.sock')
except OSError as error:
    print('relay unavailable: ' + str(error), flush=True); sys.exit(1)
stream = connection.makefile('rwb')
def exchange(message):
    stream.write((json.dumps(message) + '\n').encode()); stream.flush()
    line = stream.readline()
    return json.loads(line) if line else {'ok': False, 'error': 'relay closed'}
reply = exchange({'op': 'begin', 'sync': sys.argv[1], 'lock': sys.argv[2] == 'lock'})
if not reply.get('ok'):
    print('error: ' + str(reply.get('error') or 'barrier failed').replace('\n', ' '), flush=True); sys.exit(1)
print('ready', flush=True)
if sys.stdin.readline().strip() != 'end': sys.exit(0)
reply = exchange({'op': 'end'})
print('done' if reply.get('ok') else 'error: ' + str(reply.get('error') or 'barrier failed').replace('\n', ' '), flush=True)
`;
