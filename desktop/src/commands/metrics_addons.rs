//! One-click metrics (#225): the add-ons nauvi can install when a
//! cluster has no metrics (metrics-server, a small Prometheus stack),
//! whether the user may, and their `helm install` (dry run first).

use super::helm::target;
use crate::state::mutation::Mutation;
use crate::state::Cluster;
use nauvi::action_access::ActionAccess;
use nauvi::helm::{self, HelmDeployResult, MetricsAddon, MetricsAddonId, MetricsAddonRequest};

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
    store: tauri::State<'_, std::sync::Arc<crate::settings::SettingsStore>>,
    addon: MetricsAddonId,
    namespace: String,
) -> Result<ActionAccess, String> {
    let mode = store.context_mode(cluster.id());
    // A read-only context refuses the install whatever RBAC says (#338).
    if mode == nauvi::context_mode::ContextMode::ReadOnly {
        return Ok(ActionAccess {
            id: addon.as_str().to_string(),
            allowed: false,
            reason: nauvi::context_mode::read_only_reason(&crate::state::mutation::context_name(
                &cluster,
            )),
        });
    }
    let client = cluster.client().await?;
    helm::metrics_addon_access(&client, addon, &namespace)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// `helm install` (or its dry run) of an add-on into the window's cluster.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_metrics_addon_install(
    cluster: Mutation,
    request: MetricsAddonRequest,
) -> Result<HelmDeployResult, String> {
    helm::install_metrics_addon(&*target(&cluster)?, &request)
        .await
        .map_err(|e| format!("{e:#}"))
}
