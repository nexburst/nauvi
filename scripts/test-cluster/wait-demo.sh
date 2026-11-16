#!/usr/bin/env bash
# Waits until the demo workload is in the state the tests expect, so they do
# not race a fresh cluster:
#   - demo/multi is Ready,
#   - the demo/logger and demo/web rollouts are done and a logger pod has
#     printed a line,
#   - demo/crashed has crashed (and restarted) at least once.
# Stops with "image pull failed: <image>" once a demo pod has failed to pull
# its image for 30 s (KUBELOUPE_PULL_GRACE), instead of waiting out the timeout.
#
# Usage: bash scripts/test-cluster/wait-demo.sh [timeout-seconds]   (default 240)
# The context is KUBELOUPE_TEST_CONTEXT (default kind-kubeloupe-test).
set -euo pipefail

timeout="${1:-240}"
ctx="${KUBELOUPE_TEST_CONTEXT:-kind-kubeloupe-test}"
k() { kubectl --context "$ctx" -n demo "$@"; }
deadline=$((SECONDS + timeout))

# How long an image may keep failing to pull before giving up: the kubelet
# retries, and one failed pull can be a registry hiccup.
pull_grace="${KUBELOUPE_PULL_GRACE:-30}"
# "<image> <first second it failed>" per line, for the images failing now.
pull_failing=""

# Exits with the image and the kubelet's message when a demo container has
# been waiting on an image it cannot pull for pull_grace seconds.
check_pulls() {
  local failed reason image message since now_failing="" give_up=0
  local tmpl='{range .status.initContainerStatuses[*]}{.state.waiting.reason}{"\t"}{.image}{"\t"}{.state.waiting.message}{"\n"}{end}'
  tmpl+='{range .status.containerStatuses[*]}{.state.waiting.reason}{"\t"}{.image}{"\t"}{.state.waiting.message}{"\n"}{end}'
  failed="$(k get pods -o "jsonpath={range .items[*]}${tmpl}{end}" 2>/dev/null |
    grep -E $'^(ErrImagePull|ImagePullBackOff|InvalidImageName|ErrImageNeverPull)\t' || true)"
  if [ -z "$failed" ]; then
    pull_failing=""
    return 0
  fi
  while IFS=$'\t' read -r reason image message; do
    since="$(awk -v img="$image" '$1 == img { print $2; exit }' <<<"$pull_failing")"
    [ -n "$since" ] || since="$SECONDS"
    now_failing+="$image $since"$'\n'
    if [ $((SECONDS - since)) -ge "$pull_grace" ]; then
      echo "image pull failed: $image ($reason: $message)" >&2
      give_up=1
    fi
  done <<<"$failed"
  pull_failing="$now_failing"
  if [ "$give_up" = 1 ]; then
    k get pods -o wide >&2 || true
    exit 1
  fi
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
