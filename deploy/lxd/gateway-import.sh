# Runs inside the gateway VM as root, fed over stdin by gateway-vm.sh. Applies the old gateway's files from
# /root/gateway-import under this deployment's names. Safe to repeat: the last run before the switch wins.
# $1 WAN MAC, $2 LAN MAC
set -euo pipefail
IMPORT=/root/gateway-import
ETC=/etc/clinavat-gw
VAR=/var/lib/clinavat-gw
ACME_USER=clinavat-acme
OLD=cc-pool-gw

install -m 600 "$IMPORT/etc/$OLD/infra.json" "$ETC/infra.json"
install -m 600 "$IMPORT/etc/$OLD/state.json" "$ETC/state.json"
rm -rf "$ETC/certs"
cp -a "$IMPORT/etc/$OLD/certs" "$ETC/certs"
cp -a "$IMPORT/var/lib/$OLD/audit.jsonl" "$VAR/audit.jsonl" 2>/dev/null || true
rm -rf "$VAR/acme"
cp -a "$IMPORT/var/lib/$OLD/acme" "$VAR/acme"
hook="$(dpkg -L acme.sh | grep '/dnsapi/dns_ali.sh$' | head -1)"
ln -sfn "$(dirname "$hook")" "$VAR/acme/dnsapi"
chown -R "$ACME_USER:$ACME_USER" "$VAR/acme"
chown -h "$ACME_USER:$ACME_USER" "$VAR/acme/dnsapi"
chmod 700 "$VAR/acme"

# The Hub pins the host key, and its forced command has to point at the renamed controller.
install -d -m 700 /root/.ssh
# The Hub's key may only ever run the controller, whatever form it arrives in.
pool_ip="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["pool_ip"])' "$ETC/infra.json")"
sed -E -e 's#CC_POOL_GW_REMOTE=1#CLINAVAT_GW_REMOTE=1#' -e 's#/usr/local/lib/cc-pool-gw/#/usr/local/lib/clinavat-gw/#' \
  -e "s#^(ssh-ed25519 [^ ]+ clinavat-gateway)\$#restrict,from=\"$pool_ip\",command=\"CLINAVAT_GW_REMOTE=1 /usr/local/lib/clinavat-gw/gwctl.py\" \\1#" \
  "$IMPORT/root/.ssh/authorized_keys" >/root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
cp -a "$IMPORT"/etc/ssh/ssh_host_* /etc/ssh/

# Same addresses and MACs as the old gateway, so nothing upstream or on the pool side has to change. The names must
# not be eth0 or eth1: the kernel hands those out in probe order, and swapping them fails and crosses the configs,
# which would also invert the guard's rules.
rm -f /etc/systemd/network/*
printf '[Match]\nMACAddress=%s\n\n[Link]\nName=wan0\n' "$1" >/etc/systemd/network/10-wan0.link
printf '[Match]\nMACAddress=%s\n\n[Link]\nName=lan0\n' "$2" >/etc/systemd/network/10-lan0.link
sed -e 's/^Name = eth0/Name = wan0/' -e '/autoconfigured by PVE/d' "$IMPORT/etc/systemd/network/eth0.network" >/etc/systemd/network/wan0.network
sed -e 's/^Name = eth1/Name = lan0/' -e '/autoconfigured by PVE/d' "$IMPORT/etc/systemd/network/eth1.network" >/etc/systemd/network/lan0.network
printf 'LAN_IF=lan0\nWAN_IF=wan0\n' >"$ETC/interfaces"
python3 -I -c '
import json,sys
path=sys.argv[1]; infra=json.load(open(path)); infra.update(wan_if="wan0", lan_if="lan0")
open(path,"w").write(json.dumps(infra,indent=2,ensure_ascii=False)+"\n")' "$ETC/infra.json"
nameservers="$(awk '/^nameserver/ { print $2 }' "$IMPORT/etc/resolv.conf" | paste -sd' ')"
if [[ -n "$nameservers" ]]; then
  sed -i "/^\[Network\]/a DNS = $nameservers" /etc/systemd/network/wan0.network
fi
rm -rf "$IMPORT"
