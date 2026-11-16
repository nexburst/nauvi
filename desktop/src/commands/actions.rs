//! Resource actions: run an action, bulk delete, drain a node.

use crate::state::{next_session, Cluster};
use kubeloupe::action_access::{self, ActionAccess};
use kubeloupe::actions::{self, ActionId, BulkItemResult, DrainEvent, DrainSummary};
use kubeloupe::resources::ResourceRef;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tauri_specta::Event;

/// Run one action (everything except drain) on one object. Returns a short
/// summary. The change reaches the table through the live watch. Errors are
/// plain-words sentences ready to show inline.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_run_action(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
    action: ActionId,
    replicas: Option<i32>,
) -> Result<String, String> {
    let client = cluster.client().await?;
    actions::run_action(&client, &resource, &namespace, &name, action, replicas)
        .await
        .map_err(|e| actions::describe_error(&e))
}

/// Which of `ids` (action ids, plus "logs", "shell" and "edit") the user
/// may run on one object, for greying out the detail panel's actions. A
/// check that cannot be made counts as allowed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_check_actions(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    ids: Vec<String>,
) -> Result<Vec<ActionAccess>, String> {
    let client = cluster.client().await?;
    Ok(action_access::check_actions(&client, &resource, &namespace, &ids).await)
}

/// One object of a bulk delete.
#[derive(Debug, Clone, Deserialize, Type)]
pub(crate) struct ObjectId {
    /// Empty for cluster-scoped kinds.
    namespace: String,
    name: String,
}

/// Delete many objects of one kind. Every object is attempted; the result
/// has one entry per object with its error, if any.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_bulk_delete(
    cluster: Cluster,
    resource: ResourceRef,
    items: Vec<ObjectId>,
) -> Result<Vec<BulkItemResult>, String> {
    let client = cluster.client().await?;
    let items: Vec<(String, String)> = items.into_iter().map(|i| (i.namespace, i.name)).collect();
    Ok(actions::delete_many(&client, &resource, &items).await)
}

/// Progress of a node drain started by `cmd_drain_node`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainProgress {
    drain_id: String,
    event: DrainEvent,
}

/// A node drain ended. `error` is empty when it ran to the end (see
/// `summary`) and says why not otherwise (for instance 403 on cordon).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainFinished {
    drain_id: String,
    summary: DrainSummary,
    error: String,
}

/// Cordon a node and evict its pods in the background. Progress arrives as
/// `DrainProgress` events and the end as `DrainFinished`; returns the drain id.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_drain_node(
    cluster: Cluster,
    node: String,
    timeout_secs: u32,
) -> Result<String, String> {
    let client = cluster.client().await?;
    let drain_id = next_session("drain");
    let id = drain_id.clone();
    let out = cluster.emitter();
    let session = cluster.session();
    let handle = tauri::async_runtime::spawn(async move {
        let emitter = out.clone();
        let progress_id = id.clone();
        let result = actions::drain_node(
            &client,
            &node,
            &actions::DrainOptions::new(Duration::from_secs(timeout_secs.into())),
            move |event| {
                emitter.emit(DrainProgress {
                    drain_id: progress_id.clone(),
                    event,
                });
            },
        )
        .await;
        let (summary, error) = match result {
            Ok(s) => (s, String::new()),
            Err(e) => (DrainSummary::default(), actions::describe_error(&e)),
        };
        session.drains.lock().unwrap().remove(&id);
        out.emit(DrainFinished {
            drain_id: id,
            summary,
            error,
        });
    });
    cluster.add_drain(drain_id.clone(), handle);
    Ok(drain_id)
}

/// Stop following a drain. Pods already evicted stay evicted and the node
/// stays cordoned.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_cancel_drain(cluster: Cluster, drain_id: String) -> Result<(), String> {
    if let Some(h) = cluster.drains.lock().unwrap().remove(&drain_id) {
        h.abort();
    }
    Ok(())
}
