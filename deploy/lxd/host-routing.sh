#!/bin/bash
# Install guest policy routing on a host with its own default route.
# sudo deploy/lxd/host-routing.sh install --gateway <LAN IPv4> --hub-user <user>
set -euo pipefail

VM_BRIDGE=clinavat-users
LAN_BRIDGE=clinavat-lan
RUNTIME=/usr/local/libexec/clinavat-routing
UNIT=clinavat-routing.service
GUEST_TABLE=3131
GUEST_PRIORITY=3131
REPLY_PRIORITY=3130

fail() { echo "FAIL: $*" >&2; exit 1; }

action="${1:-}"; shift || true
gateway="" hub_user=""
while (($#)); do
  (($# >= 2)) || fail "missing value for $1"
  case "$1" in
    --gateway) gateway="$2" ;;
    --hub-user) hub_user="$2" ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift 2
done
[[ $EUID -eq 0 ]] || fail "must run as root"
[[ -n "$gateway" ]] || fail "--gateway is required"

read_networks() {
  local vm_cidr
  vm_cidr="$(/snap/bin/lxc network get "$VM_BRIDGE" ipv4.address </dev/null)" || return
  ip -4 -j addr show dev "$LAN_BRIDGE" scope global | python3 -I -c '
import ipaddress, json, sys

vm = ipaddress.IPv4Interface(sys.argv[1])
gateway = ipaddress.IPv4Address(sys.argv[2])
interfaces = [ipaddress.IPv4Interface((address["local"], address["prefixlen"]))
              for link in json.load(sys.stdin) for address in link["addr_info"]]
networks = {interface.network for interface in interfaces
            if gateway in interface.network and gateway != interface.ip}
if len(networks) != 1:
    sys.exit(f"{gateway} must be on a single directly connected LAN subnet")
(lan,) = networks
if vm.network.overlaps(lan):
    sys.exit(f"VM subnet {vm.network} overlaps gateway LAN subnet {lan}")
print(vm.ip, vm.network, vm.network.prefixlen - 1, lan)
' "$vm_cidr" "$gateway"
}

read_rule_slot() {
  local priority="$1" expected="$2" current
  current="$(ip -4 rule show priority "$priority")"
  [[ -z "$current" || "$current" == "$priority:"$'\t'"$expected" ]] || fail "routing rule priority $priority is already occupied"
  printf '%s' "$current"
}

apply_routes() {
  local attempt networks vm_address vm_subnet suppress_prefix lan_subnet reply_rule guest_rule
  for ((attempt=0; attempt<30; attempt++)); do
    if [[ -n "$(ip -4 -o addr show dev "$VM_BRIDGE" scope global 2>/dev/null)" &&
          -n "$(ip -4 -o addr show dev "$LAN_BRIDGE" scope global 2>/dev/null)" ]]; then
      break
    fi
    sleep 1
  done
  ((attempt < 30)) || fail "$VM_BRIDGE and $LAN_BRIDGE must both have IPv4 addresses"
  networks="$(read_networks)" || fail "cannot determine the VM and gateway LAN subnets"
  read -r vm_address vm_subnet suppress_prefix lan_subnet <<<"$networks"
  reply_rule="$(read_rule_slot "$REPLY_PRIORITY" "from $vm_address to $vm_subnet iif lo lookup main suppress_prefixlength $suppress_prefix")"
  guest_rule="$(read_rule_slot "$GUEST_PRIORITY" "from $vm_subnet lookup $GUEST_TABLE")"

  sysctl -q -w net.ipv4.ip_forward=1
  sysctl -q -w "net.ipv4.conf.$VM_BRIDGE.rp_filter=2"
  sysctl -q -w "net.ipv4.conf.$LAN_BRIDGE.rp_filter=2"
  ip -4 route replace unreachable default metric 32767 table "$GUEST_TABLE"
  ip -4 route replace "$vm_subnet" dev "$VM_BRIDGE" scope link table "$GUEST_TABLE"
  ip -4 route replace "$lan_subnet" dev "$LAN_BRIDGE" scope link table "$GUEST_TABLE"
  ip -4 route replace default via "$gateway" dev "$LAN_BRIDGE" metric 100 table "$GUEST_TABLE"
  # LXD rebuilds the connected route in main when it reconfigures the VM bridge.
  if [[ -z "$reply_rule" ]]; then
    ip -4 rule add priority "$REPLY_PRIORITY" from "$vm_address" to "$vm_subnet" iif lo lookup main suppress_prefixlength "$suppress_prefix"
  fi
  if [[ -z "$guest_rule" ]]; then
    ip -4 rule add priority "$GUEST_PRIORITY" from "$vm_subnet" lookup "$GUEST_TABLE"
  fi
}

install_service() {
  local hub_uid
  [[ -n "$hub_user" ]] || fail "--hub-user is required"
  hub_uid="$(id -u "$hub_user")" || fail "unknown Hub user: $hub_user"
  apply_routes
  install -Dm755 "${BASH_SOURCE[0]}" "$RUNTIME"
  cat >"/etc/systemd/system/$UNIT" <<SERVICE
[Unit]
Description=Route only Clinavat guest traffic through its gateway
After=snap.lxd.daemon.service firewalld.service
Wants=snap.lxd.daemon.service firewalld.service
Before=user@$hub_uid.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$RUNTIME apply --gateway $gateway
Restart=on-failure
RestartSec=3s
TimeoutStartSec=40s

[Install]
WantedBy=multi-user.target
SERVICE
  chmod 644 "/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  systemctl enable "$UNIT"
  systemctl restart "$UNIT"
}

case "$action" in
  install) install_service ;;
  apply) apply_routes ;;
  *) fail "usage: $0 install --gateway <LAN IPv4> --hub-user <user>" ;;
esac
