# Sourced by install.sh and by the gateway VM provisioning: write_acme_units <acme home> <acme user> <gwctl path>
write_acme_units() {
  cat >/etc/systemd/system/clinavat-gw-acme.service <<UNIT
[Unit]
Description=Clinavat gateway certificate renewal

[Service]
Type=oneshot
User=$2
Group=$2
Environment=HOME=$1
ExecStart=/usr/bin/acme.sh --cron --home $1 --config-home $1
# Root copies renewed certificates into the nginx tree and reloads it.
ExecStartPost=+$3 certs.sync
UNIT
  cat >/etc/systemd/system/clinavat-gw-acme.timer <<UNIT
[Unit]
Description=Daily Clinavat gateway certificate renewal

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}
