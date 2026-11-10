#!/bin/bash
# Moves egress selection to the gateway, per source address: the pool machine and every VM keep their own address
# up to the gateway, which sends each one through the node bound to it. Run as root; see docs/vm-isolation.md.
#
#   sudo deploy/lxd/egress-bindings.sh prepare-containers --hub-user <user> [--max-users 8] [--data-dir <directory>]
#                                               [--local-root <directory>]...
#   sudo deploy/lxd/egress-bindings.sh remove-old-machines --hub-user <user>
#   sudo deploy/lxd/egress-bindings.sh check    --hub-user <user>
#   sudo deploy/lxd/egress-bindings.sh apply    --hub-user <user> [--node <tag>] [--vm-subnet 10.31.0.0/24]
#                                               [--dhcp-range 10.31.0.200-10.31.0.254] [--dns 1.1.1.1]
#                                               [--builder-address 10.31.0.9]
#   sudo deploy/lxd/egress-bindings.sh rollback
#
# prepare-containers runs first, before the workspace image is built. apply never opens a path around the proxy:
# the gateway learns the VM network before the host stops translating VM addresses, and unbound sources are
# rejected rather than sent through the shared node. The host's own routes and DNS servers are not changed;
# queries to public resolvers are answered by the gateway according to the host's binding.
set -euo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATEWAY_PROJECT=clinavat-gateway
GATEWAY_VM=clinavat-gateway
USER_PROJECT=clinavat
VM_BRIDGE=clinavat-users
GWCTL=/usr/local/lib/clinavat-gw/gwctl.py
PIN_DROPIN=/etc/systemd/system/sing-box.service.d/clinavat-pin.conf
BACKUP=/var/lib/clinavat-egress-bindings

command="${1:-}"; shift || true
hub_user="" node="" vm_subnet=10.31.0.0/24 dhcp_range=10.31.0.200-10.31.0.254 dns=1.1.1.1 builder=10.31.0.9 max_users=8 data_dir="" local_roots=()
while (($#)); do
  case "$1" in
    --hub-user) hub_user="$2"; shift 2 ;;
    --node) node="$2"; shift 2 ;;
    --vm-subnet) vm_subnet="$2"; shift 2 ;;
    --dhcp-range) dhcp_range="$2"; shift 2 ;;
    --dns) dns="$2"; shift 2 ;;
    --builder-address) builder="$2"; shift 2 ;;
    --max-users) max_users="$2"; shift 2 ;;
    --data-dir) data_dir="$2"; shift 2 ;;
    --local-root) local_roots+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

lxc() { /snap/bin/lxc "$@" </dev/null; }
in_gateway() { lxc exec "$GATEWAY_VM" --project "$GATEWAY_PROJECT" -- "$@"; }
# For commands that read this script's stdin, such as an archive being restored.
feed_gateway() { /snap/bin/lxc exec "$GATEWAY_VM" --project "$GATEWAY_PROJECT" -- "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
# Runs a gwctl operation on the gateway and prints its result; a change waiting for confirmation is confirmed.
gwctl() {
  local output
  output="$(in_gateway "$GWCTL" "$@")" || fail "gwctl $1: $output"
  python3 -I -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["ok"], r.get("error"); print(json.dumps(r["result"], ensure_ascii=False))' "$output" \
    || fail "gwctl $1: $output"
}
confirm_pending() {
  local revision
  revision="$(python3 -I -c 'import json,sys; r=json.loads(sys.argv[1]); print(r.get("revision") or "" if r.get("pending") else "")' "$1")"
  [[ -z "$revision" ]] || gwctl confirm "$revision" >/dev/null
}
state_field() { gwctl state.get | python3 -I -c "import json,sys; print(json.load(sys.stdin)$1)"; }

preflight() {
  echo "== preflight"
  [[ -n "$hub_user" ]] || fail "--hub-user is required"
  hub_uid="$(id -u "$hub_user")" || fail "no such user: $hub_user"
  for unit in clinavat-hub.service clinavat-web.service; do
    if systemctl --user --machine="$hub_user@" is-active --quiet "$unit" 2>/dev/null; then
      fail "$unit is running; stop it first as $hub_user: npm run host:stop"
    fi
  done
  ok "Hub and Web services are stopped"
  # This script never changes the host's own routes; it expects the gateway-only baseline and stops otherwise.
  ip route show default | grep -q '^default via [0-9.]* dev clinavat-lan' || fail "the host's default route is not through clinavat-lan: $(ip route show default)"
  for nic in $(ls /sys/class/net); do
    case "$nic" in lo|clinavat-*|tap*|mac*|veth*) continue ;; esac
    if ip -o addr show dev "$nic" | grep -q ' inet6\? '; then fail "physical interface $nic has an address; the host must reach the internet only through the gateway"; fi
  done
  ok "host leaves only through the gateway"
  [[ "$(lxc list "^$GATEWAY_VM$" --project "$GATEWAY_PROJECT" --format csv -c s)" == RUNNING ]] || fail "gateway VM is not running"
  local version
  version="$(in_gateway sing-box version | awk 'NR == 1 { print $3 }')"
  python3 -I -c 'import sys; v=tuple(map(int, sys.argv[1].split(".")[:2])); sys.exit(0 if v >= (1, 12) else 1)' "$version" \
    || fail "sing-box $version is too old; per-source DNS rules need 1.12 or later"
  ok "gateway VM running sing-box $version"
  python3 -I -c 'import ipaddress,sys; n=ipaddress.ip_network(sys.argv[1]); a,b=(ipaddress.ip_address(x) for x in sys.argv[2].split("-")); assert a in n and b in n and a <= b' \
    "$vm_subnet" "$dhcp_range" 2>/dev/null || fail "--dhcp-range $dhcp_range must lie inside $vm_subnet"
  [[ "$(lxc network get "$VM_BRIDGE" ipv4.address | python3 -I -c 'import ipaddress,sys; print(ipaddress.ip_interface(sys.stdin.read().strip()).network)')" == "$vm_subnet" ]] \
    || fail "$VM_BRIDGE is not on $vm_subnet"
  ok "VM network $vm_subnet, dynamic leases $dhcp_range"
  check_containers
}

# Lets the Hub run workspace containers: a quota, isolated uid ranges, the usage probe mount and their own profile.
# The default profile carries VM-only settings, so containers never use it.
prepare_containers() {
  echo "== prepare workspace containers"
  [[ -n "$hub_user" ]] || fail "--hub-user is required"
  hub_uid="$(id -u "$hub_user")" || fail "no such user: $hub_user"
  local paths probes
  lxc project set "$USER_PROJECT" limits.containers="$max_users" restricted.containers.privilege=isolated
  paths="$(lxc project get "$USER_PROJECT" restricted.devices.disk.paths)"
  probes="/run/user/$hub_uid/clinavat/usage-probes"
  [[ ",$paths," == *",$probes,"* ]] || paths="$paths,$probes"
  if [[ -n "$data_dir" ]]; then
    [[ -d "$data_dir/users" && -d "$data_dir/slots" ]] || fail "$data_dir does not hold the Hub's data; run deploy/relocate-data.mjs first"
    paths="$(tr ',' '\n' <<<"$paths" | grep -Ev '/(users|slots)$' | paste -sd,)"
    paths="$data_dir/users,$data_dir/slots,$paths"
  fi
  local root current_data
  current_data="$(tr ',' '\n' <<<"$paths" | sed -n 's#/users$##p' | head -1)"
  for root in "${local_roots[@]}"; do
    [[ "$root" == /* && -d "$root" ]] || fail "--local-root $root is not an existing absolute directory"
    # A project is mounted whole into slot machines, so it must not reach the Hub's data.
    [[ "$current_data/" != "${root%/}/"* ]] || fail "--local-root $root contains the data directory $current_data; move it with deploy/relocate-data.mjs first"
    [[ ",$paths," == *",$root,"* ]] || paths="$paths,$root"
  done
  lxc project set "$USER_PROJECT" restricted.devices.disk.paths="$paths"
  lxc profile show workspace --project "$USER_PROJECT" >/dev/null 2>&1 || lxc profile create workspace --project "$USER_PROJECT"
  /snap/bin/lxc profile edit workspace --project "$USER_PROJECT" <<PROFILE
description: Workspace containers that only run synchronization
config:
  limits.cpu: "1"
  limits.memory: 512MiB
  limits.processes: "2000"
  security.idmap.isolated: "true"
devices:
  eth0:
    name: eth0
    network: $VM_BRIDGE
    security.ipv4_filtering: "true"
    security.mac_filtering: "true"
    security.port_isolation: "true"
    type: nic
  root:
    path: /
    pool: clinavat
    size: 4GiB
    type: disk
PROFILE
  ok "up to $max_users workspace containers, isolated uid ranges, profile workspace"
  ok "mountable paths: $paths"
}

# Restricted disk paths forbid shift=true; map only the Hub's uid/gid and use ordinary bind mounts.
check_containers() {
  local quota paths data_dir probe name hub_gid idmap owner
  hub_gid="$(id -g "$hub_user")"
  printf -v idmap 'uid %s %s\ngid %s %s' "$hub_uid" "$hub_uid" "$hub_gid" "$hub_gid"
  quota="$(lxc project get "$USER_PROJECT" limits.containers)"
  [[ "${quota:-0}" -gt 0 ]] && lxc profile show workspace --project "$USER_PROJECT" >/dev/null 2>&1 \
    || fail "workspace containers are not prepared; run: sudo $0 prepare-containers --hub-user $hub_user"
  paths="$(lxc project get "$USER_PROJECT" restricted.devices.disk.paths)"
  data_dir="$(tr ',' '\n' <<<"$paths" | sed -n 's#/users$##p' | head -1)"
  [[ -n "$data_dir" ]] || fail "cannot find the data directory in restricted.devices.disk.paths"
  hub_lxc() { sudo -u "$hub_user" -H /snap/bin/lxc --project "$USER_PROJECT" "$@" </dev/null; }
  hub_lxc image info "clinavat-host:clinavat-workspace" >/dev/null 2>&1 \
    || fail "image clinavat-workspace is missing; build it as $hub_user: deploy/lxd/build-image.sh --kind workspace"
  name="clinavat-container-check-$$"
  probe="$data_dir/users/.container-check-$$"
  install -d -m 700 -o "$hub_user" -g "$hub_gid" "$probe"
  cleanup_probe() { hub_lxc delete --force "clinavat-host:$name" >/dev/null 2>&1 || true; rm -rf "$probe"; }
  # fail exits the script, which a RETURN trap would not see.
  trap cleanup_probe EXIT
  hub_lxc init clinavat-host:clinavat-workspace "clinavat-host:$name" --profile workspace -c "raw.idmap=$idmap" >/dev/null \
    || fail "the Hub's client cannot create an isolated container with the Hub's uid/gid mapping; check restricted.idmap.uid and restricted.idmap.gid"
  hub_lxc config device add "clinavat-host:$name" probe disk source="$probe" path="$probe" >/dev/null \
    || fail "the project refuses the probe bind mount; check restricted.devices.disk.paths"
  hub_lxc start "clinavat-host:$name" || fail "the check container does not start"
  for _ in $(seq 1 30); do hub_lxc exec "clinavat-host:$name" -- true >/dev/null 2>&1 && break; sleep 1; done
  hub_lxc exec "clinavat-host:$name" -- setpriv --reuid="$hub_uid" --regid="$hub_gid" --clear-groups -- touch "$probe/written" \
    || fail "the agent user cannot write through the bind mount"
  owner="$(stat -c %u:%g "$probe/written")"
  [[ "$owner" == "$hub_uid:$hub_gid" ]] || fail "files written in the container are owned by $owner on the host, expected $hub_uid:$hub_gid"
  hub_lxc exec "clinavat-host:$name" -- sh -c 'mkdir /sys/fs/cgroup/clinavat-check && rmdir /sys/fs/cgroup/clinavat-check' \
    || fail "the container cannot create cgroups for its processes"
  cleanup_probe
  trap - EXIT
  ok "workspace containers: isolated uid range with Hub uid/gid mapped, bind mounts write as $hub_user, cgroups usable"
}

backup() {
  echo "== backup to $BACKUP"
  install -d -m 700 "$BACKUP"
  lxc network show "$VM_BRIDGE" >"$BACKUP/network.yaml"
  lxc project get "$USER_PROJECT" restricted.devices.disk.paths >"$BACKUP/disk-paths"
  in_gateway tar -C / -cf - etc/clinavat-gw usr/local/lib/clinavat-gw/gwctl.py etc/systemd/network/lan0.network >"$BACKUP/gateway.tar"
  in_gateway sh -c "test -f $PIN_DROPIN && cat $PIN_DROPIN || true" >"$BACKUP/pin.conf"
}

update_gateway() {
  echo "== gateway: controller, return route, VM network"
  lxc file push --project "$GATEWAY_PROJECT" --mode 0700 "$SOURCE/../gateway/gwctl.py" "$GATEWAY_VM$GWCTL"
  # cache_file restores selections on restart; this pins them to the gateway's state as well.
  in_gateway sh -c "mkdir -p ${PIN_DROPIN%/*} && printf '[Service]\nExecStartPost=-$GWCTL pin\n' > $PIN_DROPIN && systemctl daemon-reload"
  local pool_ip
  pool_ip="$(state_field '["infra"]["pool_ip"]')"
  if ! in_gateway grep -q "Destination = $vm_subnet" /etc/systemd/network/lan0.network; then
    in_gateway sh -c "printf '\n[Route]\nDestination = %s\nGateway = %s\n' '$vm_subnet' '$pool_ip' >> /etc/systemd/network/lan0.network"
  fi
  in_gateway networkctl reload
  in_gateway networkctl reconfigure lan0
  for _ in $(seq 1 20); do in_gateway ip route show "$vm_subnet" | grep -q "via $pool_ip" && break; sleep 1; done
  in_gateway ip route show "$vm_subnet" | grep -q "via $pool_ip" || fail "the gateway has no route to $vm_subnet"
  ok "gateway routes $vm_subnet via $pool_ip"
  gwctl vm_subnet.set "{\"vm_subnet\": \"$vm_subnet\", \"overwrite_drift\": true}" >/dev/null
  ok "gateway renders the VM network, DNS hijacking and masquerading"
}

update_host() {
  echo "== host: stop translating VM addresses"
  # Static machine addresses come from the Hub; dynamic leases stay in a separate range for image builds.
  lxc network set "$VM_BRIDGE" ipv4.nat=false ipv4.dhcp.ranges="$dhcp_range" raw.dnsmasq="dhcp-option=option:dns-server,$dns"
  local paths probes
  paths="$(lxc project get "$USER_PROJECT" restricted.devices.disk.paths)"
  probes="/run/user/$hub_uid/clinavat/usage-probes"
  [[ ",$paths," == *",$probes,"* ]] || lxc project set "$USER_PROJECT" restricted.devices.disk.paths="$paths,$probes"
  ok "VM addresses reach the gateway unchanged; VMs resolve through $dns"
}

bind() {
  echo "== gateway: bind the pool machine and switch to per-source egress"
  local pool_ip result
  pool_ip="$(state_field '["infra"]["pool_ip"]')"
  [[ -n "$node" ]] || node="$(state_field '["state"]["selected"]')"
  result="$(gwctl binding.set "{\"address\": \"$pool_ip\", \"node\": \"$node\", \"label\": \"号池机（宿主机）\"}")"
  confirm_pending "$result"
  # Image builds download packages and CLIs from a fixed builder address.
  result="$(gwctl binding.set "{\"address\": \"$builder\", \"node\": \"$node\", \"label\": \"镜像构建\"}")"
  confirm_pending "$result"
  result="$(gwctl source_policy.set '{"source_policy": "bound"}')"
  confirm_pending "$result"
  ok "pool machine $pool_ip and image builder $builder bound to $node; unbound sources are rejected"
}

remove_old_machines() {
  echo "== old per-user machines"
  local names
  names="$(lxc list --project "$USER_PROJECT" --format csv -c n | grep '^u-' || true)"
  if [[ -z "$names" ]]; then ok "none"; return; fi
  echo "$names" | sed 's/^/  /'
  echo "  These run without fixed addresses and would have no egress. Their data lives on this host and is kept;"
  echo "  the Hub recreates each user's workspace as a container from the clinavat-workspace image on first use."
  local answer=""
  read -r -p "  Delete them now? Type yes: " answer
  [[ "$answer" == yes ]] || { echo "  kept; delete them before starting the Hub: lxc delete --force --project $USER_PROJECT <name>"; return; }
  for name in $names; do lxc delete --force --project "$USER_PROJECT" "$name"; done
  ok "deleted"
}

verify() {
  echo "== verify"
  local expected direct
  expected="$(gwctl status | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["health"].get("egress_ip") or "")')"
  [[ -n "$expected" ]] || fail "the gateway reports no proxy egress"
  direct="$(runuser -u "$hub_user" -- curl -4 -s -m 15 https://cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')"
  [[ "$direct" == "$expected" ]] || fail "the pool machine leaves as '$direct', expected its node's $expected"
  ok "the pool machine leaves through its node as $expected"
  runuser -u "$hub_user" -- getent ahostsv4 api.anthropic.com >/dev/null || fail "the pool machine cannot resolve names"
  ok "name resolution through the gateway works"
  local problems
  problems="$(gwctl status | python3 -I -c 'import json,sys; print("；".join(json.load(sys.stdin)["health"]["problems"]))')"
  [[ -z "$problems" ]] || fail "gateway health: $problems"
  ok "gateway health checks pass, live bindings match the state"
}

rollback() {
  echo "== rollback"
  [[ -d "$BACKUP" ]] || fail "no backup in $BACKUP"
  # Back to one shared node first, so every source has egress again before addresses change.
  local shared
  if shared="$(gwctl source_policy.set '{"source_policy": "shared"}' 2>/dev/null)"; then confirm_pending "$shared"; fi
  feed_gateway tar -C / -xf - <"$BACKUP/gateway.tar"
  if [[ -s "$BACKUP/pin.conf" ]]; then feed_gateway sh -c "cat > $PIN_DROPIN" <"$BACKUP/pin.conf"; else in_gateway rm -f "$PIN_DROPIN"; fi
  in_gateway systemctl daemon-reload
  in_gateway networkctl reload
  in_gateway networkctl reconfigure lan0
  local activated
  if activated="$(gwctl activate '{}')"; then confirm_pending "$activated"
  else echo "  warning: re-activating the restored gateway state failed; check gwctl status" >&2; fi
  lxc network edit "$VM_BRIDGE" <"$BACKUP/network.yaml"
  lxc project set "$USER_PROJECT" restricted.devices.disk.paths="$(cat "$BACKUP/disk-paths")"
  echo "rolled back. Machines created after apply have fixed addresses and work with the shared node as well."
}

case "$command" in
  prepare-containers) prepare_containers ;;
  remove-old-machines)
    [[ -n "$hub_user" ]] || fail "--hub-user is required"
    for unit in clinavat-hub.service clinavat-web.service; do
      if systemctl --user --machine="$hub_user@" is-active --quiet "$unit" 2>/dev/null; then fail "$unit is running; stop it first as $hub_user: npm run host:stop"; fi
    done
    remove_old_machines ;;
  check) preflight ;;
  apply)
    preflight
    [[ ! -e "$BACKUP" ]] || fail "$BACKUP exists from an earlier run; use rollback, or move it aside"
    backup
    update_gateway
    update_host
    bind
    verify
    remove_old_machines
    echo "done. Start the Hub as $hub_user (npm run host:start), then bind each slot in the admin panel: 网关 → 出口绑定." ;;
  rollback) rollback ;;
  *) sed -n '2,18p' "$0"; exit 64 ;;
esac
