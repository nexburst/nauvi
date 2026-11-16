//! One-click metrics (#225): the add-ons kubeloupe can install when a
//! cluster has no metrics (metrics-server, a small Prometheus stack),
//! whether the user may, and their `helm install` (dry run first).

use super::helm::target;
use crate::state::Cluster;
use kubeloupe::action_access::ActionAccess;
use kubeloupe::helm::{
    self, HelmDeployResult, MetricsAddon, MetricsAddonId, MetricsAddonRequest,
};

/// Every add-on, with its pinned chart, repository and starting values.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_metrics_addons() -> Vec<MetricsAddon> {
    helm::metrics_addons()
}

/// Whether the user may install `addon` into `namespace` (RBAC), with the
/// first refused object as the reason.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_metrics_addon_access(
    cluster: Cluster,
    addon: MetricsAddonId,
    namespace: String,
) -> Result<ActionAccess, String> {
    let client = cluster.client().await?;
    helm::metrics_addon_access(&client, addon, &namespace)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// `helm install` (or its dry run) of an add-on into the window's cluster.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_metrics_addon_install(
    cluster: Cluster,
    request: MetricsAddonRequest,
) -> Result<HelmDeployResult, String> {
    helm::install_metrics_addon(&*target(&cluster)?, &request)
        .await
        .map_err(|e| format!("{e:#}"))
}
