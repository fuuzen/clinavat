#!/bin/bash
# Builds the execution images through the Hub's restricted LXD client; needs no root.
#
#   deploy/lxd/build-image.sh [--kind agent|workspace] [--remote clinavat-host] [--project clinavat] [--alias <alias>]
#                             [--address 10.31.0.9]
#
# agent (default) is the slot VM image with the CLIs, published as clinavat-agent; workspace is the container
# image that only runs synchronization, published as clinavat-workspace. The builder uses a fixed address, which
# the gateway must have bound once the VM network is no longer translated (admin panel: 网关 → 出口绑定 → 镜像构建).
#
# Publishing is slow; to run the steps separately, pass the same --builder with --stage provision
# and then --stage publish. The builder VM is removed after a successful publish.
#
# Tool versions come from the environment (CLAUDE_CODE_VERSION, CODEX_VERSION, MUTAGEN_VERSION,
# NODE_VERSION) and default to the values below. The guest user takes the current uid and gid,
# because virtiofs only maps the Hub's identity to the host.
set -euo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
remote=clinavat-host project=clinavat alias="" base=ubuntu-minimal:24.04 kind=agent address=10.31.0.9
builder="clinavat-image-build-$$" stage=all
while (($#)); do
  case "$1" in
    --kind) kind="$2"; shift 2 ;;
    --address) address="$2"; shift 2 ;;
    --remote) remote="$2"; shift 2 ;;
    --project) project="$2"; shift 2 ;;
    --alias) alias="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --builder) builder="$2"; shift 2 ;;
    --stage) stage="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

# Containers use the workspace profile: the default profile carries VM-only settings, and the project only admits
# containers with their own uid range, which that profile sets.
case "$kind" in agent) alias="${alias:-clinavat-agent}" vm=(--vm) ;; workspace) alias="${alias:-clinavat-workspace}" vm=(--profile workspace) ;;
  *) echo "--kind must be agent or workspace" >&2; exit 64 ;; esac

# lxc reads configuration from stdin when it is not a terminal and would otherwise wait forever.
run() { lxc --project "$project" "$@" </dev/null; }
remove_builder() { lxc delete "$remote:$builder" --force --project "$project" </dev/null >/dev/null 2>&1 || true; }

provision() {
  echo "== launch $base"
  run init "$base" "$remote:$builder" "${vm[@]}"
  run config device override "$remote:$builder" eth0 ipv4.address="$address"
  run start "$remote:$builder"
  for _ in $(seq 1 90); do
    if run exec "$remote:$builder" -- true >/dev/null 2>&1; then break; fi
    sleep 3
  done

  echo "== provision"
  lxc exec "$remote:$builder" --project "$project" \
    --env IMAGE_KIND="$kind" --env HUB_UID="$(id -u)" --env HUB_GID="$(id -g)" \
    --env NODE_VERSION="${NODE_VERSION:-22.23.4}" \
    --env CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.308}" \
    --env CODEX_VERSION="${CODEX_VERSION:-0.164.0}" \
    --env MUTAGEN_VERSION="${MUTAGEN_VERSION:-0.18.1}" \
    -- bash -s <"$SOURCE/provision-guest.sh"
}

publish() {
  echo "== publish $alias"
  run stop "$remote:$builder"
  if run image info "$remote:$alias" >/dev/null 2>&1; then run image alias delete "$remote:$alias"; fi
  run publish "$remote:$builder" "$remote:" --alias "$alias" --compression zstd
  run image list "$remote:" "$alias"
  remove_builder
}

case "$stage" in
  all) trap remove_builder EXIT; provision; publish ;;
  provision) provision ;;
  publish) publish ;;
  *) echo "--stage must be provision or publish" >&2; exit 64 ;;
esac
