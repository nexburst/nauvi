//! Helm releases: native listing and decoding, rollback and uninstall
//! through the `helm` CLI.

use crate::state::{Cluster, ClusterSession};
use kubeloupe::actions::describe_error;
use kubeloupe::helm::{
    self, HelmChartInfo, HelmRelease, HelmReleaseList, HelmRevisionKey, HelmTarget,
};

/// The releases in `namespaces` (empty = all), from labels only. Namespaces
/// whose Secrets may not be listed come back as `warnings`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_list(
    cluster: Cluster,
    namespaces: Vec<String>,
) -> Result<HelmReleaseList, String> {
    let client = cluster.client().await?;
    helm::list_helm_releases(&client, &namespaces)
        .await
        .map_err(|e| describe_error(&e))
}

/// The chart of each given revision (a few payloads downloaded at a time),
/// for the list's chart columns. Errors are per release.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_charts(
    cluster: Cluster,
    keys: Vec<HelmRevisionKey>,
) -> Result<Vec<HelmChartInfo>, String> {
    let client = cluster.client().await?;
    Ok(helm::release_charts(&client, &keys).await)
}

/// One revision decoded (`revision` 0 = the newest). Secret values in the
/// manifest are hidden unless `reveal`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_get(
    cluster: Cluster,
    namespace: String,
    name: String,
    revision: u32,
    reveal: bool,
) -> Result<HelmRelease, String> {
    let client = cluster.client().await?;
    let revision = (revision > 0).then_some(revision);
    helm::get_helm_release(&client, &namespace, &name, revision, reveal)
        .await
        .map_err(|e| describe_error(&e))
}

/// The installed helm's version; an error says how to install it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_version() -> Result<String, String> {
    helm::helm_version().await.map_err(|e| format!("{e:#}"))
}

/// Helm talks to the app's context. Without a selection, name the
/// kubeconfig's current context explicitly, so helm cannot drift to another
/// one if the file changes meanwhile.
pub(crate) fn target(state: &ClusterSession) -> HelmTarget {
    let context = state.selected_context().or_else(|| {
        kube::config::Kubeconfig::read()
            .ok()
            .and_then(|k| k.current_context)
    });
    HelmTarget {
        kubeconfig: None,
        context,
    }
}

/// `helm rollback <name> <revision>`; returns a short summary.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_rollback(
    cluster: Cluster,
    namespace: String,
    name: String,
    revision: u32,
) -> Result<String, String> {
    helm::helm_rollback(&target(&cluster), &namespace, &name, revision)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// `helm uninstall <name>`; returns a short summary.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_uninstall(
    cluster: Cluster,
    namespace: String,
    name: String,
) -> Result<String, String> {
    helm::helm_uninstall(&target(&cluster), &namespace, &name)
        .await
        .map_err(|e| format!("{e:#}"))
}
