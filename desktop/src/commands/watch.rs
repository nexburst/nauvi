//! Live watches of a kind, forwarded to the webview as batched events.

use crate::state::{next_session, Cluster, ClusterSession, WindowEmitter};
use kube::Client;
use kubeloupe::resources::{self, ResourceKind, ResourceRef, ResourceRow};
use kubeloupe::watch;
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

/// One coalesced set of table rows for the watch `id`: the first batch is a
/// full snapshot, later ones are incremental.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub(crate) struct WatchBatch {
    id: String,
    snapshot: bool,
    applied: Vec<ResourceRow>,
    /// Keys of removed rows.
    deleted: Vec<String>,
}

/// A new detail (or `deleted`, or a watch error) for the detail watch `id`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "detail-watch")]
pub(crate) struct DetailWatchEvent {
    id: String,
    #[serde(flatten)]
    state: resources::DetailState,
}

/// Payload of the `watch-state` event.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "watch-state")]
pub(crate) struct WatchStateChanged {
    id: String,
    #[serde(flatten)]
    state: watch::WatchState,
}

/// Forward a watch to the webview: state changes as `watch-state`, rows as
/// coalesced `watch-batch` events.
async fn pump_watch<S>(win: WindowEmitter, id: String, updates: S)
where
    S: futures::Stream<Item = watch::Update<ResourceRow>> + Unpin,
{
    watch::run_batched(updates, watch::DEFAULT_FLUSH, |out| match out {
        watch::Output::Batch(batch) => {
            win.emit(WatchBatch {
                id: id.clone(),
                snapshot: batch.snapshot,
                applied: batch.applied,
                deleted: batch.deleted,
            });
        }
        watch::Output::State(state) => {
            win.emit(WatchStateChanged {
                id: id.clone(),
                state,
            });
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
        .map_err(|e| kubeloupe::error_text(&e))?;
    let found = find(&kinds);
    *state.kinds.lock().unwrap() = kinds;
    found.ok_or_else(|| format!("{} is not served by this cluster", resource.kind))
}

/// Start watching a kind (in `namespace`, if it is namespaced). Returns the
/// watch id carried by the `watch-batch` / `watch-state` events.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_watch_start(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: Option<String>,
) -> Result<String, String> {
    let (client, prober) = cluster.watch_client().await?;
    let kind = kind_of(&cluster, &client, &resource).await?;
    let id = next_session("watch");
    let (_store, updates) = watch::watch_resource(&client, &prober, &kind, namespace.as_deref());
    let task = tauri::async_runtime::spawn(pump_watch(cluster.emitter(), id.clone(), updates));
    cluster.add_watch(id.clone(), task);
    Ok(id)
}

/// Watch one object for the detail panel. Returns the watch id carried by
/// the `detail-watch` events; stop it with `cmd_watch_stop`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_detail_watch(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let (client, prober) = cluster.watch_client().await?;
    let id = next_session("detail");
    let watch_id = id.clone();
    let out = cluster.emitter();
    let task = tauri::async_runtime::spawn(resources::run_detail_watch(
        client,
        prober,
        resource,
        namespace,
        name,
        resources::DETAIL_FLUSH,
        move |state| {
            out.emit(DetailWatchEvent {
                id: watch_id.clone(),
                state,
            });
        },
    ));
    cluster.add_watch(id.clone(), task);
    Ok(id)
}

/// Stop a table watch or a detail watch.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_watch_stop(cluster: Cluster, id: String) -> Result<(), String> {
    if let Some(task) = cluster.watches.lock().unwrap().remove(&id) {
        task.abort();
    }
    Ok(())
}
