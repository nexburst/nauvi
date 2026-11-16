#!/usr/bin/env bash
# The Docker Hub images the demo workload, the tests and the QA scenarios run,
# pulled once and loaded into the kind nodes, so the nodes never pull them
# themselves (Docker Hub's anonymous pull limit and its transient errors made
# whole CI jobs fail on ErrImagePull, #269). Every pod spec that uses them
# has a fixed tag, so the kubelet's default IfNotPresent finds them loaded.
#
# Usage:
#   bash scripts/test-cluster/images.sh pull [--prometheus]
#       Pulls them (linux/amd64 or the host's platform) through mirror.gcr.io,
#       Google's Docker Hub mirror, with retries; Docker Hub itself last.
#       Tags each under its Docker Hub name.
#   bash scripts/test-cluster/images.sh save <file.tar> [--prometheus]
#       Pulls them and writes them into one archive (`docker save`).
#   bash scripts/test-cluster/images.sh load <cluster> [<file.tar>] [--prometheus]
#       Loads them into every node of a kind cluster: from the archive if
#       given, else pulls them first. Needs Docker 28 or later
#       (`docker save --platform`).
#
# --prometheus adds prom/prometheus (scripts/test-cluster/prometheus.yaml).
set -euo pipefail

# Keep in sync with demo.yaml, limited-user.sh, the charts, src/debug.rs and
# src/node_shell.rs (DEFAULT_DEBUG_IMAGE, NODE_SHELL_IMAGE) and the QA
# scenarios.
IMAGES=(
  busybox:1.36
  busybox:1.37
  nginx:1.27
)
PROMETHEUS_IMAGE=prom/prometheus:v2.55.1
# The kind nodes' platform. Saved archives hold only it: with Docker's
# containerd image store a plain `docker save` (and so `kind load
# docker-image`) lists every platform of a multi-arch image but has the
# content of one, and the nodes' `ctr import` fails on "content digest not
# found".
PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"

# Docker Hub short name -> repository path on a mirror (library/ for
# official images).
hub_path() {
  case "$1" in
    */*) echo "$1" ;;
    *) echo "library/$1" ;;
  esac
}

pull_one() {
  local image="$1" path src attempt
  path="$(hub_path "$image")"
  for src in "mirror.gcr.io/$path" "docker.io/$path"; do
    for attempt in 1 2 3; do
      if docker pull --quiet --platform "$PLATFORM" "$src" >/dev/null; then
        docker tag "$src" "$image"
        echo "pulled $image (from $src)"
        return 0
      fi
      echo "pull of $src failed (attempt $attempt)" >&2
      sleep $((attempt * 5))
    done
  done
  echo "image pull failed: $image" >&2
  return 1
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
args=()
for arg in "$@"; do
  case "$arg" in
    --prometheus) IMAGES+=("$PROMETHEUS_IMAGE") ;;
    *) args+=("$arg") ;;
  esac
done

pull_all() {
  local image
  for image in "${IMAGES[@]}"; do pull_one "$image"; done
}

case "$cmd" in
  pull)
    pull_all
    ;;
  save)
    [ "${#args[@]}" -eq 1 ] || { echo "usage: images.sh save <file.tar> [--prometheus]" >&2; exit 2; }
    pull_all
    docker save --platform "$PLATFORM" -o "${args[0]}" "${IMAGES[@]}"
    echo "saved ${IMAGES[*]} to ${args[0]}"
    ;;
  load)
    [ "${#args[@]}" -ge 1 ] && [ "${#args[@]}" -le 2 ] ||
      { echo "usage: images.sh load <cluster> [<file.tar>] [--prometheus]" >&2; exit 2; }
    cluster="${args[0]}"
    if [ "${#args[@]}" -eq 2 ]; then
      kind load image-archive --name "$cluster" "${args[1]}"
    else
      pull_all
      archive="$(mktemp --suffix=.tar)"
      trap 'rm -f "$archive"' EXIT
      docker save --platform "$PLATFORM" -o "$archive" "${IMAGES[@]}"
      kind load image-archive --name "$cluster" "$archive"
    fi
    echo "loaded the test images into kind cluster $cluster"
    ;;
  *)
    echo "usage: images.sh pull|save|load ... (see the header of this script)" >&2
    exit 2
    ;;
esac
