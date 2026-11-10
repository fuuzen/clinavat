#!/bin/bash
# One-time LXD preparation for Clinavat's VM execution host. Run as root, for example:
#
#   sudo deploy/lxd/setup.sh --storage lvm:ubuntu-vg/clinavat-thin --hub-user clinavat \
#     --data-dir /srv/clinavat/data --workspace-dir /var/tmp/clinavat-workspace \
#     --allow 172.16.0.10/32:tcp:22 --allow 172.16.0.11/32:tcp:2222
#
# --storage   lvm:<vg>/<existing thin pool> or dir:<directory> for the LXD storage pool
# --allow     private development-host endpoints the VMs may reach (public addresses are always allowed); this
#             host's own sshd is opened by host-commands.sh, which this script runs
# --max-vms   project quota for slot VMs, default 8. Memory and CPU quotas are sized from it and from this
#             machine: 75% of RAM, and two vCPUs per VM since vCPUs can be shared.
# --max-users project quota for workspace containers (one per user with projects), default 32
# --local-root directory the administrator's local projects live in; repeatable. It is mounted whole into slot
#             machines, so it must not contain the data directory, the environment file or LXD's client key.
#
# The script locks the LXD socket to root, then creates a storage pool, an isolated bridge, an
# egress ACL, a restricted project and a restricted client token for the Hub. Local projects run their shell
# commands on this host, so it also lets the VMs log in to sshd as the Hub user, with keys only.
set -euo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

POOL=clinavat
NETWORK=clinavat-users
ACL=clinavat-egress
PROJECT=clinavat
BRIDGE_ADDRESS=10.31.0.1
BRIDGE_SUBNET=24
ADMIN_GROUP=lxd-admin
LISTEN=127.0.0.1:8443

storage="" hub_user="" data_dir="" workspace_dir="" allows=() max_vms=8 max_users=32 local_roots=()
while (($#)); do
  case "$1" in
    --storage) storage="$2"; shift 2 ;;
    --hub-user) hub_user="$2"; shift 2 ;;
    --data-dir) data_dir="$2"; shift 2 ;;
    --workspace-dir) workspace_dir="$2"; shift 2 ;;
    --allow) allows+=("$2"); shift 2 ;;
    --max-vms) max_vms="$2"; shift 2 ;;
    --max-users) max_users="$2"; shift 2 ;;
    --local-root) local_roots+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ -n "$storage" && -n "$hub_user" && -n "$data_dir" && -n "$workspace_dir" ]] || { echo "missing required arguments" >&2; exit 64; }
id "$hub_user" >/dev/null
for directory in "$data_dir/users" "$data_dir/slots" "$workspace_dir"; do
  [[ -d "$directory" && ! -L "$directory" ]] || { echo "not a real directory: $directory" >&2; exit 1; }
done
hub_uid="$(id -u "$hub_user")"
hub_gid="$(id -g "$hub_user")"
runtime_keys="/run/user/$hub_uid/clinavat/keys"
usage_probes="/run/user/$hub_uid/clinavat/usage-probes"
lxc() { /snap/bin/lxc "$@"; }
exists() { lxc "$@" >/dev/null 2>&1; }

echo "== Restrict the LXD socket to root and $ADMIN_GROUP"
# Membership in the socket group is root-equivalent; agent commands run as the Hub user on this host.
groupadd -f "$ADMIN_GROUP"
if id -nG "$hub_user" | tr ' ' '\n' | grep -qx lxd; then gpasswd -d "$hub_user" lxd; fi
# The per-user socket auto-provisions a project and storage pool for any member, so it is closed as well.
# Running processes keep their old groups until they restart; only changing the socket groups cuts them off.
snap set lxd daemon.group="$ADMIN_GROUP" daemon.user.group="$ADMIN_GROUP"
snap restart lxd
/snap/bin/lxd waitready --timeout 120
for socket in /var/snap/lxd/common/lxd/unix.socket /var/snap/lxd/common/lxd-user/unix.socket; do
  read -r socket_group socket_mode < <(stat -c '%G %a' "$socket")
  # The snap may leave the per-user socket root-owned, which is stricter than the admin group.
  [[ "$socket_group" == "$ADMIN_GROUP" || "$socket_group" == root ]] && [[ "$socket_mode" =~ ^[0-7][0-7]0$ ]] \
    || { echo "$socket is still reachable: group $socket_group, mode $socket_mode" >&2; exit 1; }
done
# A refresh restarts LXD; update deliberately during maintenance instead.
snap refresh --hold lxd

echo "== Storage pool $POOL"
if ! exists storage show "$POOL"; then
  case "$storage" in
    lvm:*/*) volume_group="${storage#lvm:}"; thin_pool="${volume_group#*/}"; volume_group="${volume_group%%/*}"
      lvs "$volume_group/$thin_pool" >/dev/null
      # The volume group also holds the root filesystem; LXD only touches its own volumes in the thin pool.
      lxc storage create "$POOL" lvm source="$volume_group" lvm.thinpool_name="$thin_pool" lvm.vg.force_reuse=true ;;
    dir:/*) directory="${storage#dir:}"; mkdir -p -m 711 "$directory"
      lxc storage create "$POOL" dir source="$directory" ;;
    *) echo "--storage must be lvm:<vg>/<thin pool> or dir:<absolute path>" >&2; exit 64 ;;
  esac
fi

echo "== Bridge $NETWORK"
# Translated until the gateway knows this network; deploy/lxd/egress-bindings.sh then hands VM addresses through.
exists network show "$NETWORK" || lxc network create "$NETWORK" \
  ipv4.address="$BRIDGE_ADDRESS/$BRIDGE_SUBNET" ipv4.nat=true ipv6.address=none dns.mode=managed

echo "== Egress ACL $ACL"
# Allow rules only, with default reject: public internet, the bridge's DHCP/DNS, and listed dev hosts.
exists network acl show "$ACL" || lxc network acl create "$ACL"
public="$(python3 -I -c '
import ipaddress
blocked = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
           "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"]
ranges = [ipaddress.ip_network("0.0.0.0/0")]
for item in map(ipaddress.ip_network, blocked):
    ranges = [part for network in ranges for part in (network.address_exclude(item) if item.subnet_of(network) else [network])
              if not part.subnet_of(item)]
print(",".join(str(network) for network in ipaddress.collapse_addresses(ranges)))
')"
rules="$(mktemp)"
trap 'rm -f "$rules"' EXIT
{
  echo "egress:"
  echo "- {action: allow, destination: \"$public\", state: enabled}"
  echo "- {action: allow, destination: \"$BRIDGE_ADDRESS/32\", protocol: udp, destination_port: \"53,67\", state: enabled}"
  echo "- {action: allow, destination: \"$BRIDGE_ADDRESS/32\", protocol: tcp, destination_port: \"53\", state: enabled}"
  echo "- {action: allow, destination: \"255.255.255.255/32\", protocol: udp, destination_port: \"67\", state: enabled}"
  for allow in "${allows[@]}"; do
    IFS=: read -r cidr protocol port <<<"$allow"
    [[ -n "$cidr" && "$protocol" =~ ^(tcp|udp)$ && "$port" =~ ^[0-9]+$ ]] || { echo "invalid --allow $allow" >&2; exit 64; }
    echo "- {action: allow, destination: \"$cidr\", protocol: $protocol, destination_port: \"$port\", state: enabled}"
  done
  echo "ingress: []"
} >"$rules"
lxc network acl edit "$ACL" <"$rules"
lxc network set "$NETWORK" security.acls="$ACL" \
  security.acls.default.egress.action=reject security.acls.default.ingress.action=reject

echo "== Restricted project $PROJECT"
exists project show "$PROJECT" || lxc project create "$PROJECT" \
  -c features.images=true -c features.profiles=true -c features.storage.volumes=true -c features.networks=false
lxc project set "$PROJECT" \
  restricted=true \
  restricted.networks.access="$NETWORK" \
  restricted.devices.nic=managed \
  restricted.devices.disk=allow \
  restricted.devices.disk.paths="$(IFS=,; echo "$data_dir/users,$data_dir/slots,$workspace_dir,$runtime_keys,$usage_probes${local_roots[*]:+,${local_roots[*]}}")" \
  restricted.idmap.uid="$hub_uid" \
  restricted.idmap.gid="$hub_gid" \
  restricted.devices.proxy=block \
  restricted.devices.gpu=block \
  restricted.devices.pci=block \
  restricted.devices.usb=block \
  restricted.devices.unix-char=block \
  restricted.devices.unix-block=block \
  restricted.devices.unix-hotplug=block \
  restricted.devices.infiniband=block \
  restricted.virtual-machines.lowlevel=block \
  restricted.snapshots=block \
  restricted.backups=block \
  restricted.containers.privilege=isolated \
  limits.containers="$max_users" \
  limits.virtual-machines="$max_vms" \
  limits.cpu="$((max_vms * 2))" \
  limits.memory="$(awk '/^MemTotal:/ { print int($2 * 3 / 4 / 1024) }' /proc/meminfo)MiB"
lxc profile set default --project "$PROJECT" limits.cpu=2 limits.memory=1536MiB limits.max_bus_ports=32
exists profile device get default root pool --project "$PROJECT" || \
  lxc profile device add default root disk --project "$PROJECT" pool="$POOL" path=/ size=8GiB
exists profile device get default eth0 network --project "$PROJECT" || \
  lxc profile device add default eth0 nic --project "$PROJECT" network="$NETWORK" name=eth0 \
    security.port_isolation=true security.mac_filtering=true security.ipv4_filtering=true
# Workspace containers only synchronize; the default profile's bus ports apply to VMs only.
exists profile show workspace --project "$PROJECT" || lxc profile create workspace --project "$PROJECT"
lxc profile set workspace --project "$PROJECT" limits.cpu=1 limits.memory=512MiB limits.processes=2000 security.idmap.isolated=true
exists profile device get workspace root pool --project "$PROJECT" || \
  lxc profile device add workspace root disk --project "$PROJECT" pool="$POOL" path=/ size=4GiB
exists profile device get workspace eth0 network --project "$PROJECT" || \
  lxc profile device add workspace eth0 nic --project "$PROJECT" network="$NETWORK" name=eth0 \
    security.port_isolation=true security.mac_filtering=true security.ipv4_filtering=true

# After the ACL: editing it above replaces every rule, including the one for this host's sshd.
echo "== Host commands"
"$SOURCE/host-commands.sh" apply --hub-user "$hub_user"

echo "== Hub client"
lxc config set core.https_address "$LISTEN"
token="$(lxc config trust add --name clinavat-hub --restricted --projects "$PROJECT" --quiet)"
cat <<EOF

LXD is ready. As $hub_user (not root), register the Hub client within the token's lifetime:

  lxc remote add clinavat-host https://$LISTEN --token '$token'
  lxc project list clinavat-host:

The snap's lxc always keeps this client certificate in ~/snap/lxd/common/config; back it up with the data directory.

Use "sudo lxc ..." or membership in $ADMIN_GROUP for administration from now on.
EOF
