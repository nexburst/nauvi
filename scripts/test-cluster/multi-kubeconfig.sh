#!/usr/bin/env bash
# A kubeconfig with many contexts, for the multi-cluster budgets (ADR 0007):
#
#   multi-kubeconfig.sh OUT REACHABLE [UNREACHABLE] [PREFIX]
#
# writes OUT with REACHABLE contexts that all point at the test cluster
# (PREFIX-1 .. PREFIX-N, the first one current) and UNREACHABLE contexts
# (PREFIX-unreachable-1 ..) whose server is a TEST-NET address nothing
# answers on. PREFIX defaults to "budget". Contexts of several files stay
# apart when each file has its own PREFIX. NAUVI_TEST_CONTEXT picks the
# test cluster (default kind-nauvi-test). Never touches ~/.kube/config.
set -euo pipefail

out=${1:?usage: multi-kubeconfig.sh OUT REACHABLE [UNREACHABLE] [PREFIX]}
reachable=${2:?usage: multi-kubeconfig.sh OUT REACHABLE [UNREACHABLE] [PREFIX]}
unreachable=${3:-0}
prefix=${4:-budget}
ctx=${NAUVI_TEST_CONTEXT:-kind-nauvi-test}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
kubectl config view --flatten --minify --context "$ctx" -o json >"$tmp"

jq --arg prefix "$prefix" --argjson n "$reachable" --argjson m "$unreachable" '
  .clusters[0].name = ($prefix + "-cluster")
  | .users[0].name = ($prefix + "-user")
  | .clusters += (if $m > 0 then [{
      name: ($prefix + "-nowhere"),
      cluster: { server: "https://192.0.2.1:6443" }
    }] else [] end)
  | .users += (if $m > 0 then [{ name: ($prefix + "-nobody"), user: { token: "not-a-token" } }] else [] end)
  | .contexts = (
      [range(1; $n + 1) | { name: "\($prefix)-\(.)",
        context: { cluster: ($prefix + "-cluster"), user: ($prefix + "-user") } }]
      + [range(1; $m + 1) | { name: "\($prefix)-unreachable-\(.)",
        context: { cluster: ($prefix + "-nowhere"), user: ($prefix + "-nobody") } }])
  | ."current-context" = (.contexts[0].name // "")
' "$tmp" >"$out"
chmod 600 "$out"
