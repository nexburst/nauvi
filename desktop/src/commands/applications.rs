//! The live Applications view (#226), pushed to the view while it is open,
//! on the channel the start command was given (#115), like the Workloads
//! overview (`workloads.rs`).

use crate::state::Cluster;
use futures::StreamExt;
use nauvi::applications::ApplicationsList;
use nauvi::watch::WatchState;
use nauvi::{watch_applications, ApplicationsUpdate};
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

/// A message on an applications feed's channel.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ApplicationsMessage {
    /// A new applications list (sent when it changed, at most about once a
    /// second).
    Update { list: Box<ApplicationsList> },
    /// The feed's connection state changed.
    State(WatchState),
}

/// The feed's key in `ClusterSession::watches`, so a context switch stops it
/// with the other watches.
fn key(id: u32) -> String {
    format!("applications-{id}")
}

/// Start the applications feed `id` (chosen by the UI) for `namespaces`
/// (empty: all namespaces), sending to `on_event`. Replaces a feed with the
/// same id; the UI starts a new one when the namespace selection changes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_applications_start(
    cluster: Cluster,
    id: u32,
    namespaces: Vec<String>,
    on_event: Channel<ApplicationsMessage>,
) -> Result<(), String> {
    let (client, prober) = cluster.watch_client().await?;
    let mut updates = watch_applications(&client, &prober, &namespaces);
    let task = tauri::async_runtime::spawn(async move {
        while let Some(update) = updates.next().await {
            let msg = match update {
                ApplicationsUpdate::List(list) => ApplicationsMessage::Update { list },
                ApplicationsUpdate::State(state) => ApplicationsMessage::State(state),
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
pub(crate) async fn cmd_applications_stop(cluster: Cluster, id: u32) -> Result<(), String> {
    if let Some(task) = cluster.watches.lock().unwrap().remove(&key(id)) {
        task.abort();
    }
    Ok(())
}
