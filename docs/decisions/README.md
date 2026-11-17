# Decisions

Short records of decisions that shape the project, so a new contributor or a
fresh agent session doesn't have to rediscover them. One file per decision:
context, decision, consequences, and links to the issues/PRs with the details.
Add a new file instead of rewriting an old one when a decision changes.

| # | Decision |
|---|---|
| [0001](0001-tauri-svelte-typed-ipc.md) | Desktop stack: Tauri 2 + Svelte 5 + TypeScript, typed IPC with tauri-specta |
| [0002](0002-testing-layers.md) | Testing layers: unit, fake-backend UI tests, kind cluster tests, real-app QA on WebKitGTK |
| [0003](0003-release-gate.md) | First release only after ~90% Lens parity and an agent QA pass |
| [0004](0004-agent-workflow.md) | One coordinator session with role subagents; merge gate; resource limits; no cloud workers |
| [0005](0005-test-cluster-kind-only.md) | Test clusters are kind only |
| [0006](0006-mcp-server.md) | `nauvi mcp`: read-only by default, Secret values never returned, output capped |
| [0007](0007-multi-cluster.md) | Many clusters per window: one session per (window, cluster), commands name their cluster, idle disconnect after 10 min |
| [0008](0008-rename-to-nauvi.md) | The project is called nauvi (renamed before the first release) |
