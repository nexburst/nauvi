//! The live overview, pushed to the webview as events while it is open.

use crate::commands::cluster::metrics_hidden;
use crate::commands::prometheus::prometheus_for;
use crate::commands::usage::{now_ms, UsageSource, HIDDEN_NOTE};
use crate::settings::SettingsStore;
use crate::state::Cluster;
use futures::StreamExt;
use nauvi::watch::WatchState;
use nauvi::{prometheus_cluster_usage, watch_overview_with, Overview, OverviewUpdate, UsageSample};
use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::State;
use tauri_specta::Event;

/// A new overview for the overview feed `id` (sent when it changed, at
/// most about once a second).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "overview-update")]
pub(crate) struct OverviewChanged {
    id: u32,
    overview: Overview,
}

/// Connection state of the overview feed `id`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[tauri_specta(event_name = "overview-state")]
pub(crate) struct OverviewStateChanged {
    id: u32,
    #[serde(flatten)]
    state: WatchState,
}

/// The feed's key in `ClusterSession::watches`, so a context switch stops it
/// with the other watches.
fn key(id: u32) -> String {
    format!("overview-{id}")
}

/// Start the overview feed `id` (chosen by the UI, so no event can arrive
/// before it knows the id). Parts the user may not see cluster-wide fall
/// back to `namespace` (`null` = the context's namespace). Replaces a feed
/// with the same id.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_overview_start(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    id: u32,
    namespace: Option<String>,
) -> Result<(), String> {
    let (client, prober) = cluster.watch_client().await?;
    let out = cluster.emitter();
    // Metrics hidden for the cluster (#327): no node usage polling.
    let usage = !metrics_hidden(&cluster, &settings);
    let mut updates = watch_overview_with(&client, &prober, namespace.as_deref(), usage);
    let task = tauri::async_runtime::spawn(async move {
        while let Some(update) = updates.next().await {
            match update {
                OverviewUpdate::Summary(overview) => out.emit(OverviewChanged {
                    id,
                    overview: *overview,
                }),
                OverviewUpdate::State(state) => out.emit(OverviewStateChanged { id, state }),
            }
        }
    });
    cluster.add_watch(key(id), task);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_overview_stop(cluster: Cluster, id: u32) -> Result<(), String> {
    if let Some(task) = cluster.watches.lock().unwrap().remove(&key(id)) {
        task.abort();
    }
    Ok(())
}

/// The cluster's CPU and memory use for the overview's chart (#328).
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct OverviewUsageView {
    /// Oldest first; empty unless `source` is Prometheus.
    samples: Vec<UsageSample>,
    /// `metrics_server`: the UI charts what it samples from the overview's
    /// usage while the window is open.
    source: UsageSource,
    /// The Prometheus of this context (`namespace/service:port`), or "".
    prometheus: String,
    /// Why Prometheus was not used although there is one, or that metrics
    /// are hidden ("" otherwise).
    note: String,
}

/// The last hour of the cluster's CPU and memory use from the context's
/// Prometheus. Without one (or when it fails, with a `note`) there are no
/// samples and the source is metrics-server. Nothing is asked while
/// metrics are hidden for the cluster (#327).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_overview_usage(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<OverviewUsageView, String> {
    let mut view = OverviewUsageView {
        samples: Vec::new(),
        source: UsageSource::MetricsServer,
        prometheus: String::new(),
        note: String::new(),
    };
    if metrics_hidden(&cluster, &settings) {
        view.note = HIDDEN_NOTE.into();
        return Ok(view);
    }
    let client = cluster.client().await?;
    let prom = prometheus_for(&cluster, &settings, &client, false).await;
    let Some(target) = prom.target else {
        return Ok(view);
    };
    view.prometheus = target.label();
    match prometheus_cluster_usage(&client, &target, now_ms() / 1000).await {
        Ok(h) if !h.samples.is_empty() => {
            view.samples = h.samples;
            view.source = UsageSource::Prometheus;
        }
        Ok(_) => {
            view.note = format!(
                "Prometheus at {} has no CPU and memory samples of the nodes in the last hour.",
                view.prometheus
            )
        }
        Err(e) => view.note = format!("{e:#}"),
    }
    Ok(view)
}
