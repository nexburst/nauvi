# 0005: Test clusters are kind only

**Status:** accepted (2026-11-13).

## Decision
Local and CI test clusters use **kind** (`scripts/test-cluster/setup.sh`).
kwok was tried and removed: it has no kubelet, so logs, exec, port-forward and
metrics — the app's core features — could not be tested.

## Consequences
Each kind cluster costs roughly 0.5–1 GB of RAM; a second cluster
(`setup.sh --staging`) is opt-in locally and created in CI's nightly QA.
