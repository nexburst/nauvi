//! The live Applications view (#226), pushed to the window as events while
//! it is open, like the Workloads overview (`workloads.rs`).

use crate::state::Cluster;
use futures::StreamExt;
use nauvi::applications::ApplicationsList;
use nauvi::watch::WatchState;
use nauvi::{watch_applications, ApplicationsUpdate};
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

/// A new applications list for the feed `id` (sent when it changed, at
/// most about once a second).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "applications-update")]
pub(crate) struct ApplicationsChanged {
    id: u32,
    list: ApplicationsList,
}

/// Connection state of the applications feed `id`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "applications-state")]
pub(crate) struct ApplicationsStateChanged {
    id: u32,
    #[serde(flatten)]
    state: WatchState,
}

/// The feed's key in `ClusterSession::watches`, so a context switch stops it
/// with the other watches.
fn key(id: u32) -> String {
    format!("applications-{id}")
}

/// Start the applications feed `id` (chosen by the UI) for `namespaces`
/// (empty: all namespaces). Replaces a feed with the same id; the UI starts
/// a new one when the namespace selection changes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_applications_start(
    cluster: Cluster,
    id: u32,
    namespaces: Vec<String>,
) -> Result<(), String> {
    let (client, prober) = cluster.watch_client().await?;
    let out = cluster.emitter();
    let mut updates = watch_applications(&client, &prober, &namespaces);
    let task = tauri::async_runtime::spawn(async move {
        while let Some(update) = updates.next().await {
            match update {
                ApplicationsUpdate::List(list) => out.emit(ApplicationsChanged { id, list: *list }),
                ApplicationsUpdate::State(state) => {
                    out.emit(ApplicationsStateChanged { id, state })
                }
            }
        }
    });
    cluster.add_watch(key(id), task);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_applications_stop(cluster: Cluster, id: u32) -> Result<(), String> {
    if let Some(task) = cluster.watches.lock().unwrap().remove(&key(id)) {
        task.abort();
    }
    Ok(())
}
