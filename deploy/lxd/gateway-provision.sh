# Runs inside the gateway VM as root, fed over stdin by gateway-vm.sh after gateway/acme-units.sh.
# Control-plane files arrive in /root/clinavat-gateway. Nothing starts here; the VM has no WAN address yet.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SOURCE=/root/clinavat-gateway
LIB=/usr/local/lib/clinavat-gw
ETC=/etc/clinavat-gw
VAR=/var/lib/clinavat-gw
ACME_USER=clinavat-acme

cloud-init status --wait >/dev/null 2>&1 || true
apt-get update -qq
apt-get install -y -qq --no-install-recommends acme.sh ca-certificates curl gnupg iproute2 nftables nginx openssh-server python3 >/dev/null
if ! dpkg -s sing-box >/dev/null 2>&1; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod 644 /etc/apt/keyrings/sagernet.asc
  cat >/etc/apt/sources.list.d/sagernet.sources <<'SOURCES'
Types: deb
URIs: https://deb.sagernet.org/
Suites: *
Components: *
Enabled: yes
Signed-By: /etc/apt/keyrings/sagernet.asc
SOURCES
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends sing-box >/dev/null
fi

install -d -m 755 "$LIB"
install -m 700 "$SOURCE/gwctl.py" "$LIB/gwctl.py"
install -m 755 "$SOURCE/gateway-rules.sh" /usr/local/bin/gateway-rules.sh
install -m 644 "$SOURCE/gateway-rules.service" /etc/systemd/system/gateway-rules.service
install -d -m 700 "$ETC" "$ETC/rendered" "$ETC/certs"
install -d -m 711 "$VAR"
id "$ACME_USER" >/dev/null 2>&1 || useradd --system --home-dir "$VAR/acme" --no-create-home --shell /usr/sbin/nologin "$ACME_USER"
write_acme_units "$VAR/acme" "$ACME_USER" "$LIB/gwctl.py"

# sing-box manages tun and routes, which the packaged unit's unprivileged user cannot do.
install -d -m 755 /etc/systemd/system/sing-box.service.d
printf '[Service]\nUser=root\nGroup=root\nDynamicUser=no\n' >/etc/systemd/system/sing-box.service.d/override.conf
rm -f /etc/nginx/sites-enabled/default
printf 'net.ipv4.ip_forward = 1\n' >/etc/sysctl.d/90-clinavat-gateway.conf

for package in cloud-init cloud-guest-utils netplan.io snapd unattended-upgrades; do
  if dpkg -s "$package" >/dev/null 2>&1; then apt-get purge -y -qq "$package" >/dev/null; fi
done
apt-get autoremove -y -qq --purge >/dev/null
rm -rf /etc/cloud /var/lib/cloud /var/lib/snapd /snap
systemctl enable --quiet systemd-networkd systemd-resolved ssh gateway-rules sing-box nginx clinavat-gw-acme.timer
systemctl mask --quiet systemd-networkd-wait-online.service apt-daily.timer apt-daily-upgrade.timer motd-news.timer 2>/dev/null || true
systemctl daemon-reload
