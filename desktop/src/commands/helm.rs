//! Helm releases: native listing and decoding, rollback and uninstall
//! through the `helm` CLI.

use crate::state::{Cluster, ClusterSession};
use nauvi::actions::describe_error;
use nauvi::helm::{
    self, HelmChartInfo, HelmRelease, HelmReleaseList, HelmRevisionKey, HelmStorage, HelmTarget,
};
use nauvi::TempKubeconfig;

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

/// Helm talks to the app's context (#78). Without a selection, name the
/// kubeconfig's current context explicitly, so helm cannot drift to another
/// one if the file changes meanwhile. An added kubeconfig's context goes to
/// helm as a private temp copy of the context as it was read when its login
/// command was checked, never the added file (#242): an edit to that file
/// cannot make helm run another command.
pub(crate) fn target(state: &ClusterSession) -> Result<HelmRun, String> {
    let approved = state.target()?;
    let temp = match approved.flat()? {
        Some(flat) => Some(
            nauvi::catalog::kubeconfig_yaml(&flat)
                .and_then(|yaml| TempKubeconfig::create(&yaml))
                .map_err(|e| format!("{e:#}"))?,
        ),
        None => None,
    };
    Ok(HelmRun {
        target: HelmTarget {
            kubeconfig: temp.as_ref().map(|t| t.path().to_path_buf()),
            context: Some(approved.target.context),
        },
        _temp: temp,
    })
}

/// A [`HelmTarget`] and the temp kubeconfig it names, deleted when this is
/// dropped (after the helm command it was made for).
pub(crate) struct HelmRun {
    pub(crate) target: HelmTarget,
    _temp: Option<TempKubeconfig>,
}

impl std::ops::Deref for HelmRun {
    type Target = HelmTarget;
    fn deref(&self) -> &HelmTarget {
        &self.target
    }
}

/// `helm rollback <name> <revision>` of a release kept in `storage`
/// (`HelmRelease.storage`); returns a short summary.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_rollback(
    cluster: Cluster,
    namespace: String,
    name: String,
    revision: u32,
    storage: HelmStorage,
) -> Result<String, String> {
    helm::helm_rollback(&*target(&cluster)?, &namespace, &name, revision, storage)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// `helm uninstall <name>` of a release kept in `storage`; returns a short
/// summary.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_uninstall(
    cluster: Cluster,
    namespace: String,
    name: String,
    storage: HelmStorage,
) -> Result<String, String> {
    helm::helm_uninstall(&*target(&cluster)?, &namespace, &name, storage)
        .await
        .map_err(|e| format!("{e:#}"))
}
