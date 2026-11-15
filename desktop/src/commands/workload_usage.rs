//! CPU and memory charts of a whole workload (#79): its pods' usage summed,
//! from the metrics-server history (`usage.rs`) or Prometheus.

use crate::commands::prometheus::prometheus_for;
use crate::commands::usage::{now_ms, record, UsageHistoryView, UsageSource};
use crate::settings::SettingsStore;
use crate::state::Cluster;
use kubeloupe::workload_logs::WorkloadKind;
use kubeloupe::{
    get_pod_metrics, pod_key, prometheus_workload_usage, sum_views, workload_pods,
    workload_reference, UsageRange, MIN_SPACING_MS,
};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

/// The summed usage history of a workload's pods (`kind` is Deployment,
/// StatefulSet, DaemonSet, ReplicaSet or Job), for the charts in its detail
/// panel, with their summed requests and limits. Polled while the panel is
/// open; it samples the pods itself when no table did lately.
///
/// A `range` other than `live` asks Prometheus, as `cmd_usage_history`
/// does, and falls back to the metrics-server history with a `note`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_workload_usage_history(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    kind: String,
    namespace: String,
    name: String,
    range: UsageRange,
) -> Result<UsageHistoryView, String> {
    let ctx = cluster.selected_context();
    let client = cluster.client().await?;
    let workload: WorkloadKind = kind.parse().map_err(|e| format!("{e:#}"))?;
    let pods = workload_pods(&client, workload, &namespace, &name)
        .await
        .map_err(|e| format!("Could not find the pods of {kind} {namespace}/{name}: {e:#}"))?;
    let keys: Vec<String> = pods
        .iter()
        .filter_map(|p| Some(pod_key(&namespace, p.metadata.name.as_deref()?)))
        .collect();

    let stale = {
        let history = cluster.usage.lock().unwrap();
        keys.iter().any(|k| {
            history
                .last_sample(true, k)
                .is_none_or(|t| now_ms() >= t + MIN_SPACING_MS)
        })
    };
    if stale && !keys.is_empty() {
        // One list of the namespace's pod metrics; best effort, like the
        // table metrics.
        if let Ok(Some(usage)) = get_pod_metrics(&client, Some(&namespace)).await {
            let wanted: HashSet<&String> = keys.iter().collect();
            let ours: Vec<_> = usage
                .into_iter()
                .filter(|u| wanted.contains(&pod_key(&u.namespace, &u.name)))
                .collect();
            if !ours.is_empty() {
                record(&cluster, &ctx, &ours, &[]);
            }
        }
    }

    let values: Vec<serde_json::Value> = pods
        .iter()
        .filter_map(|p| serde_json::to_value(p).ok())
        .collect();
    let reference = workload_reference(&values);
    let prom = prometheus_for(&cluster, &settings, &client, false).await;
    let prometheus = prom.target.as_ref().map(|t| t.label()).unwrap_or_default();
    let mut note = String::new();
    if range != UsageRange::Live {
        match &prom.target {
            None => note = prom.note.clone(),
            Some(target) => {
                let now = now_ms() / 1000;
                match prometheus_workload_usage(
                    &client, target, workload, &namespace, &name, range, now,
                )
                .await
                {
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
                            "Prometheus at {prometheus} has no CPU and memory samples for the pods of this {} in the last {}.",
                            workload.as_str(),
                            range.label()
                        )
                    }
                    Err(e) => note = format!("{e:#}"),
                }
            }
        }
    }
    let history = {
        let history = cluster.usage.lock().unwrap();
        let views: Vec<_> = keys.iter().map(|k| history.view(true, k)).collect();
        sum_views(&views)
    };
    Ok(UsageHistoryView {
        history,
        reference,
        source: UsageSource::MetricsServer,
        range: UsageRange::Live,
        prometheus,
        note,
    })
}
