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
  local shells with the context's kubeconfig).
- **Port-forwards** only read through a tunnel, but the service at the
  other end may write (an admin UI, a database). So a **read-only**
  context allows them (like logs), and a **protected** one asks for the
  typed name before each one starts (`ForwardStart`, `Gate::Forward`);
  saved forwards marked "start automatically" do not start by themselves
  on a protected context and come back stopped.
- **Switching a context to read-only closes its open terminals** in every
  window (exec, attach, debug, node and local shells), each with a note in
  the terminal saying why. Port-forwards, logs, watches and running drains
  go on.
- **Dry runs** need no confirmation on a protected context (they validate
  only), but only for the commands that do a dry run, matched by name,
  reading the flag where that command reads it (`dryRun` of
  `cmd_apply_resource_yaml` / `cmd_apply_manifests`, `request.dry_run` of
  the Helm and add-on installs). A `dryRun` key on any other command is
  ignored. A read-only context refuses dry runs too.
- **The confirmation** is the context's name in its kubeconfig (`prod`
  for the id `prod (work.yaml)`), compared exactly by the backend. The UI
  asks for it in one place, `api(id)`, before any gated call
  (`MUTATING_COMMANDS` in `lib/cluster.ts`).
- **RBAC composes:** `cmd_check_actions` (#340) reports every changing
  action of a read-only context as refused, with the mode as the reason, so
  the existing greying-out shows it.
- **`nauvi mcp`** reads the app's `settings.json` and refuses its write
  tools on a read-only or protected context (a model cannot type the
  confirmation for the person). It finds the context's mode by its catalog
  id, built exactly as the app builds it (`load_catalog` over the default
  kubeconfig and the app's added sources), so `--kubeconfig work.yaml
  --context prod` gets the mode of `prod (work.yaml)`. A context the app's
  catalog does not have is refused writes; with no app settings at all,
  nothing is marked and writes follow `--allow-writes`.

## Consequences
The gate protects against mistakes and UI bugs, not against a compromised
webview: whatever can call `cmd_set_context_mode` or type the name can
change the mode. A protected context's sessions started before the switch
(an open shell, a running forward or drain) keep running. The MCP server
finds the app's settings only at the default config path.
