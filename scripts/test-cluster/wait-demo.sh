#!/usr/bin/env bash
# Waits until the demo workload is in the state the tests expect, so they do
# not race a fresh cluster:
#   - demo/multi is Ready,
#   - the demo/logger and demo/web rollouts are done and a logger pod has
#     printed a line,
#   - demo/crashed has crashed (and restarted) at least once.
# Stops at once with "image pull failed: <image>" when a demo pod cannot pull
# its image, instead of waiting out the timeout.
#
# Usage: bash scripts/test-cluster/wait-demo.sh [timeout-seconds]   (default 240)
# The context is KUBELOUPE_TEST_CONTEXT (default kind-kubeloupe-test).
set -euo pipefail

timeout="${1:-240}"
ctx="${KUBELOUPE_TEST_CONTEXT:-kind-kubeloupe-test}"
k() { kubectl --context "$ctx" -n demo "$@"; }
deadline=$((SECONDS + timeout))

# Exits with the image and the kubelet's message when a demo container is
# waiting on an image it cannot pull.
check_pulls() {
  local failed reason image message
  local tmpl='{range .status.initContainerStatuses[*]}{.state.waiting.reason}{"\t"}{.image}{"\t"}{.state.waiting.message}{"\n"}{end}'
  tmpl+='{range .status.containerStatuses[*]}{.state.waiting.reason}{"\t"}{.image}{"\t"}{.state.waiting.message}{"\n"}{end}'
  failed="$(k get pods -o "jsonpath={range .items[*]}${tmpl}{end}" 2>/dev/null |
    grep -E $'^(ErrImagePull|ImagePullBackOff|InvalidImageName|ErrImageNeverPull)\t' || true)"
  [ -z "$failed" ] && return 0
  while IFS=$'\t' read -r reason image message; do
    echo "image pull failed: $image ($reason: $message)" >&2
  done <<<"$failed"
  k get pods -o wide >&2 || true
  exit 1
}

# Polls "$@" until it prints something non-empty (and not "0").
until_output() {
  local what="$1" out
  shift
  while :; do
    check_pulls
    out="$("$@" 2>/dev/null || true)"
    if [ -n "$out" ] && [ "$out" != 0 ]; then
      echo "$what: $out"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "timed out after ${timeout}s waiting for $what" >&2
      k get pods -o wide >&2 || true
      exit 1
    fi
    sleep 2
  done
}

multi_ready() {
  [ "$(k get pod multi -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}')" = True ] &&
    echo Ready
}
rolled_out() { k rollout status "deploy/$1" --timeout=1s >/dev/null && echo "rolled out"; }

until_output "demo/multi" multi_ready
until_output "demo/web" rolled_out web
until_output "demo/logger" rolled_out logger
until_output "a demo/logger log line" k logs deploy/logger --tail=1
until_output "demo/crashed restarts" \
  k get pod crashed -o 'jsonpath={.status.containerStatuses[0].restartCount}'
