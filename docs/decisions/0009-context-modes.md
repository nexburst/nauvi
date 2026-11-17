# 0009: Read-only and protected contexts, gated in the backend

**Status:** proposed (2026-11-17), needs a security verdict. Issue #338.

## Context
People keep production next to their test clusters. A mistyped delete, a
YAML apply in the wrong window or an agent with write tools can change the
wrong cluster. RBAC is the real boundary, but many people are admins on
their own clusters.

## Decision
- **Modes per context:** `normal`, `protected` (every change needs the
  context's name typed) and `readOnly` (every change is refused). Kept in
  `settings.json` under `contexts.<id>.mode`; an unknown value reads as
  read-only. Changed only through `cmd_set_context_mode`: a settings patch
  keeps the mode, so a window with an older copy of the settings cannot
  turn it off.
- **One gate, in the command layer:** a mutating command takes
  `cluster: Mutation` instead of `cluster: Cluster` (`state/mutation.rs`).
  Tauri builds it before the body runs, and it refuses the call unless the
  mode allows it; the command cannot reach the session otherwise. In
  `bindings.ts` its first parameter is `cluster: MutationTarget` (the id,
  or `{ id, confirm }`). `commands/mutation_gate.rs` lists every cluster
  command and fails when one is neither gated nor listed as changing
  nothing, so a new command cannot forget it.
- **What counts as a change:** writes to the API server (actions, deletes,
  applies, data edits, drains, Helm install / upgrade / rollback /
  uninstall, metrics add-ons, debug containers, node shell pods and their
  clean-up) and every shell that could write (exec, attach, node shells,
  local shells with the context's kubeconfig). **Port-forwards are not**:
  they only read through a tunnel, like logs, so both modes allow them.
- **Dry runs** (`dryRun`, `request.dry_run`) need no confirmation on a
  protected context (they validate only); a read-only context refuses them
  too.
- **The confirmation** is the context's name in its kubeconfig (`prod`
  for the id `prod (work.yaml)`), compared exactly by the backend. The UI
  asks for it in one place, `api(id)`, before any gated call
  (`MUTATING_COMMANDS` in `lib/cluster.ts`).
- **RBAC composes:** `cmd_check_actions` (#340) reports every changing
  action of a read-only context as refused, with the mode as the reason, so
  the existing greying-out shows it.
- **`nauvi mcp`** reads the app's `settings.json` and refuses its write
  tools on a read-only or protected context (a model cannot type the
  confirmation for the person).

## Consequences
The gate protects against mistakes and UI bugs, not against a compromised
webview: whatever can call `cmd_set_context_mode` or type the name can
change the mode. Sessions started before a mode change (an open shell, a
running drain) keep running. The MCP server finds the app's settings only
at the default config path, by context name.
