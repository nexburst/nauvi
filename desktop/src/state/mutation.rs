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

/// Why the call is refused, if it is. `id` is the session's cluster id
/// (its context id, which the settings are keyed by) and `name` its
/// context's name in its kubeconfig, which the user types to confirm (the
/// same as `id` for the default kubeconfig; `prod` for `prod (work.yaml)`).
/// A dry run (validate only) needs no confirmation on a protected context;
/// a read-only one refuses it too.
pub(crate) fn check(
    store: &SettingsStore,
    id: &str,
    name: &str,
    confirm: &str,
    dry_run: bool,
) -> Result<(), String> {
    let mode = store.context_mode(id);
    if dry_run && mode == ContextMode::Protected {
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

/// Whether the call only validates: a top-level `dryRun` argument
/// (`cmd_apply_resource_yaml`, `cmd_apply_manifests`) or `request.dry_run`
/// (the Helm and add-on installs) set to `true`. The commands read the same
/// keys; anything else (a missing key, another spelling) is not a dry run,
/// so it needs the confirmation.
fn dry_run(payload: &InvokeBody) -> bool {
    let InvokeBody::Json(v) = payload else {
        return false;
    };
    let yes = |v: Option<&serde_json::Value>| v.and_then(serde_json::Value::as_bool) == Some(true);
    yes(v.get("dryRun")) || yes(v.get("request").and_then(|r| r.get("dry_run")))
}

impl<'de> CommandArg<'de, tauri::Wry> for Mutation {
    fn from_command(command: CommandItem<'de, tauri::Wry>) -> Result<Self, InvokeError> {
        let target = MutationTarget::from_command(CommandItem {
            key: CLUSTER_KEY,
            ..command
        })?;
        let (id, confirm) = target.parts();
        let cluster = Cluster::of_call(&command, id);
        let store = cluster.app().state::<Arc<SettingsStore>>();
        let dry_run = dry_run(command.message.payload());
        let mode = store.context_mode(cluster.id());
        // The name is looked up only when the context is not normal.
        let name = match mode {
            ContextMode::Normal => String::new(),
            _ => context_name(&cluster),
        };
        // The session's id: `""` names the visible cluster.
        check(&store, cluster.id(), &name, confirm, dry_run).map_err(InvokeError::from)?;
        Ok(Mutation(cluster))
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
        assert!(check(&store, "dev", "dev", "", false).is_ok());
        let ro = check(&store, "ro", "ro", "ro", false).unwrap_err();
        assert!(ro.contains("read-only"), "{ro}");
        assert!(
            check(&store, "ro", "ro", "", true).is_err(),
            "read-only refuses dry runs"
        );
        assert!(check(&store, "prod", "prod", "", false).is_err());
        assert!(check(&store, "prod", "prod", "dev", false).is_err());
        assert!(check(&store, "prod", "prod", "prod", false).is_ok());
        assert!(
            check(&store, "prod", "prod", "", true).is_ok(),
            "a dry run needs no confirmation"
        );
        // Another context's name does not confirm this one.
        assert!(check(&store, "ro", "ro", "prod", false).is_err());
        // An added file's context is confirmed by its name, not its id.
        store.set_context_mode("prod (work.yaml)", ContextMode::Protected);
        assert!(check(&store, "prod (work.yaml)", "prod", "prod", false).is_ok());
        assert!(check(
            &store,
            "prod (work.yaml)",
            "prod",
            "prod (work.yaml)",
            false
        )
        .is_err());
    }

    #[test]
    fn dry_runs_are_read_from_the_keys_the_commands_read() {
        let body = InvokeBody::Json;
        assert!(dry_run(&body(json!({ "dryRun": true }))));
        assert!(dry_run(&body(json!({ "request": { "dry_run": true } }))));
        assert!(!dry_run(&body(json!({ "dryRun": false }))));
        assert!(!dry_run(&body(json!({ "dryRun": "true" }))));
        assert!(!dry_run(&body(json!({ "dry_run": true }))));
        assert!(!dry_run(&body(json!({ "request": { "dryRun": true } }))));
        assert!(!dry_run(&body(json!({}))));
        assert!(!dry_run(&InvokeBody::Raw(br#"{"dryRun":true}"#.to_vec())));
    }
}
