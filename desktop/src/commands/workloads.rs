//! The live Workloads overview (#79), pushed to the window as events while
//! it is open, like the cluster overview (`overview.rs`).

use crate::state::Cluster;
use futures::StreamExt;
use nauvi::watch::WatchState;
use nauvi::{watch_workloads, WorkloadsOverview, WorkloadsUpdate};
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

/// A new Workloads overview for the feed `id` (sent when it changed, at
/// most about once a second).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "workloads-update")]
pub(crate) struct WorkloadsChanged {
    id: u32,
    overview: WorkloadsOverview,
}

/// Connection state of the Workloads overview feed `id`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "workloads-state")]
pub(crate) struct WorkloadsStateChanged {
    id: u32,
    #[serde(flatten)]
    state: WatchState,
}

/// The feed's key in `ClusterSession::watches`, so a context switch stops it
/// with the other watches.
fn key(id: u32) -> String {
    format!("workloads-{id}")
}

/// Start the Workloads overview feed `id` (chosen by the UI) for
/// `namespaces` (empty: all namespaces). Replaces a feed with the same id;
/// the UI starts a new one when the namespace selection changes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_workloads_start(
    cluster: Cluster,
    id: u32,
    namespaces: Vec<String>,
) -> Result<(), String> {
    let (client, prober) = cluster.watch_client().await?;
    let out = cluster.emitter();
    let mut updates = watch_workloads(&client, &prober, &namespaces);
    let task = tauri::async_runtime::spawn(async move {
        while let Some(update) = updates.next().await {
            match update {
                WorkloadsUpdate::Summary(overview) => out.emit(WorkloadsChanged {
                    id,
                    overview: *overview,
                }),
                WorkloadsUpdate::State(state) => out.emit(WorkloadsStateChanged { id, state }),
            }
        }
    });
    cluster.add_watch(key(id), task);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_workloads_stop(cluster: Cluster, id: u32) -> Result<(), String> {
    if let Some(task) = cluster.watches.lock().unwrap().remove(&key(id)) {
        task.abort();
    }
    Ok(())
}
