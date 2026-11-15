#!/usr/bin/env bash
# Waits until the demo workload is in the state the tests expect, so they do
# not race a fresh cluster:
#   - demo/multi is Ready,
#   - the demo/logger and demo/web rollouts are done and a logger pod has
#     printed a line,
#   - demo/crashed has crashed (and restarted) at least once.
#
# Usage: bash scripts/test-cluster/wait-demo.sh [timeout-seconds]   (default 240)
# The context is KUBELOUPE_TEST_CONTEXT (default kind-kubeloupe-test).
set -euo pipefail

timeout="${1:-240}"
ctx="${KUBELOUPE_TEST_CONTEXT:-kind-kubeloupe-test}"
k() { kubectl --context "$ctx" -n demo "$@"; }
deadline=$((SECONDS + timeout))

k wait --for=condition=Ready pod/multi --timeout="${timeout}s"
k rollout status deploy/web --timeout="${timeout}s"
k rollout status deploy/logger --timeout="${timeout}s"

# Polls "$@" until it prints something non-empty (and not "0").
until_output() {
  local what="$1"
  shift
  while :; do
    out="$("$@" 2>/dev/null || true)"
    if [ -n "$out" ] && [ "$out" != 0 ]; then
      echo "$what: $out"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "timed out after ${timeout}s waiting for $what" >&2
      k get pods -o wide >&2 || true
      return 1
    fi
    sleep 2
  done
}

until_output "a demo/logger log line" k logs deploy/logger --tail=1
until_output "demo/crashed restarts" \
  k get pod crashed -o 'jsonpath={.status.containerStatuses[0].restartCount}'
