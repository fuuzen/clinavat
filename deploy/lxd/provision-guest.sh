#!/bin/bash
# Runs inside the image builder as root, fed over stdin by build-image.sh. IMAGE_KIND is agent for the slot VM
# image with the CLIs, or workspace for the container that only synchronizes.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
# Exit status 2 means "finished with warnings"; the units cloud-init configures are removed below anyway.
if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null || [[ $? -eq 2 ]]; fi

apt-get update -qq
if [[ "$IMAGE_KIND" == workspace ]]; then
  # git serves the changes panel for local projects, so a repository's own configuration never runs on the host.
  apt-get install -y -qq --no-install-recommends bash ca-certificates curl git iproute2 openssh-client procps python3 \
    tzdata util-linux >/dev/null
else
  apt-get install -y -qq --no-install-recommends bash bubblewrap ca-certificates curl git iproute2 less \
    openssh-client procps python3 ripgrep tzdata util-linux xz-utils >/dev/null
fi

architecture="$(dpkg --print-architecture)"
case "$architecture" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac

work="$(mktemp -d)"
cd "$work"
if [[ "$IMAGE_KIND" != workspace ]]; then
asset="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
base="https://nodejs.org/dist/v${NODE_VERSION}"
curl -fsSLO "$base/$asset"
curl -fsSLO "$base/SHASUMS256.txt"
grep " $asset\$" SHASUMS256.txt | sha256sum -c - >/dev/null
tar -xJf "$asset" -C /usr/local --strip-components=1 --no-same-owner

npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" >/dev/null
npm cache clean --force >/dev/null 2>&1
fi

asset="mutagen_linux_${architecture}_v${MUTAGEN_VERSION}.tar.gz"
base="https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}"
curl -fsSLO "$base/$asset"
curl -fsSLO "$base/SHA256SUMS"
grep " $asset\$" SHA256SUMS | sha256sum -c - >/dev/null
tar -xzf "$asset" -C /usr/local/bin --no-same-owner mutagen mutagen-agents.tar.gz
cd /
rm -rf "$work"

# The default cloud image user has sudo; agents must not be able to reach guest root.
if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu 2>/dev/null || userdel ubuntu; fi
groupdel ubuntu 2>/dev/null || true
groupadd -g "$HUB_GID" clinavat
# raw.idmap preserves the Hub's uid/gid through a VM's virtiofs and a container's bind mounts.
useradd -u "$HUB_UID" -g "$HUB_GID" -m -s /bin/bash clinavat
passwd -l root >/dev/null

for package in apport cloud-init cloud-guest-utils cloud-initramfs-copymods netplan.io snapd sudo unattended-upgrades; do
  # sudo refuses removal while root has no password unless this is set.
  if dpkg -s "$package" >/dev/null 2>&1; then SUDO_FORCE_REMOVE=yes apt-get purge -y -qq "$package"; fi
done
apt-get autoremove -y -qq --purge
rm -rf /etc/cloud /var/lib/cloud /etc/sudoers.d /etc/netplan /run/systemd/network/*netplan* /var/lib/snapd /snap

# Instances have new MAC addresses, so match by interface name: en* in a VM, eth* in a container.
cat >/etc/systemd/network/10-clinavat.network <<'NETWORK'
[Match]
Name=en* eth*

[Network]
DHCP=ipv4

[DHCPv4]
ClientIdentifier=mac
NETWORK
systemctl enable --quiet systemd-networkd.service systemd-resolved.service

# Agents run as one unprivileged user with no way to change identity, which narrows the path to guest root.
find / -xdev -type f -perm /6000 -exec chmod ug-s {} +

# Codex sandboxes commands with bubblewrap; the VM, not this restriction, is the isolation boundary.
# A container shares the host kernel and has no Codex, so it keeps the host's setting.
if [[ "$IMAGE_KIND" != workspace ]]; then
  printf 'kernel.apparmor_restrict_unprivileged_userns = 0\n' >/etc/sysctl.d/90-clinavat.conf
fi

# Faster boots: nothing here waits for the network or does background maintenance.
systemctl mask --quiet systemd-networkd-wait-online.service apt-daily.timer apt-daily-upgrade.timer \
  motd-news.timer man-db.timer e2scrub_all.timer fstrim.timer 2>/dev/null || true
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' >/etc/systemd/journald.conf.d/clinavat.conf

apt-get clean
rm -rf /var/lib/apt/lists/* /var/log/journal/* /root/.npm /root/.cache /tmp/* /var/tmp/*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
if [[ "$IMAGE_KIND" != workspace ]]; then fstrim -a >/dev/null 2>&1 || true; fi
