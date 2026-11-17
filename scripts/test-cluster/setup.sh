#!/usr/bin/env bash
# Sets up the nauvi test cluster with kind (Kubernetes IN Docker): real
# nodes running real containers, so logs, exec, port-forwarding and the
# metrics API all work.
#
# Creates:
#   nauvi-test     — control-plane + 1 worker, metrics-server and the
#                        demo workload (demo.yaml)
#   nauvi-staging  — single node, empty, only with --staging (a second
#                        cluster for testing the context switcher)
# kind merges the contexts into ~/.kube/config; kind-nauvi-test is left
# current.
#
# Requires: Docker (your user able to run `docker` without sudo).
# Usage:     bash scripts/test-cluster/setup.sh [--staging]
#   NAUVI_IMAGES=pull  pull the test images once (images.sh) and load them
#                          into the nodes, so the nodes never pull from
#                          Docker Hub (CI sets this)
#   NAUVI_IMAGES=<file.tar>  load them from an `images.sh save` archive
# Tear down: kind delete cluster --name nauvi-test
#            kind delete cluster --name nauvi-staging
set -euo pipefail

KIND_VERSION="${KIND_VERSION:-v0.33.0}"
METRICS_SERVER_VERSION="${METRICS_SERVER_VERSION:-v0.9.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

WITH_STAGING=0
for arg in "$@"; do
  case "$arg" in
    --staging) WITH_STAGING=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Tools go into ~/.local/bin; make sure it is on PATH for this run.
export PATH="$HOME/.local/bin:$PATH"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
mkdir -p "$HOME/.local/bin"

# 1. Docker must be installed and usable without sudo.
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. On Ubuntu:" >&2
  echo "  sudo apt-get install -y docker.io && sudo usermod -aG docker \$USER" >&2
  echo "then log out and back in (or run: newgrp docker)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Cannot talk to the Docker daemon. Is it running, and is your user in" >&2
  echo "the docker group? (sudo usermod -aG docker \$USER, then log in again)" >&2
  exit 1
fi

# 2. kind and kubectl.
if ! command -v kind >/dev/null 2>&1; then
  echo "Installing kind ${KIND_VERSION} to ~/.local/bin..."
  curl -sfLo "$HOME/.local/bin/kind" \
    "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${OS}-${ARCH}"
  chmod +x "$HOME/.local/bin/kind"
fi
if ! command -v kubectl >/dev/null 2>&1; then
  KUBECTL_VERSION="$(curl -sfL https://dl.k8s.io/release/stable.txt)"
  echo "Installing kubectl ${KUBECTL_VERSION} to ~/.local/bin..."
  curl -sfLo "$HOME/.local/bin/kubectl" \
    "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl"
  chmod +x "$HOME/.local/bin/kubectl"
fi

# 3. Clusters (skip ones that already exist).
create_cluster() {
  local name="$1" config="$2"
  if kind get clusters 2>/dev/null | grep -qx "$name"; then
    echo "Cluster $name already exists, skipping create."
  else
    kind create cluster --name "$name" --config - <<<"$config"
  fi
}

create_cluster nauvi-test "$(cat <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
EOF
)"
if [ "$WITH_STAGING" = 1 ]; then
  create_cluster nauvi-staging "$(cat <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
EOF
)"
fi

# Docker Hub images, loaded into the nodes instead of pulled by them.
load_images() {
  case "${NAUVI_IMAGES:-}" in
    "") ;;
    pull) bash "$SCRIPT_DIR/images.sh" load "$1" ;;
    *) bash "$SCRIPT_DIR/images.sh" load "$1" "$NAUVI_IMAGES" ;;
  esac
}
load_images nauvi-test
if [ "$WITH_STAGING" = 1 ]; then load_images nauvi-staging; fi

KCTX=(--context kind-nauvi-test)

# 4. metrics-server. kind's kubelets use self-signed serving certs, so
# metrics-server needs --kubelet-insecure-tls (fine for a local test cluster).
kubectl "${KCTX[@]}" apply -f \
  "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"
if ! kubectl "${KCTX[@]}" -n kube-system get deploy metrics-server \
     -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
  kubectl "${KCTX[@]}" -n kube-system patch deploy metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi

# 5. Demo workload.
kubectl "${KCTX[@]}" apply -f "$SCRIPT_DIR/demo.yaml"

echo "Waiting for metrics-server and the demo workload..."
kubectl "${KCTX[@]}" -n kube-system rollout status deploy/metrics-server --timeout=180s
kubectl "${KCTX[@]}" -n demo rollout status deploy/web --timeout=180s
kubectl "${KCTX[@]}" -n demo rollout status deploy/logger --timeout=180s

kubectl config use-context kind-nauvi-test

echo
echo "Test cluster ready:"
kubectl config get-contexts
echo "Run the app with: cargo run -p nauvi-desktop"
echo "(Usage columns fill in about a minute after metrics-server starts.)"
