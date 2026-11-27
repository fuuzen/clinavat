#!/bin/bash
# Shared firewalld zone and port helpers sourced by deploy/lxd/setup.sh and deploy/lxd/host-commands.sh.
# Expects $NETWORK (and for port checks/writes: $bridge, $subnet, $port, $relay_port, $hub_user).

FIREWALLD_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FIREWALLD_ZONE=cv-users
FIREWALLD_RESOLVED_ZONE=""
FIREWALLD_RESOLVED_EXTERNAL_ZONE=""

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

firewalld_zone_allows_tcp() {
  local scope="$1" zone="$2" target_port="$3" bridge_arg="${4:-}" source_arg="${5:-}"
  local -a scope_args=()
  [[ "$scope" == permanent ]] && scope_args=(--permanent)
  local target ports services rich_rules
  target="$(firewalld_zone_target "$scope" "$zone")" || return 1
  ports="$(firewall-cmd "${scope_args[@]}" --zone="$zone" --list-ports 2>/dev/null)" || return 1
  services="$(firewall-cmd "${scope_args[@]}" --zone="$zone" --list-services 2>/dev/null)" || return 1
  rich_rules="$(firewall-cmd "${scope_args[@]}" --zone="$zone" --list-rich-rules 2>/dev/null)" || return 1
  python3 -I "$FIREWALLD_DIR/firewalld-port-eval.py" \
    "$bridge_arg" "$source_arg" "$target_port" "$target" "$ports" "$services" <<<"$rich_rules"
}

firewalld_zone_allows_port() { firewalld_zone_allows_tcp "$1" "$2" "$3" "$bridge" "$subnet"; }
firewalld_zone_allows_external_port() { firewalld_zone_allows_tcp "$1" "$2" "$3" "" "${4:-}"; }

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

firewalld_normalize_cidr() {
  python3 -I -c '
import ipaddress, sys
net = ipaddress.ip_network(sys.argv[1], strict=True)
print(f"ipv{net.version}", net)' "$1" 2>/dev/null
}

firewalld_external_fix_hint() {
  local cmd="sudo $0 apply-client-ssh --client-ssh-port $1"
  [[ -n "${2:-}" ]] && cmd+=" --zone $2"
  [[ -n "${3:-}" ]] && cmd+=" --source $3"
  printf '%s' "$cmd"
}

firewalld_detect_vm_subnet() {
  local raw=""
  if [[ -n "${subnet:-}" ]]; then
    raw="$subnet"
  elif command -v ip >/dev/null 2>&1; then
    raw="$(ip -o -4 addr show dev "$NETWORK" 2>/dev/null | awk '{print $4; exit}' || true)"
  fi
  if [[ -z "$raw" ]] && (declare -F lxc >/dev/null 2>&1 || [[ -x /snap/bin/lxc ]]); then
    raw="$(lxc network get "$NETWORK" ipv4.address 2>/dev/null || /snap/bin/lxc network get "$NETWORK" ipv4.address </dev/null 2>/dev/null || true)"
  fi
  [[ -n "$raw" && "$raw" != "none" ]] || return 0
  python3 -I -c '
import ipaddress, sys
print(ipaddress.ip_interface(sys.argv[1].strip()).network)' "$raw" 2>/dev/null || true
}

firewalld_zone_matches_vm_subnet() {
  local zone="$1" vm_subnet="${2:-}" rt_src perm_src
  [[ -n "$vm_subnet" ]] || return 1
  rt_src="$(firewall-cmd --zone="$zone" --list-sources 2>/dev/null || true)"
  perm_src="$(firewall-cmd --permanent --zone="$zone" --list-sources 2>/dev/null || true)"
  [[ -n "$rt_src$perm_src" ]] || return 1
  python3 -I -c '
import ipaddress, sys
vm = ipaddress.ip_network(sys.argv[1], strict=False)
for tok in sys.argv[2].split():
    try:
        net = ipaddress.ip_network(tok, strict=False)
    except ValueError:
        continue
    if net.version == vm.version and vm.overlaps(net):
        sys.exit(0)
sys.exit(1)' "$vm_subnet" "$rt_src $perm_src"
}

firewalld_is_vm_zone() {
  local zone="$1" rt_vm="$2" perm_vm="$3" unbound_default="${4:-}" vm_subnet="${5:-}"
  if [[ "$zone" == "$FIREWALLD_ZONE" || ( -n "$rt_vm" && "$zone" == "$rt_vm" ) || ( -n "$perm_vm" && "$zone" == "$perm_vm" ) || ( -n "$unbound_default" && "$zone" == "$unbound_default" ) ]]; then
    return 0
  fi
  firewalld_zone_matches_vm_subnet "$zone" "$vm_subnet"
}

# Sets $FIREWALLD_RESOLVED_EXTERNAL_ZONE to the external/LAN zone, or "" when check already reported a problem.
# Refuses VM isolation zones (cv-users / $NETWORK / unbound default zone / VM source zones) and never calls --reload.
firewalld_resolve_external_zone() {
  local mode="$1" target_port="$2" label="$3" requested="${4:-}"
  local rt_vm perm_vm default_zone vm_subnet unbound_default="" active_out z msg=""
  local -a external_candidates=() other_cv_zones=()
  FIREWALLD_RESOLVED_EXTERNAL_ZONE=""
  rt_vm="$(firewalld_interface_zone runtime)" || exit 1
  perm_vm="$(firewalld_interface_zone permanent)" || exit 1
  default_zone="$(firewall-cmd --get-default-zone 2>/dev/null || true)"
  vm_subnet="$(firewalld_detect_vm_subnet)"

  if [[ -z "$rt_vm" || -z "$perm_vm" ]] && [[ -n "$default_zone" ]]; then
    if [[ -e "/sys/class/net/$NETWORK" || -n "$vm_subnet" ]] \
        || firewalld_zone_exists runtime "$FIREWALLD_ZONE" \
        || firewalld_zone_exists permanent "$FIREWALLD_ZONE"; then
      unbound_default="$default_zone"
    fi
  fi

  if [[ -n "$requested" ]]; then
    if [[ -n "$unbound_default" && "$requested" == "$unbound_default" ]]; then
      msg="refusing to expose $label (tcp/$target_port) on default zone $requested: $NETWORK is not bound to $FIREWALLD_ZONE in both runtime and --permanent, so VM traffic falls into $requested; run deploy/lxd/setup.sh or deploy/lxd/host-commands.sh apply first"
    elif firewalld_is_vm_zone "$requested" "$rt_vm" "$perm_vm" "$unbound_default" "$vm_subnet"; then
      msg="refusing to expose $label (tcp/$target_port) on VM isolation zone $requested ($FIREWALLD_ZONE / $NETWORK must stay isolated)"
    elif ! firewalld_zone_exists runtime "$requested" || ! firewalld_zone_exists permanent "$requested"; then
      msg="firewalld zone $requested must exist in both runtime and --permanent for $label (tcp/$target_port)"
    else
      FIREWALLD_RESOLVED_EXTERNAL_ZONE="$requested"
      return 0
    fi
  else
    active_out="$(firewall-cmd --get-active-zones 2>/dev/null || true)"
    while IFS= read -r z; do
      [[ -n "$z" ]] || continue
      firewalld_is_vm_zone "$z" "$rt_vm" "$perm_vm" "$unbound_default" "$vm_subnet" && continue
      if [[ "$z" == cv-* ]]; then other_cv_zones+=("$z"); else external_candidates+=("$z"); fi
    done < <(awk '!/^[[:space:]]/ && NF { print $1 }' <<<"$active_out")

    if (( ${#external_candidates[@]} == 1 && ${#other_cv_zones[@]} == 0 )); then
      z="${external_candidates[0]}"
      if firewalld_zone_exists runtime "$z" && firewalld_zone_exists permanent "$z"; then
        FIREWALLD_RESOLVED_EXTERNAL_ZONE="$z"
        return 0
      fi
      msg="detected firewalld zone $z is not present in both runtime and --permanent; specify --zone <zone>"
    elif (( ${#external_candidates[@]} + ${#other_cv_zones[@]} > 1 )); then
      msg="multiple active non-VM firewalld zones found (${other_cv_zones[*]}${other_cv_zones[*]:+${external_candidates[*]:+ }}${external_candidates[*]}); specify --zone <zone> (never $FIREWALLD_ZONE)"
    elif (( ${#other_cv_zones[@]} == 1 )); then
      msg="no active non-cv-* firewalld zone found (active non-VM zone: ${other_cv_zones[0]}); re-run with --zone ${other_cv_zones[0]}"
    elif [[ -n "$unbound_default" ]]; then
      msg="$NETWORK is not bound to $FIREWALLD_ZONE in both runtime and --permanent, so default zone $unbound_default may carry VM traffic; bind $NETWORK to $FIREWALLD_ZONE via deploy/lxd/setup.sh or deploy/lxd/host-commands.sh apply, or specify a dedicated external --zone <zone>"
    else
      if [[ -n "$default_zone" && "$default_zone" != cv-* ]] && ! firewalld_is_vm_zone "$default_zone" "$rt_vm" "$perm_vm" "$unbound_default" "$vm_subnet"; then
        msg="no active non-cv-* firewalld zone found (default zone is $default_zone); re-run explicitly with --zone $default_zone"
      else
        msg="no active external firewalld zone found; re-run with --zone <zone>"
      fi
    fi
  fi
  if [[ "$mode" == ensure ]]; then fail "$msg"; else problem "$msg"; fi
}

firewalld_ensure_external_port() {
  local target_port="$1" label="$2" requested="${3:-}" source_cidr="${4:-}"
  local raw_source="" family="" zone desc rule perm_ok=0 rt_ok=0
  if ! firewalld_active; then
    ok "firewalld is not active; skipping firewalld rule for tcp/$target_port ($label)"
    return 0
  fi
  if [[ -n "$source_cidr" ]]; then
    raw_source="$source_cidr"
    read -r family source_cidr < <(firewalld_normalize_cidr "$raw_source") || fail "invalid --source CIDR: $raw_source"
  fi
  firewalld_resolve_external_zone ensure "$target_port" "$label" "$requested"
  zone="$FIREWALLD_RESOLVED_EXTERNAL_ZONE"
  desc="tcp/$target_port${source_cidr:+ from $source_cidr}"

  firewalld_zone_allows_external_port permanent "$zone" "$target_port" "$source_cidr" && perm_ok=1
  firewalld_zone_allows_external_port runtime "$zone" "$target_port" "$source_cidr" && rt_ok=1
  if (( perm_ok && rt_ok )); then
    ok "firewalld zone $zone already allows $desc ($label)"
    return 0
  fi
  local -a add_args=(--add-port="${target_port}/tcp")
  if [[ -n "$source_cidr" ]]; then
    rule="rule family=\"$family\" source address=\"$source_cidr\" port port=\"$target_port\" protocol=\"tcp\" accept"
    add_args=(--add-rich-rule="$rule")
  fi
  if (( !perm_ok )); then
    firewall-cmd --permanent --zone="$zone" "${add_args[@]}" >/dev/null \
      || fail "failed to persist firewalld rule for $desc ($label) in zone $zone"
  fi
  if (( !rt_ok )); then
    firewall-cmd --zone="$zone" "${add_args[@]}" >/dev/null \
      || fail "failed to add runtime firewalld rule for $desc ($label) in zone $zone"
  fi
  if (( !perm_ok && !rt_ok )); then ok "firewalld zone $zone allows $desc ($label) (runtime and --permanent)"
  elif (( !perm_ok )); then ok "firewalld zone $zone persisted $desc ($label) (--permanent)"
  else ok "firewalld zone $zone allows $desc ($label) (runtime)"; fi
}

firewalld_check_external_port() {
  local target_port="$1" label="$2" requested="${3:-}" source_cidr="${4:-}"
  local raw_source="" family="" zone desc fix_hint rt_ok=0 perm_ok=0
  if ! firewalld_active; then
    ok "firewalld is not active; skipping firewalld check for tcp/$target_port ($label)"
    return 0
  fi
  if [[ -n "$source_cidr" ]]; then
    raw_source="$source_cidr"
    read -r family source_cidr < <(firewalld_normalize_cidr "$raw_source") || { problem "invalid --source CIDR: $raw_source"; return 0; }
  fi
  firewalld_resolve_external_zone check "$target_port" "$label" "$requested"
  [[ -n "$FIREWALLD_RESOLVED_EXTERNAL_ZONE" ]] || return 0
  zone="$FIREWALLD_RESOLVED_EXTERNAL_ZONE"
  desc="tcp/$target_port${source_cidr:+ from $source_cidr}"
  fix_hint="$(firewalld_external_fix_hint "$target_port" "$zone" "$source_cidr")"

  firewalld_zone_allows_external_port runtime "$zone" "$target_port" "$source_cidr" && rt_ok=1
  firewalld_zone_allows_external_port permanent "$zone" "$target_port" "$source_cidr" && perm_ok=1
  if (( rt_ok && perm_ok )); then ok "firewalld zone $zone allows $desc ($label)"
  elif (( !rt_ok )); then problem "firewalld zone $zone does not allow $desc ($label) in runtime; run: $fix_hint"
  else problem "firewalld zone $zone allows $desc ($label) in runtime but not in --permanent; run: $fix_hint"; fi
}
