#!/bin/bash
# Moves the upstream gateway into a VM on this machine. Run as root; see docs/vm-isolation.md.
#
#   sudo deploy/lxd/gateway-vm.sh prepare  --old root@<old gateway> --ssh-user <user with a key on it> --wan-if <NIC>
#   sudo deploy/lxd/gateway-vm.sh cutover  --old root@<old gateway> --ssh-user <user> --host-address <cidr> --gateway <address>
#   sudo deploy/lxd/gateway-vm.sh rollback --old root@<old gateway> --ssh-user <user>
#   sudo deploy/lxd/gateway-vm.sh diagnose --old root@<old gateway> --ssh-user <user> [--report <file>]
#   sudo deploy/lxd/gateway-vm.sh refresh  --old root@<old gateway> --ssh-user <user>
#
# prepare builds the VM without touching traffic. cutover takes the old gateway's WAN down and starts the VM with
# the same addresses and MACs. It arms a timer first, so an unanswered or lost session rolls back by itself.
set -euo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GATEWAY_SOURCE="$SOURCE/../gateway"
PROJECT=clinavat-gateway
VM=clinavat-gateway
BRIDGE=clinavat-lan
POOL=clinavat
BUILD_NETWORK=clinavat-users
IMAGE=ubuntu-minimal:26.04
NETPLAN_LAN=/etc/netplan/60-clinavat-lan.yaml
NETPLAN_MAIN=/etc/netplan/00-installer-config.yaml
BACKUP=/var/lib/clinavat-gateway-cutover
ROLLBACK_UNIT=clinavat-gateway-rollback
ROLLBACK_SECONDS=600
OLD_FILES=(etc/cc-pool-gw/infra.json etc/cc-pool-gw/state.json etc/cc-pool-gw/certs var/lib/cc-pool-gw/acme var/lib/cc-pool-gw/audit.jsonl
  root/.ssh/authorized_keys etc/systemd/network/eth0.network etc/systemd/network/eth1.network etc/resolv.conf)

command="${1:-}"; shift || true
old="" ssh_user="" wan_if="" host_address="" gateway="" lan_if=ens18 dns="10.10.10.1 1.1.1.1" report=""
while (($#)); do
  case "$1" in
    --old) old="$2"; shift 2 ;;
    --ssh-user) ssh_user="$2"; shift 2 ;;
    --wan-if) wan_if="$2"; shift 2 ;;
    --host-address) host_address="$2"; shift 2 ;;
    --gateway) gateway="$2"; shift 2 ;;
    --lan-if) lan_if="$2"; shift 2 ;;
    --dns) dns="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ -n "$old" && -n "$ssh_user" ]] || { echo "--old and --ssh-user are required" >&2; exit 64; }

lxc() { /snap/bin/lxc "$@"; }
# lxc reads configuration from stdin when it is not a terminal, so anything without input gets /dev/null.
vm() { lxc --project "$PROJECT" "$@" </dev/null; }
in_vm() { vm exec "$VM" -- "$@"; }
on_old() { sudo -u "$ssh_user" -H ssh -o BatchMode=yes -o ConnectTimeout=10 "$old" "$@"; }

wait_for_agent() {
  for _ in $(seq 1 150); do
    if in_vm true >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "gateway VM agent did not come up" >&2
  return 1
}

import_from_old() {
  local wan_mac="$1" lan_mac="$2"
  lxc exec "$VM" --project "$PROJECT" -- bash -c 'rm -rf /root/gateway-import && install -d -m 700 /root/gateway-import' </dev/null
  # Keys and tokens stay in the pipe; nothing is written on this machine.
  on_old tar -C / -cf - "${OLD_FILES[@]}" --ignore-failed-read etc/ssh/ssh_host_{rsa,ecdsa,ed25519}_key{,.pub} \
    | lxc exec "$VM" --project "$PROJECT" -- tar -C /root/gateway-import -xf -
  lxc exec "$VM" --project "$PROJECT" -- bash -s -- "$wan_mac" "$lan_mac" <"$SOURCE/gateway-import.sh"
}

prepare() {
  [[ -n "$wan_if" ]] || { echo "--wan-if is required" >&2; exit 64; }
  [[ -z "$(ip -o addr show dev "$wan_if")" ]] || { echo "$wan_if must have no addresses on this host; traffic through it would skip the gateway" >&2; exit 1; }
  local wan_mac lan_mac
  wan_mac="$(on_old cat /sys/class/net/eth0/address)"
  lan_mac="$(on_old cat /sys/class/net/eth1/address)"

  echo "== bridge $BRIDGE (no address until cutover)"
  if [[ ! -f "$NETPLAN_LAN" ]]; then
    printf 'network:\n  version: 2\n  bridges:\n    %s:\n      dhcp4: false\n      link-local: []\n      parameters: { stp: false, forward-delay: 0 }\n' "$BRIDGE" >"$NETPLAN_LAN"
    chmod 600 "$NETPLAN_LAN"
    netplan apply
  fi

  echo "== project $PROJECT"
  lxc project show "$PROJECT" >/dev/null 2>&1 </dev/null || lxc project create "$PROJECT" \
    -c features.images=true -c features.profiles=true -c features.storage.volumes=true -c features.networks=false </dev/null
  vm profile set default limits.cpu=2 limits.memory=768MiB
  vm profile device get default root pool >/dev/null 2>&1 || vm profile device add default root disk pool="$POOL" path=/ size=6GiB

  echo "== launch"
  if ! vm info "$VM" >/dev/null 2>&1; then
    vm init "$IMAGE" "$VM" --vm
    vm config device add "$VM" build nic network="$BUILD_NETWORK" name=build
    vm start "$VM"
  fi
  wait_for_agent

  echo "== check that macvlan traffic passes the upper bridge"
  vm config device add "$VM" wan-test nic nictype=macvlan parent="$wan_if" name=wantest
  sleep 5
  local test_if result
  test_if="$(in_vm bash -c 'for n in /sys/class/net/*; do b=$(basename "$n"); [ "$b" = lo ] && continue; ip -4 -o addr show dev "$b" | grep -q . || { echo "$b"; break; }; done')"
  result="$(lxc exec "$VM" --project "$PROJECT" -- bash -s -- "$test_if" </dev/null 2>/dev/null <<'CHECK' || true
printf '[Match]\nName=%s\n\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\n\n[DHCPv4]\nUseRoutes=no\nUseDNS=no\n' "$1" >/run/systemd/network/90-wantest.network
networkctl reload
for _ in $(seq 1 30); do ip -4 -o addr show dev "$1" scope global | grep -q . && { echo up; break; }; sleep 1; done
rm -f /run/systemd/network/90-wantest.network
CHECK
)"
  vm config device remove "$VM" wan-test
  if [[ "$result" != up ]]; then
    echo "no DHCP answer through macvlan on $wan_if: check MAC filtering on the upper platform's bridge" >&2
    exit 1
  fi
  echo "macvlan OK"

  echo "== provision"
  tar -C "$GATEWAY_SOURCE" -cf - gwctl.py gateway-rules.sh gateway-rules.service \
    | lxc exec "$VM" --project "$PROJECT" -- bash -c 'install -d -m 700 /root/clinavat-gateway && tar -C /root/clinavat-gateway -xf -'
  cat "$GATEWAY_SOURCE/acme-units.sh" "$SOURCE/gateway-provision.sh" | lxc exec "$VM" --project "$PROJECT" -- bash -s

  echo "== import and review"
  import_from_old "$wan_mac" "$lan_mac"
  in_vm /usr/local/lib/clinavat-gw/gwctl.py render '{"directory": "/root/gateway-review"}' >/dev/null
  echo "rendered and checked (sing-box check, nft -c, nginx -t)"

  echo "== final devices; the VM stays stopped"
  vm stop "$VM"
  vm config device remove "$VM" build
  vm config device add "$VM" wan nic nictype=macvlan parent="$wan_if" hwaddr="$wan_mac"
  vm config device add "$VM" lan nic nictype=bridged parent="$BRIDGE" hwaddr="$lan_mac"
  echo "ready; run cutover in a maintenance window"
}

# Everything needed to explain a network failure, since the VM is stopped again by the time anyone looks.
collect_guest_state() {
  in_vm bash -c '
    echo "--- links"; ip -br link; ip -br addr
    echo "--- macs"; for n in /sys/class/net/*; do echo "$(basename "$n") $(cat "$n/address")"; done
    echo "--- networkd"; networkctl list --no-pager --no-legend; ls /etc/systemd/network/; head -20 /etc/systemd/network/*.link
    echo "--- routes"; ip route; ip -6 route | grep -v "^fe80"
    echo "--- services"; systemctl is-active systemd-networkd systemd-udevd gateway-rules sing-box nginx ssh | paste -sd" "; systemctl --failed --no-legend --no-pager
    echo "--- rename messages"; journalctl -b --no-pager -o short-monotonic | grep -E "renamed|Failed to rename|eth[01]|enp[0-9]|wan|File exists" | tail -40
    echo "--- nft tables"; nft list tables; nft list table inet clinavat_guard 2>/dev/null | grep -E "chain |iifname|oifname" | head -20
    echo "--- sysctl"; sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.ipv4.conf.all.arp_ignore 2>/dev/null
  ' 2>&1 || echo "could not read guest state"
}

# Starts the prepared VM with its WAN NIC on the empty bridge, so it takes no address on the real network.
start_isolated() {
  [[ "$(vm list "^$VM$" --format csv -c s)" == STOPPED ]] || { echo "gateway VM must be stopped" >&2; exit 1; }
  wan_parent="$(vm config device get "$VM" wan parent)"
  stop_isolated() {
    ip addr del 10.10.99.2/24 dev "$BRIDGE" 2>/dev/null || true
    # A forced stop is a power cut: files written just before it would be lost.
    in_vm sync 2>/dev/null || true
    vm stop "$VM" --timeout 60 2>/dev/null || vm stop "$VM" --force 2>/dev/null || true
    vm config device set "$VM" wan parent="$wan_parent"
  }
  trap stop_isolated EXIT
  vm config device set "$VM" wan parent="$BRIDGE"
  vm start "$VM"
  wait_for_agent
}

# Applies changes to the control-plane files and the import to a prepared VM without rebuilding it.
refresh() {
  local wan_mac lan_mac
  wan_mac="$(vm config device get "$VM" wan hwaddr)"
  lan_mac="$(vm config device get "$VM" lan hwaddr)"
  start_isolated
  tar -C "$GATEWAY_SOURCE" -cf - gwctl.py gateway-rules.sh gateway-rules.service \
    | lxc exec "$VM" --project "$PROJECT" -- bash -c 'install -d -m 700 /root/clinavat-gateway && tar -C /root/clinavat-gateway -xf - &&
      install -m 700 /root/clinavat-gateway/gwctl.py /usr/local/lib/clinavat-gw/gwctl.py &&
      install -m 755 /root/clinavat-gateway/gateway-rules.sh /usr/local/bin/gateway-rules.sh'
  import_from_old "$wan_mac" "$lan_mac"
  in_vm /usr/local/lib/clinavat-gw/gwctl.py render '{"directory": "/root/gateway-review"}' >/dev/null
  in_vm test -f /etc/systemd/network/10-wan0.link || { echo "import did not write the interface names" >&2; exit 1; }
  echo "refreshed; run diagnose to confirm the interfaces"
}

diagnose() {
  local test_host=10.10.99.2 test_guest=10.10.99.1 wan_mac lan_mac
  wan_mac="$(vm config device get "$VM" wan hwaddr)"
  lan_mac="$(vm config device get "$VM" lan hwaddr)"
  start_isolated
  sleep 20
  if verify_interfaces "$wan_mac" "$lan_mac"; then echo "interfaces OK: wan0 and lan0 hold the expected MACs and addresses"; else echo "INTERFACES WRONG"; fi
  collect_guest_state
  echo "--- layer 2 path from this host to the guest LAN port (test addresses only)"
  ip addr add "$test_host/24" dev "$BRIDGE"
  bridge link show master "$BRIDGE" 2>&1 || true
  for candidate in $(in_vm bash -c 'ls /sys/class/net | grep -v lo'); do
    in_vm ip addr add "$test_guest/24" dev "$candidate" 2>/dev/null || continue
    if ping -c 2 -W 2 -I "$BRIDGE" "$test_guest" >/dev/null 2>&1; then echo "$candidate: reachable from the bridge"; else echo "$candidate: not reachable from the bridge"; fi
    in_vm ip addr del "$test_guest/24" dev "$candidate" 2>/dev/null || true
  done
}

# A crossed configuration also inverts the guard, so this runs before any traffic can reach the VM. $1 WAN MAC, $2 LAN MAC
verify_interfaces() {
  lxc exec "$VM" --project "$PROJECT" -- bash -s -- "$1" "$2" </dev/null 2>&1 <<'CHECK'
wan_ip="$(python3 -I -c 'import json; print(json.load(open("/etc/clinavat-gw/infra.json"))["wan_ip"])')"
lan_ip="$(python3 -I -c 'import json; print(json.load(open("/etc/clinavat-gw/infra.json"))["pool_ip"].rsplit(".",1)[0])')"
for _ in $(seq 1 20); do
  if [ "$(cat /sys/class/net/wan0/address 2>/dev/null)" = "$1" ] && [ "$(cat /sys/class/net/lan0/address 2>/dev/null)" = "$2" ] \
    && ip -4 -o addr show dev wan0 | grep -qF " $wan_ip/" && ip -4 -o addr show dev lan0 | grep -qF " $lan_ip."; then exit 0; fi
  sleep 1
done
ip -br addr >&2
exit 1
CHECK
}

write_host_network() {
  printf 'network:\n  version: 2\n  ethernets:\n    %s:\n      dhcp4: false\n      link-local: []\n      optional: true\n' "$lan_if" >"$NETPLAN_MAIN"
  local servers; servers="$(printf '%s, ' $dns)"
  printf 'network:\n  version: 2\n  bridges:\n    %s:\n      dhcp4: false\n      link-local: []\n      addresses: [%s]\n      routes:\n        - to: default\n          via: %s\n      nameservers:\n        addresses: [%s]\n      parameters: { stp: false, forward-delay: 0 }\n' \
    "$BRIDGE" "$host_address" "$gateway" "${servers%, }" >"$NETPLAN_LAN"
  chmod 600 "$NETPLAN_MAIN" "$NETPLAN_LAN"
  netplan apply
}

rollback() {
  echo "== rollback"
  systemctl stop "$ROLLBACK_UNIT.timer" 2>/dev/null || true
  vm stop "$VM" --force 2>/dev/null || true
  if [[ -f "$BACKUP/main.yaml" ]]; then
    cp -a "$BACKUP/main.yaml" "$NETPLAN_MAIN"
    cp -a "$BACKUP/lan.yaml" "$NETPLAN_LAN"
    netplan apply
  fi
  # Restarting sing-box puts its routes back; a failure here is fixed by restarting the old gateway from the platform.
  on_old 'ip link set eth0 up && networkctl reconfigure eth0; sleep 2; systemctl restart gateway-rules sing-box nginx' \
    || echo "could not reach the old gateway; restart it from the virtualization platform console" >&2
  echo "rolled back to the old gateway"
}

cutover() {
  [[ -n "$host_address" && -n "$gateway" ]] || { echo "--host-address and --gateway are required" >&2; exit 64; }
  [[ "$(vm list "^$VM$" --format csv -c s)" == STOPPED ]] || { echo "gateway VM must be prepared and stopped" >&2; exit 1; }
  local wan_mac lan_mac
  wan_mac="$(on_old cat /sys/class/net/eth0/address)"
  lan_mac="$(on_old cat /sys/class/net/eth1/address)"
  install -d -m 700 "$BACKUP"
  cp -a "$NETPLAN_MAIN" "$BACKUP/main.yaml"
  cp -a "$NETPLAN_LAN" "$BACKUP/lan.yaml"

  echo "== arming automatic rollback in $ROLLBACK_SECONDS seconds"
  systemctl reset-failed "$ROLLBACK_UNIT.timer" "$ROLLBACK_UNIT.service" 2>/dev/null || true
  systemd-run --quiet --unit="$ROLLBACK_UNIT" --on-active="$ROLLBACK_SECONDS" --timer-property=AccuracySec=1s \
    "$SOURCE/gateway-vm.sh" rollback --old "$old" --ssh-user "$ssh_user"
  on_failure() {
    echo "cutover failed" >&2
    collect_guest_state >"$BACKUP/failure-$(date +%Y%m%dT%H%M%S).log" 2>&1 || true
    rollback
  }
  trap on_failure ERR

  echo "== old gateway WAN down"
  on_old ip link set eth0 down
  echo "== start gateway VM"
  vm start "$VM"
  wait_for_agent
  # Taken after the WAN went down, so nothing can change on the old gateway afterwards.
  import_from_old "$wan_mac" "$lan_mac"
  in_vm systemctl restart systemd-networkd ssh
  verify_interfaces "$wan_mac" "$lan_mac" || { echo "gateway VM interfaces do not match their MACs and addresses" >&2; false; }
  echo "== move this host's address to $BRIDGE"
  write_host_network
  # The address appears asynchronously after netplan apply, and the first ARP may go out before it.
  ping -c 1 -w 30 "$gateway" >/dev/null || { echo "gateway LAN address does not answer from this host" >&2; false; }

  echo "== activate"
  local activation revision
  activation="$(in_vm /usr/local/lib/clinavat-gw/gwctl.py activate)"
  revision="$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["result"].get("revision") or "")' "$activation")"
  # The gateway's own 90-second rollback would restore an empty configuration; this script's timer covers the window.
  [[ -z "$revision" ]] || in_vm /usr/local/lib/clinavat-gw/gwctl.py confirm "$revision" >/dev/null
  in_vm /usr/local/lib/clinavat-gw/gwctl.py status | python3 -I -c 'import json,sys; h=json.load(sys.stdin)["result"]["health"]; print({k: h[k] for k in ("sing_box","tun","guard","egress_ip","upstream","sites","problems")})'
  echo "host egress: $(curl -4 -sS -m 15 https://ifconfig.me/ip || echo FAILED)"
  trap - ERR

  local answer=""
  read -r -t "$((ROLLBACK_SECONDS - 60))" -p "Keep the new gateway? Type yes within the window: " answer || true
  if [[ "$answer" != yes ]]; then rollback; exit 1; fi
  systemctl stop "$ROLLBACK_UNIT.timer"
  vm config set "$VM" boot.autostart=true boot.autostart.priority=100
  echo "new gateway active. Keep the old one stopped from the platform console; see docs/vm-isolation.md for cleanup."
}

case "$command" in
  prepare) prepare ;;
  cutover) cutover ;;
  rollback) rollback ;;
  refresh) refresh ;;
  diagnose)
    if [[ -n "$report" ]]; then
      diagnose 2>&1 | tee "$report"
      chown "$ssh_user" "$report"
    else diagnose; fi ;;
  *) echo "usage: $0 prepare|cutover|rollback|diagnose|refresh ..." >&2; exit 64 ;;
esac
