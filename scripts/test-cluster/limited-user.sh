#!/usr/bin/env bash
# Opt-in: a namespace-scoped user on the kind test cluster, for trying
# nauvi the way someone with only a RoleBinding sees it.
#
# Creates, on kind-nauvi-test:
#   namespace team-a
#   ServiceAccount team-a/limited, bound to the built-in `edit` ClusterRole
#   in team-a only (a RoleBinding, no ClusterRoleBinding)
# and writes a SEPARATE kubeconfig for it (context kind-nauvi-limited,
# namespace team-a) with a 24h token. ~/.kube/config is never modified.
#
# Usage:   bash scripts/test-cluster/limited-user.sh [output-kubeconfig]
#          (default output: ~/.kube/nauvi-limited.yaml)
# Then:    KUBECONFIG=~/.kube/nauvi-limited.yaml cargo tauri dev
# Tests:   NAUVI_LIMITED_KUBECONFIG=~/.kube/nauvi-limited.yaml \
#            cargo test --test cluster limited -- --ignored
# Re-run it to refresh the token. Tear down:
#          kubectl --context kind-nauvi-test delete namespace team-a
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
OUT="${1:-$HOME/.kube/nauvi-limited.yaml}"
ADMIN_CONTEXT="${NAUVI_TEST_CONTEXT:-kind-nauvi-test}"
NS=team-a
KCTX=(--context "$ADMIN_CONTEXT")

kubectl "${KCTX[@]}" create namespace "$NS" --dry-run=client -o yaml | kubectl "${KCTX[@]}" apply -f -
kubectl "${KCTX[@]}" apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: limited
  namespace: $NS
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: limited-edit
  namespace: $NS
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - kind: ServiceAccount
    name: limited
    namespace: $NS
---
# Something to look at in the namespace.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
  namespace: $NS
spec:
  replicas: 1
  selector:
    matchLabels: {app: hello}
  template:
    metadata:
      labels: {app: hello}
    spec:
      containers:
        - name: hello
          image: busybox:1.36
          command: ["sh", "-c", "while true; do echo hello; sleep 5; done"]
EOF

TOKEN="$(kubectl "${KCTX[@]}" create token limited -n "$NS" --duration=24h)"
SERVER="$(kubectl config view --raw --minify --context "$ADMIN_CONTEXT" \
  -o jsonpath='{.clusters[0].cluster.server}')"
CA="$(kubectl config view --raw --minify --context "$ADMIN_CONTEXT" \
  -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"

mkdir -p "$(dirname "$OUT")"
umask 077
cat >"$OUT" <<EOF
apiVersion: v1
kind: Config
current-context: kind-nauvi-limited
clusters:
  - name: kind-nauvi-test
    cluster:
      server: $SERVER
      certificate-authority-data: $CA
users:
  - name: nauvi-limited
    user:
      token: $TOKEN
contexts:
  - name: kind-nauvi-limited
    context:
      cluster: kind-nauvi-test
      user: nauvi-limited
      namespace: $NS
EOF

echo "Wrote $OUT (context kind-nauvi-limited, namespace $NS)."
echo "Check:  KUBECONFIG=$OUT kubectl get pods          # allowed"
echo "        KUBECONFIG=$OUT kubectl get pods -A       # forbidden"
echo "Run:    KUBECONFIG=$OUT cargo tauri dev"
