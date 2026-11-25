#!/bin/bash
# Lets slot machines log in to this host's sshd over the VM bridge as the Hub user: in VM mode, the administrator's
# local projects run their shell commands here. It also manages and verifies the egress ACL rule for the Hub's
# single-port SSH relay (default TCP 22100, or CLINAVAT_SSH_RELAY_PORT) used for approved private dev hosts.
# setup.sh runs apply; run apply or apply-relay yourself on an existing installation. Run as root; see docs/vm-isolation.md.
#
#   sudo deploy/lxd/host-commands.sh apply --hub-user <user> [--port 22] [--relay-port 22100]
#   sudo deploy/lxd/host-commands.sh check --hub-user <user> [--port 22] [--relay-port 22100]
#   sudo deploy/lxd/host-commands.sh apply-relay [--relay-port 22100]
#
# apply lets the VM network log in with keys only, opens the sshd and Hub SSH relay ports in the egress ACL, then
# runs check. apply-relay only ensures the Hub SSH relay ACL rule exists (idempotent, without touching sshd_config).
# It never changes where sshd listens, so a mistake cannot lock out other logins. The Hub itself keeps the key and its
# entry in the Hub user's authorized_keys, and logs in once at start; the admin panel shows the result.
set -euo pipefail

NETWORK=clinavat-users
ACL=clinavat-egress
SSHD_CONFIG=/etc/ssh/sshd_config
BEGIN='# BEGIN clinavat host commands'
END='# END clinavat host commands'

command="${1:-}"; shift || true
hub_user="" port=22 relay_port="${CLINAVAT_SSH_RELAY_PORT:-22100}"
while (($#)); do
  case "$1" in
    --hub-user) hub_user="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --relay-port) relay_port="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "invalid --port $port" >&2; exit 64; }
[[ "$relay_port" =~ ^[0-9]+$ ]] && (( relay_port >= 1 && relay_port <= 65535 )) || { echo "invalid --relay-port $relay_port" >&2; exit 64; }

lxc() { /snap/bin/lxc "$@" </dev/null; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
problems=0
problem() { echo "  FAIL: $*" >&2; problems=$((problems + 1)); }
warn() { echo "  warning: $*" >&2; }

require_host_command_prereqs() {
  [[ -n "$hub_user" ]] || { echo "--hub-user is required" >&2; exit 64; }
  id "$hub_user" >/dev/null || { echo "no such user: $hub_user" >&2; exit 1; }
  sshd="$(command -v sshd)" || fail "sshd is not installed"
  [[ -f "$SSHD_CONFIG" ]] || fail "$SSHD_CONFIG does not exist"
}

# The bridge address, its network, and a guest address inside it to evaluate sshd's Match rules with.
read -r bridge subnet guest < <(lxc network get "$NETWORK" ipv4.address | python3 -I -c '
import ipaddress, sys
interface = ipaddress.ip_interface(sys.stdin.read().strip())
print(interface.ip, interface.network, interface.network.network_address + 10)') || fail "cannot read the address of $NETWORK"

# A Match block lasts until the next Match line or the end of the file, so it goes last. AuthenticationMethods
# alone already refuses passwords and keyboard-interactive logins.
sshd_block() {
  printf '%s\n' "$BEGIN" \
    '# Slot machines reach this host over the VM network: key logins only. Keep this block at the end of the file.' \
    "Match Address $subnet" \
    '    AuthenticationMethods publickey' \
    '    PasswordAuthentication no' \
    "$END"
}

remove_sshd_block() {
  python3 -I - "$SSHD_CONFIG" "$BEGIN" "$END" <<'PY'
import sys
path, begin, end = sys.argv[1:4]
with open(path) as file:
    lines = file.read().splitlines(keepends=True)
kept, inside = [], False
for line in lines:
    text = line.rstrip('\n')
    if text == begin:
        inside = True
    elif inside:
        inside = text != end
    else:
        kept.append(line)
if inside:
    sys.exit(f'{path}: the Clinavat block has no end marker; fix it by hand')
with open(path, 'w') as file:
    file.write(''.join(kept))
PY
}

reload_sshd() {
  local unit
  for unit in ssh.service sshd.service; do
    if systemctl is-active --quiet "$unit"; then systemctl reload "$unit"; return; fi
  done
  # Socket activation (ssh.socket) reads the file when it next starts sshd.
}

# Rewrites the block, so a changed VM network is picked up; the previous file is restored if sshd rejects it.
apply_sshd() {
  cp -p "$SSHD_CONFIG" "$SSHD_CONFIG.clinavat-backup"
  remove_sshd_block
  [[ -z "$(tail -c1 "$SSHD_CONFIG")" ]] || echo >>"$SSHD_CONFIG"
  sshd_block >>"$SSHD_CONFIG"
  if ! "$sshd" -t; then
    cp -p "$SSHD_CONFIG.clinavat-backup" "$SSHD_CONFIG"
    fail "sshd rejected the change; restored $SSHD_CONFIG"
  fi
  reload_sshd
}

acl_allows_port() {
  local target_port="${1:-$port}"
  lxc query "/1.0/network-acls/$ACL" | python3 -I -c '
import json, sys
bridge, port = sys.argv[1], sys.argv[2]
for rule in json.load(sys.stdin).get("egress") or []:
    destinations = rule.get("destination", "").replace(" ", "").split(",")
    ports = rule.get("destination_port", "").replace(" ", "").split(",")
    if (rule.get("action") == "allow" and rule.get("state", "enabled") == "enabled" and rule.get("protocol") == "tcp"
            and (bridge in destinations or f"{bridge}/32" in destinations) and port in ports):
        sys.exit(0)
sys.exit(1)' "$bridge" "$target_port"
}

ensure_relay_acl() {
  if acl_allows_port "$relay_port"; then
    ok "egress ACL $ACL already allows $bridge:$relay_port (Hub SSH relay)"
  else
    lxc network acl rule add "$ACL" egress action=allow destination="$bridge/32" protocol=tcp destination_port="$relay_port" \
      state=enabled description="Clinavat SSH relay"
    ok "egress ACL $ACL allows $bridge:$relay_port (Hub SSH relay)"
  fi
}

check_ufw_port() {
  local target_port="$1" label="$2" status
  if command -v ufw >/dev/null && status="$(ufw status 2>/dev/null)" && grep -q '^Status: active' <<<"$status"; then
    if grep -Eq "(^|[[:space:]])${target_port}/tcp([[:space:]]|$).*ALLOW" <<<"$status"; then
      ok "ufw has an allow rule for tcp/$target_port ($label)"
    else
      warn "ufw is active and may block $label from $NETWORK to $bridge:$target_port; run: sudo ufw allow in on $NETWORK to $bridge port $target_port proto tcp"
    fi
  fi
}

check_key_path_modes() {
  local home="$1" keys="$2" path owner mode hub_uid
  home="$(realpath -m -- "$home")" || { problem "cannot resolve $home (sshd StrictModes)"; return; }
  path="$(realpath -m -- "$keys")" || { problem "cannot resolve $keys (sshd StrictModes)"; return; }
  hub_uid="$(id -u "$hub_user")"

  # sshd follows the resolved key path up to the home directory, or to / if the key resolves outside home.
  while :; do
    if [[ -e "$path" ]]; then
      if ! read -r owner mode < <(stat -c '%u %a' -- "$path"); then
        problem "cannot read ownership and permissions of $path (sshd StrictModes)"
      elif (( (owner != 0 && owner != hub_uid) || (8#$mode & 0022) )); then
        problem "$path (owner UID $owner, mode $mode) must belong to root or $hub_user and have no group or other write permission (sshd StrictModes)"
      fi
    fi
    [[ "$path" == "$home" || "$path" == / ]] && break
    path="$(dirname -- "$path")"
  done
}

check() {
  echo "== check: guests on $subnet log in to $bridge:$port"
  local listening effective home keys
  "$sshd" -t || problem "sshd -t reports an invalid configuration"
  listening="$(ss -Hltn "sport = :$port" | awk '{ print $4 }')"
  if grep -qxE "(0\.0\.0\.0|\*|${bridge//./\\.}):$port" <<<"$listening"; then
    ok "sshd listens on $bridge:$port"
  elif grep -qxF "[::]:$port" <<<"$listening"; then
    warn "sshd listens only on [::]:$port, which may not accept IPv4; the admin panel's test will tell"
  else
    problem "nothing listens on $bridge:$port (listening: ${listening:-none}). Keep sshd on all addresses, or add 'ListenAddress $bridge' beside the existing ListenAddress lines; with ssh.socket, run systemctl daemon-reload && systemctl restart ssh.socket afterwards"
  fi
  effective="$("$sshd" -T -C "user=$hub_user,host=clinavat-guest,addr=$guest,laddr=$bridge,lport=$port")" \
    || problem "sshd -T cannot evaluate a login from $guest"
  if grep -qx 'authenticationmethods publickey' <<<"$effective" && grep -qx 'passwordauthentication no' <<<"$effective"; then
    ok "logins from $subnet accept keys only"
  else
    problem "logins from $subnet may still use passwords; run apply"
  fi
  if acl_allows_port "$port"; then ok "egress ACL $ACL allows $bridge:$port"; else problem "egress ACL $ACL does not allow $bridge:$port; run apply"; fi
  if acl_allows_port "$relay_port"; then
    ok "egress ACL $ACL allows $bridge:$relay_port (Hub SSH relay)"
  else
    problem "egress ACL $ACL does not allow $bridge:$relay_port (Hub SSH relay); run: sudo $0 apply-relay --relay-port $relay_port"
  fi
  check_ufw_port "$port" "host commands (sshd)"
  check_ufw_port "$relay_port" "Hub SSH relay"
  home="$(getent passwd "$hub_user" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"
  if grep -qx 'strictmodes yes' <<<"$effective"; then check_key_path_modes "$home" "$keys"; fi
  if grep -q ' clinavat-host-commands$' "$keys" 2>/dev/null; then ok "$keys holds the Hub's host command key"
  else warn "$keys has no host command key yet; the Hub adds it when it starts in VM mode"; fi
  ((problems == 0)) || fail "$problems problem(s) found"
  echo "Host-side checks passed. The Hub uses $hub_user@$bridge:$port (SSH relay: $bridge:$relay_port); the admin panel's 宿主机 page shows whether it logs in."
}

case "$command" in
  check)
    require_host_command_prereqs
    check ;;
  apply)
    require_host_command_prereqs
    echo "== apply"
    apply_sshd
    ok "logins from $subnet accept keys only (previous file: $SSHD_CONFIG.clinavat-backup)"
    if acl_allows_port "$port"; then ok "egress ACL $ACL already allows $bridge:$port"
    else
      lxc network acl rule add "$ACL" egress action=allow destination="$bridge/32" protocol=tcp destination_port="$port" \
        state=enabled description="Clinavat host commands"
      ok "egress ACL $ACL allows $bridge:$port"
    fi
    ensure_relay_acl
    check ;;
  apply-relay)
    echo "== apply-relay: allow guests on $subnet to reach Hub SSH relay $bridge:$relay_port"
    ensure_relay_acl
    check_ufw_port "$relay_port" "Hub SSH relay" ;;
  *) sed -n '2,14p' "$0"; exit 64 ;;
esac
