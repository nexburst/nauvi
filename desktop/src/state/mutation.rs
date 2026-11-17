//! The gate of every command that changes a cluster (#338).
//!
//! A mutating command takes [`Mutation`] instead of [`Cluster`] as its
//! `cluster` argument. Tauri builds it before the command body runs, from
//! the same `cluster` payload key, and it refuses the call when the
//! cluster's context is read-only, or protected without the context name
//! typed as `confirm`. The command never gets the session otherwise, so it
//! cannot reach the cluster around the gate.
//!
//! In `bindings.ts` such a command's first parameter is
//! `cluster: MutationTarget`: the cluster id as for any command, or
//! `{ id, confirm }` with the typed name. `commands/mutation_gate.rs` lists
//! every command and fails when one that is not known to be read-only
//! lacks the gate.

use super::{Cluster, CLUSTER_KEY};
use crate::settings::SettingsStore;
use nauvi::context_mode::ContextMode;
use serde::Deserialize;
use specta::Type;
use std::ops::Deref;
use std::sync::Arc;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};
use tauri::Manager;

/// The `cluster` argument of a mutating command.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(untagged)]
pub(crate) enum MutationTarget {
    /// The cluster id: enough unless the context is protected.
    Id(String),
    /// The cluster id and what the user typed to confirm the change.
    Confirmed(Confirmed),
}

#[derive(Debug, Clone, Deserialize, Type)]
pub(crate) struct Confirmed {
    pub(crate) id: String,
    pub(crate) confirm: String,
}

impl MutationTarget {
    fn parts(&self) -> (&str, &str) {
        match self {
            Self::Id(id) => (id, ""),
            Self::Confirmed(c) => (&c.id, &c.confirm),
        }
    }
}

/// A [`Cluster`] whose context lets this call change it.
pub(crate) struct Mutation(Cluster);

impl Deref for Mutation {
    type Target = Cluster;
    fn deref(&self) -> &Cluster {
        &self.0
    }
}

/// What a gated command does, which decides what each mode allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Gate {
    /// Changes the cluster or opens a shell: refused on a read-only
    /// context, confirmed on a protected one.
    Change,
    /// Starts a port-forward: it only reads through a tunnel, so a
    /// read-only context allows it, but it can reach a service that
    /// writes, so a protected one wants the confirmation too.
    Forward,
}

/// Why the call is refused, if it is. `id` is the session's cluster id
/// (its context id, which the settings are keyed by) and `name` its
/// context's name in its kubeconfig, which the user types to confirm (the
/// same as `id` for the default kubeconfig; `prod` for `prod (work.yaml)`).
/// A dry run (validate only) needs no confirmation on a protected context;
/// a read-only one refuses it too.
pub(crate) fn check(
    store: &SettingsStore,
    gate: Gate,
    id: &str,
    name: &str,
    confirm: &str,
    dry_run: bool,
) -> Result<(), String> {
    let mode = store.context_mode(id);
    if dry_run && mode == ContextMode::Protected {
        return Ok(());
    }
    if gate == Gate::Forward && mode == ContextMode::ReadOnly {
        return Ok(());
    }
    match nauvi::context_mode::refusal(mode, name, confirm) {
        None => Ok(()),
        Some(reason) => {
            tracing::info!("refused a change to {id} ({})", mode.label());
            Err(reason)
        }
    }
}

/// The commands that only validate when asked to, and where they read it.
/// Anything else (another command, a missing key, another spelling) is not
/// a dry run, so it needs the confirmation: a `dryRun` key added to a
/// delete does not skip it.
const DRY_RUNS: &[(&str, DryRunKey)] = &[
    ("cmd_apply_manifests", DryRunKey::Arg),
    ("cmd_apply_resource_yaml", DryRunKey::Arg),
    ("cmd_helm_install", DryRunKey::Request),
    ("cmd_helm_upgrade", DryRunKey::Request),
    ("cmd_metrics_addon_install", DryRunKey::Request),
];

#[derive(Debug, Clone, Copy)]
enum DryRunKey {
    /// The `dry_run: bool` argument (`dryRun` in the payload).
    Arg,
    /// `request.dry_run`.
    Request,
}

/// Whether the call of `command` only validates: it reads its dry-run flag
/// from the same key the command does.
fn dry_run(command: &str, payload: &InvokeBody) -> bool {
    let Some((_, key)) = DRY_RUNS.iter().find(|(c, _)| *c == command) else {
        return false;
    };
    let InvokeBody::Json(v) = payload else {
        return false;
    };
    let flag = match key {
        DryRunKey::Arg => v.get("dryRun"),
        DryRunKey::Request => v.get("request").and_then(|r| r.get("dry_run")),
    };
    flag.and_then(serde_json::Value::as_bool) == Some(true)
}

/// The gate itself: the session the call names, if its context allows it.
fn gated(command: CommandItem<'_, tauri::Wry>, gate: Gate) -> Result<Cluster, InvokeError> {
    let target = MutationTarget::from_command(CommandItem {
        key: CLUSTER_KEY,
        ..command
    })?;
    let (id, confirm) = target.parts();
    let cluster = Cluster::of_call(&command, id);
    let store = cluster.app().state::<Arc<SettingsStore>>();
    let dry_run = dry_run(command.name, command.message.payload());
    let mode = store.context_mode(cluster.id());
    // The name is looked up only when the context is not normal.
    let name = match mode {
        ContextMode::Normal => String::new(),
        _ => context_name(&cluster),
    };
    // The session's id: `""` names the visible cluster.
    check(&store, gate, cluster.id(), &name, confirm, dry_run).map_err(InvokeError::from)?;
    Ok(cluster)
}

impl<'de> CommandArg<'de, tauri::Wry> for Mutation {
    fn from_command(command: CommandItem<'de, tauri::Wry>) -> Result<Self, InvokeError> {
        gated(command, Gate::Change).map(Mutation)
    }
}

/// The `cluster` of a command that starts a port-forward: allowed on a
/// read-only context, confirmed on a protected one ([`Gate::Forward`]).
pub(crate) struct ForwardStart(Cluster);

impl Deref for ForwardStart {
    type Target = Cluster;
    fn deref(&self) -> &Cluster {
        &self.0
    }
}

impl<'de> CommandArg<'de, tauri::Wry> for ForwardStart {
    fn from_command(command: CommandItem<'de, tauri::Wry>) -> Result<Self, InvokeError> {
        gated(command, Gate::Forward).map(ForwardStart)
    }
}

impl specta::function::FunctionArg for ForwardStart {
    fn to_datatype(types: &mut specta::Types) -> Option<specta::datatype::DataType> {
        Some(<MutationTarget as Type>::definition(types))
    }
}

/// The name of the session's context in its kubeconfig (its id if the
/// catalog no longer has it).
pub(crate) fn context_name(cluster: &Cluster) -> String {
    let id = cluster.id();
    cluster
        .sources
        .catalog()
        .find(id)
        .map(|c| c.context.clone())
        .unwrap_or_else(|| id.to_string())
}

/// In the bindings as `cluster: MutationTarget`.
impl specta::function::FunctionArg for Mutation {
    fn to_datatype(types: &mut specta::Types) -> Option<specta::datatype::DataType> {
        Some(<MutationTarget as Type>::definition(types))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_target_reads_both_shapes() {
        let id: MutationTarget = serde_json::from_str(r#""prod""#).unwrap();
        assert_eq!(id.parts(), ("prod", ""));
        let c: MutationTarget = serde_json::from_str(r#"{"id":"prod","confirm":"prod"}"#).unwrap();
        assert_eq!(c.parts(), ("prod", "prod"));
        assert!(serde_json::from_str::<MutationTarget>(r#"{"id":"prod"}"#).is_err());
    }

    #[test]
    fn the_gate_follows_the_context_mode() {
        let store = SettingsStore::open(None);
        store.set_context_mode("ro", ContextMode::ReadOnly);
        store.set_context_mode("prod", ContextMode::Protected);
        let c = Gate::Change;
        assert!(check(&store, c, "dev", "dev", "", false).is_ok());
        let ro = check(&store, c, "ro", "ro", "ro", false).unwrap_err();
        assert!(ro.contains("read-only"), "{ro}");
        assert!(
            check(&store, c, "ro", "ro", "", true).is_err(),
            "read-only refuses dry runs"
        );
        assert!(check(&store, c, "prod", "prod", "", false).is_err());
        assert!(check(&store, c, "prod", "prod", "dev", false).is_err());
        assert!(check(&store, c, "prod", "prod", "prod", false).is_ok());
        assert!(
            check(&store, c, "prod", "prod", "", true).is_ok(),
            "a dry run needs no confirmation"
        );
        // Another context's name does not confirm this one.
        assert!(check(&store, c, "ro", "ro", "prod", false).is_err());
        // An added file's context is confirmed by its name, not its id.
        store.set_context_mode("prod (work.yaml)", ContextMode::Protected);
        assert!(check(&store, c, "prod (work.yaml)", "prod", "prod", false).is_ok());
        assert!(check(
            &store,
            c,
            "prod (work.yaml)",
            "prod",
            "prod (work.yaml)",
            false
        )
        .is_err());
    }

    #[test]
    fn port_forwards_run_on_read_only_and_are_confirmed_on_protected() {
        let store = SettingsStore::open(None);
        store.set_context_mode("ro", ContextMode::ReadOnly);
        store.set_context_mode("prod", ContextMode::Protected);
        let f = Gate::Forward;
        assert!(check(&store, f, "ro", "ro", "", false).is_ok());
        assert!(check(&store, f, "dev", "dev", "", false).is_ok());
        let p = check(&store, f, "prod", "prod", "", false).unwrap_err();
        assert!(p.contains("type the context name"), "{p}");
        assert!(check(&store, f, "prod", "prod", "prod", false).is_ok());
    }

    #[test]
    fn dry_runs_are_read_from_the_keys_the_commands_read() {
        let body = InvokeBody::Json;
        assert!(dry_run(
            "cmd_apply_resource_yaml",
            &body(json!({ "dryRun": true }))
        ));
        assert!(dry_run(
            "cmd_apply_manifests",
            &body(json!({ "dryRun": true }))
        ));
        assert!(dry_run(
            "cmd_helm_install",
            &body(json!({ "request": { "dry_run": true } }))
        ));
        assert!(dry_run(
            "cmd_metrics_addon_install",
            &body(json!({ "request": { "dry_run": true } }))
        ));
        assert!(!dry_run(
            "cmd_apply_manifests",
            &body(json!({ "dryRun": false }))
        ));
        assert!(!dry_run(
            "cmd_apply_manifests",
            &body(json!({ "dryRun": "true" }))
        ));
        assert!(!dry_run(
            "cmd_apply_manifests",
            &body(json!({ "dry_run": true }))
        ));
        assert!(!dry_run(
            "cmd_helm_install",
            &body(json!({ "dryRun": true }))
        ));
        assert!(!dry_run(
            "cmd_apply_manifests",
            &body(json!({ "request": { "dry_run": true } }))
        ));
        assert!(!dry_run(
            "cmd_helm_upgrade",
            &body(json!({ "request": { "dryRun": true } }))
        ));
        assert!(!dry_run("cmd_apply_manifests", &body(json!({}))));
        assert!(!dry_run(
            "cmd_apply_manifests",
            &InvokeBody::Raw(br#"{"dryRun":true}"#.to_vec())
        ));
        // A dry-run flag on a command that does no dry run is ignored: a
        // delete with `dryRun: true` still needs the confirmation.
        for cmd in [
            "cmd_delete_resource",
            "cmd_run_action",
            "cmd_bulk_delete",
            "cmd_helm_uninstall",
            "cmd_exec_start",
        ] {
            let payload = body(json!({ "dryRun": true, "request": { "dry_run": true } }));
            assert!(!dry_run(cmd, &payload), "{cmd}");
        }
    }

    #[test]
    fn every_dry_run_command_is_gated_and_takes_the_flag() {
        let bindings = include_str!("../../ui-src/src/lib/bindings.ts");
        for (cmd, key) in DRY_RUNS {
            let camel = cmd
                .split('_')
                .enumerate()
                .map(|(i, w)| {
                    if i == 0 {
                        w.to_string()
                    } else {
                        w[..1].to_uppercase() + &w[1..]
                    }
                })
                .collect::<String>();
            let line = bindings
                .lines()
                .find(|l| {
                    l.trim_start()
                        .starts_with(&format!("{camel}: (cluster: MutationTarget"))
                })
                .unwrap_or_else(|| panic!("{camel} is not a gated command"));
            match key {
                DryRunKey::Arg => assert!(line.contains("dryRun: boolean"), "{line}"),
                DryRunKey::Request => assert!(line.contains("request: "), "{line}"),
            }
        }
    }
}
