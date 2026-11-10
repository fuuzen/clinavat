#!/bin/bash
# Lets slot machines log in to this host's sshd over the VM bridge as the Hub user: in VM mode, the administrator's
# local projects run their shell commands here. setup.sh runs apply; run it yourself on an existing installation.
# Run as root; see docs/vm-isolation.md.
#
#   sudo deploy/lxd/host-commands.sh apply --hub-user <user> [--port 22]
#   sudo deploy/lxd/host-commands.sh check --hub-user <user> [--port 22]
#
# apply lets the VM network log in with keys only, opens the port in the egress ACL, then runs check. It never
# changes where sshd listens, so a mistake cannot lock out other logins. The Hub itself keeps the key and its entry
# in the Hub user's authorized_keys, and logs in once at start; the admin panel shows the result.
set -euo pipefail

NETWORK=clinavat-users
ACL=clinavat-egress
SSHD_CONFIG=/etc/ssh/sshd_config
BEGIN='# BEGIN clinavat host commands'
END='# END clinavat host commands'

command="${1:-}"; shift || true
hub_user="" port=22
while (($#)); do
  case "$1" in
    --hub-user) hub_user="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ "$port" =~ ^[0-9]+$ ]] || { echo "invalid --port $port" >&2; exit 64; }
[[ -n "$hub_user" ]] || { echo "--hub-user is required" >&2; exit 64; }
id "$hub_user" >/dev/null || { echo "no such user: $hub_user" >&2; exit 1; }

lxc() { /snap/bin/lxc "$@" </dev/null; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
problems=0
problem() { echo "  FAIL: $*" >&2; problems=$((problems + 1)); }
warn() { echo "  warning: $*" >&2; }

sshd="$(command -v sshd)" || fail "sshd is not installed"
[[ -f "$SSHD_CONFIG" ]] || fail "$SSHD_CONFIG does not exist"
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
  lxc query "/1.0/network-acls/$ACL" | python3 -I -c '
import json, sys
bridge, port = sys.argv[1], sys.argv[2]
for rule in json.load(sys.stdin).get("egress") or []:
    destinations = rule.get("destination", "").replace(" ", "").split(",")
    ports = rule.get("destination_port", "").replace(" ", "").split(",")
    if (rule.get("action") == "allow" and rule.get("state", "enabled") == "enabled" and rule.get("protocol") == "tcp"
            and (bridge in destinations or f"{bridge}/32" in destinations) and port in ports):
        sys.exit(0)
sys.exit(1)' "$bridge" "$port"
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
  if acl_allows_port; then ok "egress ACL $ACL allows $bridge:$port"; else problem "egress ACL $ACL does not allow $bridge:$port; run apply"; fi
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    warn "ufw is active; if it drops the bridge's traffic, run: ufw allow in on $NETWORK to $bridge port $port proto tcp"
  fi
  home="$(getent passwd "$hub_user" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"
  if grep -q ' clinavat-host-commands$' "$keys" 2>/dev/null; then ok "$keys holds the Hub's host command key"
  else warn "$keys has no host command key yet; the Hub adds it when it starts in VM mode"; fi
  ((problems == 0)) || fail "$problems problem(s) found"
  echo "ready. The Hub uses $hub_user@$bridge:$port; the admin panel's 宿主机 page shows whether it logs in."
}

case "$command" in
  check) check ;;
  apply)
    echo "== apply"
    apply_sshd
    ok "logins from $subnet accept keys only (previous file: $SSHD_CONFIG.clinavat-backup)"
    if acl_allows_port; then ok "egress ACL $ACL already allows $bridge:$port"
    else
      lxc network acl rule add "$ACL" egress action=allow destination="$bridge/32" protocol=tcp destination_port="$port" \
        state=enabled description="Clinavat host commands"
      ok "egress ACL $ACL allows $bridge:$port"
    fi
    check ;;
  *) sed -n '2,12p' "$0"; exit 64 ;;
esac
