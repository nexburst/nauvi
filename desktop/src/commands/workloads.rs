//! The live Workloads overview (#79), pushed to the view while it is open,
//! on the channel the start command was given (#115), like the cluster
//! overview (`overview.rs`).

use crate::state::Cluster;
use futures::StreamExt;
use nauvi::watch::WatchState;
use nauvi::{watch_workloads, WorkloadsOverview, WorkloadsUpdate};
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

/// A message on a Workloads overview feed's channel.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum WorkloadsMessage {
    /// A new overview (sent when it changed, at most about once a second).
    Update { overview: Box<WorkloadsOverview> },
    /// The feed's connection state changed.
    State(WatchState),
}

/// The feed's key in `ClusterSession::watches`, so a context switch stops it
/// with the other watches.
fn key(id: u32) -> String {
    format!("workloads-{id}")
}

/// Start the Workloads overview feed `id` (chosen by the UI) for
/// `namespaces` (empty: all namespaces), sending to `on_event`. Replaces a
/// feed with the same id; the UI starts a new one when the namespace
/// selection changes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_workloads_start(
    cluster: Cluster,
    id: u32,
    namespaces: Vec<String>,
    on_event: Channel<WorkloadsMessage>,
) -> Result<(), String> {
    let (client, prober) = cluster.watch_client().await?;
    let mut updates = watch_workloads(&client, &prober, &namespaces);
    let task = tauri::async_runtime::spawn(async move {
        while let Some(update) = updates.next().await {
            let msg = match update {
                WorkloadsUpdate::Summary(overview) => WorkloadsMessage::Update { overview },
                WorkloadsUpdate::State(state) => WorkloadsMessage::State(state),
            };
            // A closed view has nobody left to read it; its feed is stopped
            // by the view, or with its window or cluster session.
            let _ = on_event.send(msg);
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
