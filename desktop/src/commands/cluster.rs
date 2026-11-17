//! Contexts, namespaces, metrics, discovery and access checks.

use crate::commands::usage;
use crate::settings::SettingsStore;
use crate::state::{spawn_closes, Cluster, ClusterSession};
use crate::windows;
use nauvi::resources::{self, AccessResult, ResourceKind, ResourceRef};
use nauvi::{
    default_namespace, get_node_metrics, get_pod_metrics, list_namespaces_if_allowed, ContextInfo,
    NamespaceInfo, NodeUsage, PodUsage, Spark,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
#[specta::specta]
/// The cluster's namespaces, or `null` if the user may not list them (the
/// UI then lets them type one).
pub(crate) async fn cmd_list_namespaces(
    cluster: Cluster,
) -> Result<Option<Vec<NamespaceInfo>>, String> {
    let client = cluster.client().await?;
    list_namespaces_if_allowed(&client)
        .await
        .map_err(|e| nauvi::error_text(&e))
}

/// The namespace to start on: `null` (all namespaces) if the user may list
/// pods cluster-wide, otherwise the context's namespace or the first one
/// they can access.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_default_namespace(cluster: Cluster) -> Result<Option<String>, String> {
    let client = cluster.client().await?;
    Ok(default_namespace(&client).await)
}

#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct MetricsSnapshot {
    available: bool,
    pods: Vec<PodUsage>,
    nodes: Vec<NodeUsage>,
    /// Sparklines of the pods or nodes above, keyed like the table rows
    /// (`namespace/name`, or the node name).
    sparks: HashMap<String, Spark>,
    /// Epoch ms of their oldest recorded sample (0 = none yet).
    since: u64,
}

/// Which metrics a view shows.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MetricsKind {
    Pods,
    Nodes,
}

/// Usage for what is on screen: pod metrics in `namespace` (`null` = all
/// namespaces), or node metrics (`namespace` is ignored). The other list
/// is empty. Each call also records the usage history (#47).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_get_metrics(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespace: Option<String>,
    what: MetricsKind,
) -> Result<MetricsSnapshot, String> {
    if metrics_hidden(&cluster, &settings) {
        // Hidden for this cluster (#327): the metrics API is not asked.
        return Ok(MetricsSnapshot {
            available: false,
            pods: Vec::new(),
            nodes: Vec::new(),
            sparks: HashMap::new(),
            since: 0,
        });
    }
    let ctx = cluster.selected_context();
    let client = cluster.client().await?;
    let (pods, nodes) = match what {
        MetricsKind::Pods => (get_pod_metrics(&client, namespace.as_deref()).await, None),
        MetricsKind::Nodes => (Ok(None), Some(get_node_metrics(&client).await)),
    };
    let pods = pods.map_err(|e| nauvi::error_text(&e))?;
    let nodes = nodes
        .transpose()
        .map_err(|e| nauvi::error_text(&e))?
        .flatten();
    let available = pods.is_some() || nodes.is_some();
    let (pods, nodes) = (pods.unwrap_or_default(), nodes.unwrap_or_default());
    let (sparks, since) = usage::record(&cluster, &ctx, &pods, &nodes);
    Ok(MetricsSnapshot {
        available,
        pods,
        nodes,
        sparks,
        since,
    })
}

/// Whether the user hid metrics for the cluster's context (#327).
pub(crate) fn metrics_hidden(cluster: &ClusterSession, settings: &SettingsStore) -> bool {
    cluster
        .context_id()
        .is_ok_and(|id| settings.get().metrics_hidden(&id))
}

/// Discover every kind the cluster serves (including CRDs) with its columns.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_discover(cluster: Cluster) -> Result<Vec<ResourceKind>, String> {
    let client = cluster.client().await?;
    let kinds = resources::discover(&client)
        .await
        .map_err(|e| nauvi::error_text(&e))?;
    *cluster.kinds.lock().unwrap() = kinds.clone();
    Ok(kinds)
}

/// Which of the kinds the current user may list in `namespace` (`null` =
/// across all namespaces; ignored for cluster-scoped kinds).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_check_access(
    cluster: Cluster,
    kinds: Vec<ResourceRef>,
    namespace: Option<String>,
) -> Result<Vec<AccessResult>, String> {
    let client = cluster.client().await?;
    Ok(resources::check_access(&client, &kinds, namespace.as_deref()).await)
}

/// Every context of the catalog (#78): the default kubeconfig's, then those
/// of the added files and folders, each with a unique id (`name`). The
/// calling window's context is `current`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_list_contexts(
    cluster: Cluster,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<ContextInfo>, String> {
    let mut contexts = state.sources.catalog().contexts;
    if let Some(selected) = cluster.selected_context() {
        for ctx in &mut contexts {
            ctx.current = ctx.name == selected;
        }
    }
    Ok(contexts)
}

/// Switch the calling window to context `name` (`null`: the kubeconfig's
/// current-context). Everything that window started is stopped first;
/// other windows are not affected.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_set_context(cluster: Cluster, name: Option<String>) -> Result<(), String> {
    spawn_closes(cluster.set_context(name.clone()).await);
    windows::context_changed(cluster.app(), cluster.label(), name.as_deref());
    Ok(())
}
