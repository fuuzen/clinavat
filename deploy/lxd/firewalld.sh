#!/bin/bash
# Shared firewalld zone and port helpers sourced by deploy/lxd/setup.sh and deploy/lxd/host-commands.sh.
# Expects $NETWORK (and for port checks/writes: $bridge, $subnet, $port, $relay_port, $hub_user).

FIREWALLD_ZONE=cv-users
FIREWALLD_RESOLVED_ZONE=""

declare -F fail >/dev/null || fail() { echo "FAIL: $*" >&2; exit 1; }
declare -F ok >/dev/null || ok() { echo "  ok: $*"; }
declare -F warn >/dev/null || warn() { echo "  warning: $*" >&2; }
declare -F problem >/dev/null || problem() { echo "  FAIL: $*" >&2; problems=$(( ${problems:-0} + 1 )); }

firewalld_active() {
  command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1
}

firewalld_zone_exists() {
  local scope="$1" zone="$2" zones=""
  local -a scope_args=()
  [[ -n "$zone" ]] || return 1
  [[ "$scope" == permanent ]] && scope_args=(--permanent)
  zones="$(firewall-cmd "${scope_args[@]}" --get-zones 2>&1)" \
    || fail "firewall-cmd --get-zones ($scope) failed: ${zones:-unknown error}"
  printf '%s\n' "$zones" | tr ' \t' '\n' | grep -qxF -- "$zone"
}

firewalld_interface_zone() {
  local scope="$1" out="" rc=0
  local -a scope_args=()
  [[ "$scope" == permanent ]] && scope_args=(--permanent)
  out="$(firewall-cmd "${scope_args[@]}" --get-zone-of-interface="$NETWORK" 2>&1)" || rc=$?
  if (( rc == 0 )); then
    [[ "$out" == "no zone" ]] && return 0
    printf '%s' "$out"
    return 0
  fi
  if grep -qi 'no zone' <<<"$out"; then
    return 0
  fi
  fail "firewall-cmd --get-zone-of-interface=$NETWORK ($scope) failed (rc=$rc): ${out:-unknown error}"
}

# --get-target is [P only] in firewall-cmd, so runtime target is parsed from --list-all.
firewalld_zone_target() {
  local scope="$1" zone="$2" out="" target=""
  if [[ "$scope" == permanent ]]; then
    firewall-cmd --permanent --zone="$zone" --get-target 2>/dev/null
    return $?
  fi
  out="$(firewall-cmd --zone="$zone" --list-all 2>/dev/null)" || return 1
  target="$(sed -nE 's/^[[:space:]]*target:[[:space:]]*([^[:space:]]+).*/\1/p' <<<"$out" | head -n1)"
  [[ -n "$target" ]] || return 1
  printf '%s\n' "$target"
}

firewalld_bind_runtime() {
  local zone="$1" current_rt=""
  if firewalld_zone_exists runtime "$zone"; then
    firewall-cmd --zone="$zone" --change-interface="$NETWORK" >/dev/null \
      || fail "failed to bind $NETWORK to firewalld zone $zone (runtime)"
  else
    firewall-cmd --reload >/dev/null \
      || fail "failed to reload firewalld while activating zone $zone"
    current_rt="$(firewalld_interface_zone runtime)" || exit 1
    if [[ "$current_rt" != "$zone" ]]; then
      firewall-cmd --zone="$zone" --change-interface="$NETWORK" >/dev/null \
        || fail "failed to bind $NETWORK to firewalld zone $zone (runtime)"
    fi
  fi
}

firewalld_ensure_zone() {
  firewalld_active || return 0
  echo "== Firewalld zone $FIREWALLD_ZONE"
  local rt_zone perm_zone
  rt_zone="$(firewalld_interface_zone runtime)" || exit 1
  perm_zone="$(firewalld_interface_zone permanent)" || exit 1

  if [[ -n "$rt_zone" && -n "$perm_zone" ]]; then
    if [[ "$rt_zone" == "$perm_zone" ]]; then
      echo "firewalld: $NETWORK is already bound to zone $rt_zone"
      return 0
    fi
    fail "firewalld binds $NETWORK to conflicting zones: $rt_zone (runtime) vs $perm_zone (permanent)"
  fi

  if [[ -n "$rt_zone" ]]; then
    firewall-cmd --permanent --zone="$rt_zone" --change-interface="$NETWORK" >/dev/null \
      || fail "failed to bind $NETWORK to firewalld zone $rt_zone (--permanent)"
    echo "firewalld: bound $NETWORK to zone $rt_zone (--permanent)"
    return 0
  fi

  if [[ -n "$perm_zone" ]]; then
    firewalld_bind_runtime "$perm_zone"
    echo "firewalld: bound $NETWORK to zone $perm_zone (runtime)"
    return 0
  fi

  if ! firewalld_zone_exists permanent "$FIREWALLD_ZONE"; then
    firewall-cmd --permanent --new-zone="$FIREWALLD_ZONE" >/dev/null \
      || fail "failed to create firewalld zone $FIREWALLD_ZONE"
    firewall-cmd --permanent --zone="$FIREWALLD_ZONE" --set-target=DROP >/dev/null \
      || fail "failed to set target=DROP on firewalld zone $FIREWALLD_ZONE"
    firewall-cmd --permanent --zone="$FIREWALLD_ZONE" --add-service=dhcp --add-service=dns >/dev/null \
      || fail "failed to add dhcp/dns services to firewalld zone $FIREWALLD_ZONE"
  fi
  firewall-cmd --permanent --zone="$FIREWALLD_ZONE" --change-interface="$NETWORK" >/dev/null \
    || fail "failed to bind $NETWORK to firewalld zone $FIREWALLD_ZONE (--permanent)"
  firewalld_bind_runtime "$FIREWALLD_ZONE"
  echo "firewalld: bound $NETWORK to zone $FIREWALLD_ZONE"
}

firewalld_zone_allows_port() {
  local scope="$1" zone="$2" target_port="$3"
  local -a scope_args=()
  [[ "$scope" == permanent ]] && scope_args=(--permanent)
  local target ports services rich_rules
  target="$(firewalld_zone_target "$scope" "$zone")" || return 1
  ports="$(firewall-cmd "${scope_args[@]}" --zone="$zone" --list-ports 2>/dev/null)" || return 1
  services="$(firewall-cmd "${scope_args[@]}" --zone="$zone" --list-services 2>/dev/null)" || return 1
  rich_rules="$(firewall-cmd "${scope_args[@]}" --zone="$zone" --list-rich-rules 2>/dev/null)" || return 1

  python3 -I -c '
import ipaddress, shlex, sys

bridge_ip = ipaddress.ip_address(sys.argv[1])
subnet_net = ipaddress.ip_network(sys.argv[2], strict=False)
target_port = int(sys.argv[3])
target, ports, services = sys.argv[4], sys.argv[5], sys.argv[6]

def port_in_spec(spec, port_num):
    if "-" in spec:
        lo, hi = spec.split("-", 1)
        return lo.isdigit() and hi.isdigit() and int(lo) <= port_num <= int(hi)
    return spec.isdigit() and int(spec) == port_num

def parse_ipv4_net(addr):
    if not addr:
        return None
    try:
        net = ipaddress.ip_network(addr, strict=False)
    except ValueError:
        return None
    return net if isinstance(net, ipaddress.IPv4Network) else None

accept_prios = []
block_prios = []

if target.strip().upper() == "ACCEPT":
    accept_prios.append(float("inf"))

for entry in ports.split():
    if "/" in entry:
        spec, proto = entry.split("/", 1)
        if proto.lower() == "tcp" and port_in_spec(spec, target_port):
            accept_prios.append(0)
            break

if target_port == 22 and "ssh" in services.split():
    accept_prios.append(0)

ignored = {"forward-port", "masquerade", "icmp-block", "icmp-type", "source-port", "mark"}
actions = {"accept", "drop", "reject"}
clauses = {"source", "destination", "port", "service", "protocol", "log", "nflog", "audit", "limit"} | actions | ignored

def classify_rich_rule(line):
    try:
        tokens = shlex.split(line)
    except ValueError:
        return None
    if not tokens or tokens[0] != "rule":
        return None

    priority = 0
    family = action = source_addr = dest_addr = service_name = proto_val = port_clause = None
    has_source = has_dest = src_not = dst_not = False
    src_non_addr = dst_non_addr = False
    clause = "rule"

    for tok in tokens[1:]:
        low = tok.lower()
        if "=" not in tok:
            if low in ignored:
                return None
            if low == "not":
                if clause == "source": src_not = True
                elif clause == "destination": dst_not = True
                continue
            if low in actions:
                if action is not None:
                    return None
                action, clause = low, low
            elif low in clauses:
                clause = low
                if clause == "source": has_source = True
                elif clause == "destination": has_dest = True
                elif clause == "port": port_clause = {}
            continue

        key, val = tok.split("=", 1)
        k = key.lower()
        if clause == "rule":
            if k == "family": family = val.lower()
            elif k == "priority":
                try:
                    priority = int(val)
                except ValueError:
                    return None
        elif clause == "source":
            if k == "address": source_addr = val
            else: src_non_addr = True
        elif clause == "destination":
            if k == "address": dest_addr = val
            else: dst_non_addr = True
        elif clause == "port" and port_clause is not None:
            port_clause[k] = val
        elif clause == "service" and k == "name":
            service_name = val
        elif clause == "protocol" and k == "value":
            proto_val = val.lower()

    if action is None or (family is not None and family != "ipv4"):
        return None

    port_ok = (port_clause is not None and port_clause.get("protocol", "").lower() == "tcp"
               and port_in_spec(port_clause.get("port", ""), target_port))
    service_ok = target_port == 22 and service_name == "ssh"

    if action == "accept":
        if src_not or dst_not or src_non_addr or dst_non_addr:
            return None
        if not (port_ok or service_ok):
            return None
        if has_dest:
            dst_net = parse_ipv4_net(dest_addr)
            if dst_net is None or bridge_ip not in dst_net:
                return None
        if has_source:
            src_net = parse_ipv4_net(source_addr)
            if src_net is None or not subnet_net.subnet_of(src_net):
                return None
        return ("accept", priority)

    # drop / reject: treat as blocking if it matches (bridge, subnet, target_port).
    has_l4 = port_clause is not None or service_name is not None or proto_val is not None
    l4_matches = (not has_l4) or port_ok or service_ok or (proto_val == "tcp" and port_clause is None and service_name is None)
    if not l4_matches:
        return None
    if has_dest:
        if dst_non_addr:
            return None
        dst_net = parse_ipv4_net(dest_addr)
        if dst_net is None:
            return None
        if (bridge_ip in dst_net) == dst_not:
            return None
    if has_source:
        if src_non_addr:
            return None
        src_net = parse_ipv4_net(source_addr)
        if src_net is None:
            return None
        if src_not:
            if subnet_net.subnet_of(src_net):
                return None
        elif not subnet_net.overlaps(src_net):
            return None
    return ("block", priority)

for line in sys.stdin:
    if not line.strip():
        continue
    res = classify_rich_rule(line)
    if res is None:
        continue
    kind, prio = res
    (accept_prios if kind == "accept" else block_prios).append(prio)

if accept_prios and (not block_prios or min(accept_prios) < min(block_prios)):
    sys.exit(0)
sys.exit(1)
' "$bridge" "$subnet" "$target_port" "$target" "$ports" "$services" <<<"$rich_rules"
}

firewalld_rich_rule() {
  printf 'rule family="ipv4" source address="%s" destination address="%s/32" port port="%s" protocol="tcp" accept\n' \
    "$subnet" "$bridge" "$1"
}

firewalld_fix_hint() {
  local target_port="$1" label="$2"
  if [[ "$target_port" == "$relay_port" && "$label" == "Hub SSH relay" ]]; then
    printf 'sudo %s apply-relay --relay-port %s' "$0" "$relay_port"
  else
    printf 'sudo %s apply --hub-user %s --port %s --relay-port %s' "$0" "$hub_user" "$port" "$relay_port"
  fi
}

# Sets $FIREWALLD_RESOLVED_ZONE to the zone managing $NETWORK, or "" when already handled/reported.
# Must be called as a standalone statement (never inside if/||/&&) so set -e stays active.
firewalld_resolve_zone() {
  local mode="$1" target_port="$2" label="$3"
  local rt_zone perm_zone default_zone fix_hint
  FIREWALLD_RESOLVED_ZONE=""
  rt_zone="$(firewalld_interface_zone runtime)" || exit 1
  perm_zone="$(firewalld_interface_zone permanent)" || exit 1
  fix_hint="$(firewalld_fix_hint "$target_port" "$label")"

  if [[ -n "$rt_zone" && -n "$perm_zone" ]]; then
    if [[ "$rt_zone" == "$perm_zone" ]]; then
      FIREWALLD_RESOLVED_ZONE="$rt_zone"
      return 0
    fi
    if [[ "$mode" == ensure ]]; then
      fail "firewalld binds $NETWORK to conflicting zones: $rt_zone (runtime) vs $perm_zone (permanent); align them before re-running"
    fi
    problem "firewalld binds $NETWORK to zone $rt_zone (runtime) but $perm_zone (permanent) for $bridge:$target_port ($label); align them with firewall-cmd --zone=<zone> --change-interface=$NETWORK [--permanent]"
    return 0
  fi

  if [[ -n "$rt_zone" || -n "$perm_zone" ]]; then
    local zone="${rt_zone:-$perm_zone}"
    if [[ "$mode" == check ]]; then
      if [[ -n "$rt_zone" ]]; then
        problem "firewalld binds $NETWORK to zone $rt_zone only in runtime (missing in --permanent) for $bridge:$target_port ($label); run: $fix_hint"
      else
        problem "firewalld binds $NETWORK to zone $perm_zone only in --permanent (missing in runtime) for $bridge:$target_port ($label); run: $fix_hint"
      fi
      return 0
    fi
    if [[ -n "$rt_zone" ]]; then
      firewall-cmd --permanent --zone="$zone" --change-interface="$NETWORK" >/dev/null \
        || fail "failed to bind $NETWORK to firewalld zone $zone (--permanent)"
      ok "bound $NETWORK to firewalld zone $zone (--permanent)"
    else
      firewalld_bind_runtime "$zone"
      ok "bound $NETWORK to firewalld zone $zone (runtime)"
    fi
    FIREWALLD_RESOLVED_ZONE="$zone"
    return 0
  fi

  if firewalld_zone_exists runtime "$FIREWALLD_ZONE" || firewalld_zone_exists permanent "$FIREWALLD_ZONE"; then
    if [[ "$mode" == check ]]; then
      problem "firewalld zone $FIREWALLD_ZONE exists but $NETWORK is not bound to it ($bridge:$target_port, $label); run: $fix_hint (or firewall-cmd --zone=$FIREWALLD_ZONE --change-interface=$NETWORK [--permanent])"
      return 0
    fi
    firewall-cmd --permanent --zone="$FIREWALLD_ZONE" --change-interface="$NETWORK" >/dev/null \
      || fail "failed to bind $NETWORK to firewalld zone $FIREWALLD_ZONE (--permanent)"
    firewalld_bind_runtime "$FIREWALLD_ZONE"
    ok "bound $NETWORK to firewalld zone $FIREWALLD_ZONE (runtime and --permanent)"
    FIREWALLD_RESOLVED_ZONE="$FIREWALLD_ZONE"
    return 0
  fi

  default_zone="$(firewall-cmd --get-default-zone 2>/dev/null || true)"
  if [[ -n "$default_zone" ]] && firewalld_zone_allows_port runtime "$default_zone" "$target_port" \
      && firewalld_zone_allows_port permanent "$default_zone" "$target_port"; then
    ok "firewalld default zone $default_zone allows $bridge:$target_port ($label)"
    return 0
  fi
  if [[ "$mode" == check ]]; then
    problem "firewalld interface $NETWORK is not bound to a dedicated zone and default zone ${default_zone:-unknown} blocks $bridge:$target_port ($label); run deploy/lxd/setup.sh or create and bind zone $FIREWALLD_ZONE"
  else
    warn "firewalld interface $NETWORK is not bound to a dedicated zone and default zone ${default_zone:-unknown} blocks $bridge:$target_port ($label); run deploy/lxd/setup.sh or create zone $FIREWALLD_ZONE (firewall-cmd --permanent --new-zone=$FIREWALLD_ZONE && firewall-cmd --permanent --zone=$FIREWALLD_ZONE --set-target=DROP && firewall-cmd --permanent --zone=$FIREWALLD_ZONE --add-service=dhcp --add-service=dns && firewall-cmd --permanent --zone=$FIREWALLD_ZONE --change-interface=$NETWORK && firewall-cmd --reload)"
  fi
  return 0
}

firewalld_ensure_port() {
  local target_port="$1" label="$2" zone rule perm_ok=0 rt_ok=0
  firewalld_active || return 0
  firewalld_resolve_zone ensure "$target_port" "$label"
  [[ -n "$FIREWALLD_RESOLVED_ZONE" ]] || return 0
  zone="$FIREWALLD_RESOLVED_ZONE"

  if firewalld_zone_allows_port permanent "$zone" "$target_port"; then perm_ok=1; fi
  if firewalld_zone_allows_port runtime "$zone" "$target_port"; then rt_ok=1; fi
  if (( perm_ok && rt_ok )); then
    ok "firewalld zone $zone already allows $bridge:$target_port ($label)"
    return 0
  fi
  rule="$(firewalld_rich_rule "$target_port")"
  if (( !perm_ok )); then
    firewall-cmd --permanent --zone="$zone" --add-rich-rule="$rule" >/dev/null \
      || fail "failed to persist firewalld rule for $bridge:$target_port ($label) in zone $zone"
  fi
  if (( !rt_ok )); then
    firewall-cmd --zone="$zone" --add-rich-rule="$rule" >/dev/null \
      || fail "failed to add runtime firewalld rule for $bridge:$target_port ($label) in zone $zone"
  fi
  if (( !perm_ok && !rt_ok )); then
    ok "firewalld zone $zone allows $bridge:$target_port ($label) (runtime and --permanent)"
  elif (( !perm_ok )); then
    ok "firewalld zone $zone persisted $bridge:$target_port ($label) (--permanent)"
  else
    ok "firewalld zone $zone allows $bridge:$target_port ($label) (runtime)"
  fi
}

firewalld_check_port() {
  local target_port="$1" label="$2" zone fix_hint rt_ok=0 perm_ok=0
  firewalld_active || return 0
  firewalld_resolve_zone check "$target_port" "$label"
  [[ -n "$FIREWALLD_RESOLVED_ZONE" ]] || return 0
  zone="$FIREWALLD_RESOLVED_ZONE"
  fix_hint="$(firewalld_fix_hint "$target_port" "$label")"

  if firewalld_zone_allows_port runtime "$zone" "$target_port"; then rt_ok=1; fi
  if firewalld_zone_allows_port permanent "$zone" "$target_port"; then perm_ok=1; fi
  if (( rt_ok && perm_ok )); then
    ok "firewalld zone $zone allows $bridge:$target_port ($label)"
  elif (( !rt_ok )); then
    problem "firewalld zone $zone does not allow $bridge:$target_port ($label) in runtime (traffic will be blocked/time out); run: $fix_hint"
  else
    problem "firewalld zone $zone allows $bridge:$target_port ($label) in runtime but not in --permanent (will be lost after reload/reboot); run: $fix_hint"
  fi
}
