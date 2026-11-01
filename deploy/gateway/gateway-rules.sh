#!/bin/bash
# Loads the Clinavat gateway guard rendered by gwctl. Installed as /usr/local/bin/gateway-rules.sh.
# The guard is a kill switch: stopping this unit or a missing render still blocks the pool
# network from leaving through the WAN interface outside the private ranges.
set -euo pipefail

GUARD=/etc/clinavat-gw/rendered/guard.nft
LAN_IF="eth1"
WAN_IF="eth0"
LAN_SUBNET="10.10.10.0/24"

fail_closed() {
  nft -f - <<EOF
table inet clinavat_guard
delete table inet clinavat_guard
table inet clinavat_guard {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr $LAN_SUBNET oifname "$WAN_IF" masquerade
  }
  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    iifname "$LAN_IF" oifname "$WAN_IF" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } accept
    iifname "$LAN_IF" oifname "$WAN_IF" ct status dnat accept
    iifname "$LAN_IF" oifname "$WAN_IF" counter drop
  }
}
EOF
}

case "${1:-}" in
  start)
    if [[ -f "$GUARD" ]] && nft -f "$GUARD"; then
      exit 0
    fi
    echo "gateway-rules: rendered guard missing or invalid, loading fail-closed rules" >&2
    fail_closed
    ;;
  stop)
    # Keep the kill switch; only inbound DNAT and direct lists are dropped.
    fail_closed
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 64
    ;;
esac
