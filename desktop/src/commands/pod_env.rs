//! A container's environment with its values, for the pod panel's
//! Environment list (#447). Secret values never come through here: they
//! are revealed one key at a time with `cmd_reveal_data_value`. Results
//! are never logged; errors carry names and keys, never values.

use crate::state::Cluster;
use nauvi::actions;
use nauvi::resources::{self, ContainerEnv};

/// The env of one container: literals (secret-looking ones withheld),
/// ConfigMap values, resolved pod fields, Secret keys without values, and a
/// plain line for each source that is missing or may not be read.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_pod_env(
    cluster: Cluster,
    namespace: String,
    pod: String,
    container: String,
) -> Result<ContainerEnv, String> {
    let client = cluster.client().await?;
    resources::get_pod_env(&client, &namespace, &pod, &container)
        .await
        .map_err(|e| actions::describe_error(&e))
}

/// One value that `cmd_pod_env` withheld because it looks like a secret (a
/// literal, a pod field or a ConfigMap value), on an explicit reveal. The
/// row is named by position: `group` is its `envFrom` source's index, or
/// -1 for `env`, where `index` is its position; `name` must match. Never
/// logged.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_reveal_pod_env(
    cluster: Cluster,
    namespace: String,
    pod: String,
    container: String,
    group: i32,
    index: u32,
    name: String,
) -> Result<String, String> {
    let client = cluster.client().await?;
    resources::reveal_pod_env_value(&client, &namespace, &pod, &container, group, index, &name)
        .await
        .map_err(|e| actions::describe_error(&e))
}
