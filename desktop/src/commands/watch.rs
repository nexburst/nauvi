//! Live watches of a kind, forwarded to the webview on the channel the
//! start command was given (#115): messages arrive in order and only at
//! the table or panel that started the watch.

use crate::state::{next_session, Cluster, ClusterSession};
use kube::Client;
use nauvi::resources::{self, CustomColumn, ResourceKind, ResourceRef, ResourceRow};
use nauvi::watch;
use serde::Serialize;
use specta::Type;
use tauri::ipc::Channel;

/// A message on a table watch's channel.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum WatchMessage {
    /// One coalesced set of table rows: the first batch is a full
    /// snapshot, later ones are incremental.
    Batch {
        snapshot: bool,
        applied: Vec<ResourceRow>,
        /// Keys of removed rows.
        deleted: Vec<String>,
    },
    /// The watch's connection state changed.
    State(watch::WatchState),
}

/// Forward a watch to its channel: rows as coalesced batches, and state
/// changes. A closed table has nobody left to read them (its watch is
/// stopped by the table, or with its window or cluster session).
async fn pump_watch<S>(out: Channel<WatchMessage>, updates: S)
where
    S: futures::Stream<Item = watch::Update<ResourceRow>> + Unpin,
{
    watch::run_batched(updates, watch::DEFAULT_FLUSH, |msg| match msg {
        watch::Output::Batch(batch) => {
            let snapshot = batch.snapshot;
            let _ = out.send(WatchMessage::Batch {
                snapshot,
                applied: batch.applied,
                deleted: batch.deleted,
            });
            // The pages of the list that built it are freed by now (#397).
            if snapshot {
                nauvi::heap::release();
            }
        }
        watch::Output::State(state) => {
            let _ = out.send(WatchMessage::State(state));
        }
    })
    .await;
}

/// The discovered kind for `resource`, discovering first if needed.
async fn kind_of(
    state: &ClusterSession,
    client: &Client,
    resource: &ResourceRef,
) -> Result<ResourceKind, String> {
    let find = |kinds: &[ResourceKind]| kinds.iter().find(|k| &k.resource == resource).cloned();
    if let Some(k) = find(&state.kinds.lock().unwrap()) {
        return Ok(k);
    }
    let kinds = resources::discover(client)
        .await
        .map_err(|e| nauvi::error_text(&e))?;
    let found = find(&kinds);
    *state.kinds.lock().unwrap() = kinds;
    found.ok_or_else(|| format!("{} is not served by this cluster", resource.kind))
}

/// Start watching a kind (in `namespace`, if it is namespaced); its rows
/// and states go to `on_event`. The rows carry a cell for each of the
/// `custom` columns too, after the kind's own (#547). Returns the watch id
/// for `cmd_watch_stop`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_watch_start(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: Option<String>,
    custom: Vec<CustomColumn>,
    on_event: Channel<WatchMessage>,
) -> Result<String, String> {
    let extra = resources::custom_column_defs(&custom)?;
    let (client, prober) = cluster.watch_client().await?;
    let mut kind = kind_of(&cluster, &client, &resource).await?;
    kind.columns.extend(extra);
    let id = next_session("watch");
    let updates = watch::watch_resource(&client, &prober, &kind, namespace.as_deref());
    let task = tauri::async_runtime::spawn(pump_watch(on_event, updates));
    cluster.add_watch(id.clone(), task);
    Ok(id)
}

/// Watch one object for the detail panel: each new detail (or `deleted`,
/// or a watch error) goes to `on_event`. Returns the watch id; stop it
/// with `cmd_watch_stop`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_detail_watch(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
    on_event: Channel<resources::DetailState>,
) -> Result<String, String> {
    let (client, prober) = cluster.watch_client().await?;
    let id = next_session("detail");
    let task = tauri::async_runtime::spawn(resources::run_detail_watch(
        client,
        prober,
        resource,
        namespace,
        name,
        resources::DETAIL_FLUSH,
        move |state| {
            // A closed panel has nobody left to read it.
            let _ = on_event.send(state);
        },
    ));
    cluster.add_watch(id.clone(), task);
    Ok(id)
}

/// Stop a table watch or a detail watch, and give the memory its rows took
/// back to the system once the task is gone (#397).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_watch_stop(cluster: Cluster, id: String) -> Result<(), String> {
    let task = cluster.watches.lock().unwrap().remove(&id);
    if let Some(task) = task {
        task.abort();
        // Resolves (cancelled) once the task's rows and batcher are dropped.
        let _ = task.await;
        nauvi::heap::release();
    }
    Ok(())
}
