//! Usage history (#47): the ring buffers in `ClusterSession::usage`, fed by
//! `cmd_get_metrics` and by the detail panels through `cmd_usage_history`.

use crate::commands::cluster::{metrics_hidden, MetricsKind};
use crate::commands::prometheus::prometheus_for;
use crate::settings::SettingsStore;
use crate::state::{Cluster, ClusterSession};
use nauvi::{
    get_one_node_metrics, get_one_pod_metrics, get_usage_reference, pod_key, prometheus_usage,
    NodeUsage, PodUsage, SeriesView, Spark, UsageRange, UsageReference, MIN_SPACING_MS,
};
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record what a metrics poll returned and give back the sparklines of those
/// pods or nodes, with when their history starts (0 = none). A session's
/// context never changes, so one cluster's pods never land in another's
/// history.
pub(crate) fn record(
    state: &ClusterSession,
    pods: &[PodUsage],
    nodes: &[NodeUsage],
) -> (HashMap<String, Spark>, u64) {
    let now = now_ms();
    let mut history = state.usage.lock().unwrap();
    if !pods.is_empty() {
        history.record_pods(now, pods);
        let keys: Vec<String> = pods
            .iter()
            .map(|p| pod_key(&p.namespace, &p.name))
            .collect();
        let since = history.since(true, keys.iter().map(String::as_str));
        (history.pod_sparks(pods), since)
    } else if !nodes.is_empty() {
        history.record_nodes(now, nodes);
        let since = history.since(false, nodes.iter().map(|n| n.name.as_str()));
        (history.node_sparks(nodes), since)
    } else {
        (HashMap::new(), 0)
    }
}

/// Where a chart's samples come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UsageSource {
    /// The history the app collects from metrics-server.
    MetricsServer,
    Prometheus,
}

#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct UsageHistoryView {
    pub(crate) history: SeriesView,
    pub(crate) reference: UsageReference,
    pub(crate) source: UsageSource,
    /// The range shown: the one asked for, or `live` after a fallback.
    pub(crate) range: UsageRange,
    /// The Prometheus of this context (`namespace/service:port`), or "".
    pub(crate) prometheus: String,
    /// Why Prometheus was not used for a range that asked for it ("" when it
    /// was, or for `live`).
    pub(crate) note: String,
}

/// The note of what the panels get while metrics are hidden (#327).
pub(crate) const HIDDEN_NOTE: &str = "Metrics are hidden for this cluster.";

impl UsageHistoryView {
    /// No samples, no reference, nothing asked of the cluster (#327).
    pub(crate) fn hidden() -> Self {
        Self {
            history: SeriesView::default(),
            reference: UsageReference::default(),
            source: UsageSource::MetricsServer,
            range: UsageRange::Live,
            prometheus: String::new(),
            note: HIDDEN_NOTE.into(),
        }
    }
}

/// The usage history of one pod (`namespace` set) or node, for the charts in
/// its detail panel, with its requests and limits or allocatable. Polled
/// while the panel is open: when no table has sampled the object lately, it
/// samples it itself, so history keeps growing with only the panel open.
///
/// A `range` other than `live` asks Prometheus (#47 phase 2). Without one,
/// or when the query fails, it is the metrics-server history with a `note`
/// saying why.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_usage_history(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    what: MetricsKind,
    namespace: Option<String>,
    name: String,
    range: UsageRange,
) -> Result<UsageHistoryView, String> {
    if metrics_hidden(&cluster, &settings) {
        // Hidden for this cluster (#327): nothing is sampled or asked.
        return Ok(UsageHistoryView::hidden());
    }
    let client = cluster.client().await?;
    let pod = matches!(what, MetricsKind::Pods);
    let ns = if pod { namespace.as_deref() } else { None };
    if pod && ns.is_none() {
        return Err("A pod's usage history needs its namespace".into());
    }
    let key = match ns {
        Some(ns) => pod_key(ns, &name),
        None => name.clone(),
    };
    let last = cluster.usage.lock().unwrap().last_sample(pod, &key);
    if last.is_none_or(|t| now_ms() >= t + MIN_SPACING_MS) {
        // Best effort, like the table metrics: no sample yet is fine.
        match ns {
            Some(ns) => {
                if let Ok(Some(u)) = get_one_pod_metrics(&client, ns, &name).await {
                    record(&cluster, &[u], &[]);
                }
            }
            None => {
                if let Ok(Some(u)) = get_one_node_metrics(&client, &name).await {
                    record(&cluster, &[], &[u]);
                }
            }
        }
    }
    // Without access to the object the chart just has no reference lines.
    let reference = get_usage_reference(&client, ns, &name)
        .await
        .unwrap_or_default();
    let prom = prometheus_for(&cluster, &settings, &client, false).await;
    let prometheus = prom.target.as_ref().map(|t| t.label()).unwrap_or_default();
    let mut note = String::new();
    if range != UsageRange::Live {
        match &prom.target {
            None => note = prom.note.clone(),
            Some(target) => {
                let now = now_ms() / 1000;
                match prometheus_usage(&client, target, ns, &name, range, now).await {
                    Ok(history) if !history.samples.is_empty() => {
                        return Ok(UsageHistoryView {
                            history,
                            reference,
                            source: UsageSource::Prometheus,
                            range,
                            prometheus,
                            note,
                        });
                    }
                    Ok(_) => {
                        note = format!(
                            "Prometheus at {prometheus} has no CPU and memory samples for this {} in the last {}.",
                            if pod { "pod" } else { "node" },
                            range.label()
                        )
                    }
                    Err(e) => note = format!("{e:#}"),
                }
            }
        }
    }
    let history = cluster.usage.lock().unwrap().view(pod, &key);
    Ok(UsageHistoryView {
        history,
        reference,
        source: UsageSource::MetricsServer,
        range: UsageRange::Live,
        prometheus,
        note,
    })
}
