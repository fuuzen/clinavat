#!/bin/bash
# One-time CC-Pool gateway control plane installation. Run as root on the gateway from a
# directory containing this script, gwctl.py, gateway-rules.sh and gateway-rules.service.
#
#   ./install.sh --wan-ip 192.0.2.10 --site clinavat.example.com [--drop-direct 17.0.0.0/8] \
#                [--acme-dns dns_ali] [--hub-key 'ssh-ed25519 AAAA... cc-pool-hub']
#
# Every change is shown before it is applied; activation waits for confirmation and rolls
# back automatically after 90 seconds without it.
set -euo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LIB=/usr/local/lib/cc-pool-gw
GWCTL="$LIB/gwctl.py"
ETC=/etc/cc-pool-gw
VAR=/var/lib/cc-pool-gw
ACME_HOME="$VAR/acme"
BACKUP="$VAR/pre-install-$(date -u +%Y%m%dT%H%M%SZ)"
POOL_IP=10.10.10.10
ACME_USER=cc-pool-acme

wan_ip="" sites=() drop_direct=() acme_dns=dns_ali hub_key=""
while (($#)); do
  case "$1" in
    --wan-ip) wan_ip="$2"; shift 2 ;;
    --site) sites+=("$2"); shift 2 ;;
    --drop-direct) drop_direct+=("$2"); shift 2 ;;
    --acme-dns) acme_dns="$2"; shift 2 ;;
    --hub-key) hub_key="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
[[ -n "$wan_ip" ]] || { echo "--wan-ip is required" >&2; exit 64; }
for tool in python3 sing-box nft systemd-run curl; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]]
}

json_list() { python3 -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }

gw() {
  local output
  output="$("$GWCTL" "$@")" || { echo "$output" >&2; return 1; }
  echo "$output"
}

wait_confirm() {
  local result="$1" revision
  revision="$(python3 -I -c 'import json,sys; r=json.loads(sys.argv[1])["result"]; print(r.get("revision") or "")' "$result")"
  [[ -n "$revision" ]] || { echo "nothing changed"; return 0; }
  echo "$result" | python3 -I -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["result"]["health"], ensure_ascii=False, indent=1))'
  echo "Revision $revision is live and rolls back automatically within 90 seconds."
  echo "Verify from the pool machine now, e.g. curl -m5 https://cloudflare.com/cdn-cgi/trace"
  if confirm "Keep revision $revision?"; then
    gw confirm "$revision" >/dev/null
    echo "revision $revision confirmed"
  else
    gw rollback "$revision" >/dev/null
    echo "revision $revision rolled back"
    return 1
  fi
}

echo "== packages"
missing=()
command -v nginx >/dev/null || missing+=(nginx)
dpkg -s acme.sh >/dev/null 2>&1 || missing+=(acme.sh)
if ((${#missing[@]})); then
  confirm "Install ${missing[*]} with apt?" || exit 1
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
fi
# Ubuntu enables a default site on every address; the gateway serves only managed sites.
rm -f /etc/nginx/sites-enabled/default
systemctl enable nginx >/dev/null

echo "== files"
install -d -m 700 "$LIB" "$ETC" "$ETC/rendered" "$ETC/certs" "$VAR" "$ACME_HOME"
if [[ ! -f "$ETC/state.json" ]]; then
  # Only the hand-written configuration is worth keeping; later runs re-render managed files.
  install -d -m 700 "$BACKUP"
  cp -a /etc/sing-box/config.json "$BACKUP/"
  [[ -f /usr/local/bin/gateway-rules.sh ]] && cp -a /usr/local/bin/gateway-rules.sh "$BACKUP/"
  [[ -f /etc/systemd/system/gateway-rules.service ]] && cp -a /etc/systemd/system/gateway-rules.service "$BACKUP/"
  echo "backup: $BACKUP"
fi
install -m 700 "$SOURCE/gwctl.py" "$GWCTL"
# acme.sh runs unprivileged; sing-box excludes this uid from tun so DNS API calls leave directly.
id "$ACME_USER" >/dev/null 2>&1 || useradd --system --home-dir "$ACME_HOME" --no-create-home --shell /usr/sbin/nologin "$ACME_USER"
chmod 711 "$VAR"
chown -R "$ACME_USER:$ACME_USER" "$ACME_HOME"
chmod 700 "$ACME_HOME"
[[ -f "$ACME_HOME/account.conf" ]] && chmod 600 "$ACME_HOME/account.conf"

if [[ ! -f "$ETC/state.json" ]]; then
  echo "== import current sing-box config"
  args="$(python3 -I -c 'import json,sys; print(json.dumps({"wan_ip": sys.argv[1], "acme_dns": sys.argv[2], "sites": json.loads(sys.argv[3]), "drop_direct": json.loads(sys.argv[4])}))' \
    "$wan_ip" "$acme_dns" "$(json_list "${sites[@]}")" "$(json_list "${drop_direct[@]}")")"
  gw import "$args" | python3 -I -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["result"], ensure_ascii=False, indent=1))'
fi

if python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("forbidden_egress_ips") else 1)' "$ETC/infra.json"; then
  :
elif real_ip="$(curl -s -m8 --interface eth0 https://cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')" && [[ -n "$real_ip" ]]; then
  # Health checks reject any change whose proxied egress equals the gateway's own address.
  python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["forbidden_egress_ips"]=[sys.argv[2]]; open(p,"w").write(json.dumps(d, indent=2, ensure_ascii=False)+"\n")' "$ETC/infra.json" "$real_ip"
  echo "direct egress $real_ip added to forbidden_egress_ips"
fi

echo "== review"
gw render "{\"directory\": \"$VAR/review\"}" >/dev/null
diff -u /etc/sing-box/config.json "$VAR/review/sing-box" || true
echo "--- guard (replaces iptables POOL_DNAT / MASQUERADE)"
cat "$VAR/review/guard"
confirm "Apply this configuration?" || exit 1

echo "== activate"
install -m 755 "$SOURCE/gateway-rules.sh" /usr/local/bin/gateway-rules.sh
install -m 644 "$SOURCE/gateway-rules.service" /etc/systemd/system/gateway-rules.service
systemctl daemon-reload
result="$(gw activate)"
wait_confirm "$result"
# The confirmed guard owns DNAT and MASQUERADE now; restart drops the legacy iptables copies.
systemctl restart gateway-rules
systemctl enable gateway-rules >/dev/null

echo "== acme.sh"
hook="$(dpkg -L acme.sh | grep "/dnsapi/${acme_dns}.sh$" | head -1 || true)"
[[ -n "$hook" ]] || { echo "acme.sh has no DNS hook $acme_dns" >&2; exit 1; }
ln -sfn "$(dirname "$hook")" "$ACME_HOME/dnsapi"
chown -h "$ACME_USER:$ACME_USER" "$ACME_HOME/dnsapi"
cat >/etc/systemd/system/cc-pool-gw-acme.service <<EOF
[Unit]
Description=CC-Pool gateway certificate renewal

[Service]
Type=oneshot
User=$ACME_USER
Group=$ACME_USER
Environment=HOME=$ACME_HOME
ExecStart=/usr/bin/acme.sh --cron --home $ACME_HOME --config-home $ACME_HOME
# Root copies renewed certificates into the nginx tree and reloads it.
ExecStartPost=+$GWCTL certs.sync
EOF
cat >/etc/systemd/system/cc-pool-gw-acme.timer <<EOF
[Unit]
Description=Daily CC-Pool gateway certificate renewal

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now cc-pool-gw-acme.timer >/dev/null

if [[ "$acme_dns" == dns_ali ]] && ! grep -q '^SAVED_Ali_Key=' "$ACME_HOME/account.conf" 2>/dev/null; then
  # acme.sh stores the credentials in $ACME_HOME/account.conf on first use; they never leave the gateway.
  read -r -p "Aliyun AccessKey ID (DNS-only RAM user): " Ali_Key
  read -r -s -p "Aliyun AccessKey Secret: " Ali_Secret
  echo
  export Ali_Key Ali_Secret
fi
for site in "${sites[@]}"; do
  echo "== certificate $site"
  result="$(gw cert.issue "{\"domain\": \"$site\"}")"
  wait_confirm "$result"
done
unset Ali_Key Ali_Secret

if [[ -n "$hub_key" ]]; then
  echo "== hub key"
  [[ "$hub_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^\"]*)?$ ]] || { echo "invalid ed25519 public key" >&2; exit 1; }
  line="restrict,from=\"$POOL_IP\",command=\"CC_POOL_GW_REMOTE=1 $GWCTL\" $hub_key"
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  grep -qxF "$line" /root/.ssh/authorized_keys || echo "$line" >>/root/.ssh/authorized_keys
fi

echo "== done"
"$GWCTL" status | python3 -I -c 'import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=1))'
cat <<EOF

Remove every other key that lets the pool machine ($POOL_IP) log in as root:
  grep -n '' /root/.ssh/authorized_keys
Keep only the forced-command Hub key for $POOL_IP and use another machine for emergency access.
EOF
