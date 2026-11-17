//! Helm charts: chart repositories, search and chart details (the user's
//! helm configuration, not the cluster), and install/upgrade into the
//! window's cluster, all through the `helm` CLI.

use super::helm::target;
use crate::state::Cluster;
use nauvi::helm::{
    self, HelmChartDetails, HelmChartVersion, HelmDeployRequest, HelmDeployResult, HelmRepo,
    HelmRepoUpdate,
};

fn plain(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// The configured chart repositories.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_repo_list() -> Result<Vec<HelmRepo>, String> {
    helm::list_repos().await.map_err(plain)
}

/// `helm repo add`; returns a short summary.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_repo_add(name: String, url: String) -> Result<String, String> {
    helm::add_repo(name.trim(), url.trim()).await.map_err(plain)
}

/// `helm repo remove`; returns a short summary.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_repo_remove(name: String) -> Result<String, String> {
    helm::remove_repo(&name).await.map_err(plain)
}

/// `helm repo update` for `names` (empty: all). Unreachable repositories
/// come back in `failed`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_repo_update(names: Vec<String>) -> Result<HelmRepoUpdate, String> {
    helm::update_repos(&names).await.map_err(plain)
}

/// Charts in the repositories matching `query`: the newest version of
/// each, or every version with `all_versions`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_search(
    query: String,
    all_versions: bool,
) -> Result<Vec<HelmChartVersion>, String> {
    helm::search_charts(&query, all_versions)
        .await
        .map_err(plain)
}

/// Every version of `chart` (`repo/chart`, or a bare name in any
/// repository), newest first.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_chart_versions(
    chart: String,
) -> Result<Vec<HelmChartVersion>, String> {
    helm::chart_versions(&chart).await.map_err(plain)
}

/// A chart version's metadata, README and default values (`version` empty:
/// the newest).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_chart_show(
    chart: String,
    version: String,
) -> Result<HelmChartDetails, String> {
    helm::chart_details(&chart, &version).await.map_err(plain)
}

/// `helm install` (or its dry run) into the window's cluster.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_install(
    cluster: Cluster,
    request: HelmDeployRequest,
) -> Result<HelmDeployResult, String> {
    helm::helm_install(&*target(&cluster)?, &request)
        .await
        .map_err(plain)
}

/// `helm upgrade` (or its dry run) of a release in the window's cluster.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_helm_upgrade(
    cluster: Cluster,
    request: HelmDeployRequest,
) -> Result<HelmDeployResult, String> {
    helm::helm_upgrade(&*target(&cluster)?, &request)
        .await
        .map_err(plain)
}
