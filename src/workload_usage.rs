//! CPU and memory of a whole workload (#79): its pods' usage summed, from
//! the metrics-server history the app keeps or from Prometheus, with its
//! pods' requests and limits summed as reference lines.
//!
//! The pods are the ones the workload's label selector matches now (as for
//! its merged logs). Prometheus ranges go further back than those pods, so
//! there the pods are matched by the names the workload gives them
//! ([`pod_name_pattern`]), which also covers pods replaced by a rollout.

use crate::prometheus::{query_usage, quote, range_step, rate_window};
use crate::usage_history::{SeriesView, UsageSample, MIN_SPACING_MS};
use crate::usage_reference::{pod_reference, UsageReference};
use crate::workload_logs::{workload_selector, WorkloadKind};
use crate::{PrometheusTarget, UsageRange};
use anyhow::Result;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::Client;
use serde_json::Value;
use std::collections::BTreeSet;

/// A pod's sample counts towards a later point for this long, so pods
/// sampled at slightly different times still add up.
pub const HOLD_MS: u64 = 3 * MIN_SPACING_MS;

/// The pods of a workload: what its label selector matches now.
pub async fn workload_pods(
    client: &Client,
    kind: WorkloadKind,
    namespace: &str,
    name: &str,
) -> Result<Vec<Pod>> {
    let selector = workload_selector(client, kind, namespace, name).await?;
    let pods = Api::<Pod>::namespaced(client.clone(), namespace)
        .list(&ListParams::default().labels(&selector))
        .await?;
    Ok(pods.items)
}

/// Whether a pod (as JSON) has finished: its requests no longer count.
fn finished(pod: &Value) -> bool {
    matches!(
        pod.pointer("/status/phase").and_then(Value::as_str),
        Some("Succeeded" | "Failed")
    )
}

/// The requests and limits of a workload: its unfinished pods' summed. A
/// limit is 0 (none) as soon as one pod has none, as for a pod.
pub fn workload_reference(pods: &[Value]) -> UsageReference {
    let mut total = UsageReference::default();
    let mut unbounded = (false, false);
    for pod in pods.iter().filter(|p| !finished(p)) {
        let r = pod_reference(pod);
        total.cpu_request += r.cpu_request;
        total.memory_request += r.memory_request;
        total.cpu_limit += r.cpu_limit;
        total.memory_limit += r.memory_limit;
        unbounded.0 |= r.cpu_limit == 0;
        unbounded.1 |= r.memory_limit == 0;
    }
    if unbounded.0 {
        total.cpu_limit = 0;
    }
    if unbounded.1 {
        total.memory_limit = 0;
    }
    total
}

/// The sum of several pods' series, oldest first. Points fall on a grid of
/// [`MIN_SPACING_MS`] (one per slot any pod has a sample in, at its newest
/// sample there); each pod adds its newest sample up to the end of the slot
/// if it is at most `hold_ms` older, so pods sampled by different polls
/// still add up, and a pod that is gone stops counting.
pub fn sum_series(series: &[&[UsageSample]], hold_ms: u64) -> Vec<UsageSample> {
    let slot = |t: u64| t / MIN_SPACING_MS;
    let mut slots: BTreeSet<u64> = BTreeSet::new();
    let mut newest_in = std::collections::BTreeMap::<u64, u64>::new();
    for s in series.iter().flat_map(|s| s.iter()) {
        slots.insert(slot(s.t));
        let t = newest_in.entry(slot(s.t)).or_insert(s.t);
        *t = (*t).max(s.t);
    }
    slots
        .into_iter()
        .map(|g| {
            let end = (g + 1) * MIN_SPACING_MS - 1;
            let mut out = UsageSample {
                t: newest_in[&g],
                cpu_millicores: 0,
                memory_bytes: 0,
            };
            for samples in series {
                // Sorted by time: the newest one up to the end of the slot.
                let i = samples.partition_point(|s| s.t <= end);
                if let Some(s) = i.checked_sub(1).map(|i| samples[i]) {
                    if end - s.t <= hold_ms {
                        out.cpu_millicores += s.cpu_millicores;
                        out.memory_bytes += s.memory_bytes;
                    }
                }
            }
            out
        })
        .collect()
}

/// The sum of several pods' histories, without per-container lines.
pub fn sum_views(views: &[SeriesView]) -> SeriesView {
    let series: Vec<&[UsageSample]> = views.iter().map(|v| v.samples.as_slice()).collect();
    let samples = sum_series(&series, HOLD_MS);
    SeriesView {
        since: samples.first().map(|s| s.t).unwrap_or(0),
        samples,
        containers: Vec::new(),
    }
}

/// A regex (for PromQL `=~`, which is anchored) of the names a workload
/// gives its pods: `web-<hash>-<id>` for a Deployment, `db-0` for a
/// StatefulSet, `<name>-<id>` for the others.
pub fn pod_name_pattern(kind: WorkloadKind, name: &str) -> String {
    let name = name.replace('.', "\\.");
    match kind {
        WorkloadKind::Deployment => format!("{name}-[a-z0-9]+-[a-z0-9]+"),
        WorkloadKind::StatefulSet => format!("{name}-[0-9]+"),
        WorkloadKind::DaemonSet | WorkloadKind::ReplicaSet | WorkloadKind::Job => {
            format!("{name}-[a-z0-9]+")
        }
    }
}

/// CPU (cores) and memory (bytes) queries of a workload's pods, summed.
pub fn workload_queries(
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
    step: u64,
) -> (String, String) {
    let sel = format!(
        "namespace={},pod=~{},container!=\"\",container!=\"POD\"",
        quote(namespace),
        quote(&pod_name_pattern(kind, name))
    );
    let cpu = format!(
        "sum(rate(container_cpu_usage_seconds_total{{{sel}}}[{}]))",
        rate_window(step)
    );
    let memory = format!("sum(container_memory_working_set_bytes{{{sel}}})");
    (cpu, memory)
}

/// A workload's summed CPU and memory history from Prometheus over `range`,
/// ending at `now_secs`.
pub async fn prometheus_workload_usage(
    client: &Client,
    target: &PrometheusTarget,
    kind: WorkloadKind,
    namespace: &str,
    name: &str,
    range: UsageRange,
    now_secs: u64,
) -> Result<SeriesView> {
    let (cpu, memory) = workload_queries(namespace, kind, name, range_step(range)?);
    query_usage(client, target, (&cpu, &memory), range, now_secs, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MI: u64 = 1024 * 1024;

    fn s(t: u64, cpu: u64, mem: u64) -> UsageSample {
        UsageSample {
            t,
            cpu_millicores: cpu,
            memory_bytes: mem,
        }
    }

    #[test]
    fn pods_sampled_together_add_up() {
        let a = [s(100_000, 10, 1), s(120_000, 20, 2)];
        let b = [s(100_000, 5, 10), s(120_000, 5, 20)];
        assert_eq!(
            sum_series(&[&a, &b], HOLD_MS),
            vec![s(100_000, 15, 11), s(120_000, 25, 22)]
        );
    }

    #[test]
    fn pods_sampled_apart_are_held_and_gone_pods_stop() {
        // b was sampled 5 s after a by another poll; c ended at 100 s.
        let a = [s(100_000, 10, 0), s(120_000, 10, 0), s(160_000, 10, 0)];
        let b = [s(105_000, 1, 0), s(125_000, 1, 0)];
        let c = [s(100_000, 100, 0)];
        let sum = sum_series(&[&a, &b, &c], HOLD_MS);
        let cpu: Vec<(u64, u64)> = sum.iter().map(|p| (p.t, p.cpu_millicores)).collect();
        assert_eq!(
            cpu,
            vec![
                (105_000, 10 + 1 + 100),
                (125_000, 10 + 1 + 100),
                // c is more than 30 s old by now, b too.
                (160_000, 10),
            ]
        );
        assert!(sum_series(&[], HOLD_MS).is_empty());
        let view = sum_views(&[SeriesView {
            since: 1,
            samples: a.to_vec(),
            containers: Vec::new(),
        }]);
        assert_eq!(view.since, 100_000);
        assert_eq!(view.samples.len(), 3);
    }

    #[test]
    fn reference_sums_unfinished_pods() {
        let pod = |phase: &str, limit: bool| {
            let mut res = json!({ "requests": { "cpu": "100m", "memory": "64Mi" } });
            if limit {
                res["limits"] = json!({ "cpu": "200m", "memory": "128Mi" });
            }
            json!({ "spec": { "containers": [{ "name": "c", "resources": res }] },
                    "status": { "phase": phase } })
        };
        let r = workload_reference(&[
            pod("Running", true),
            pod("Pending", true),
            pod("Succeeded", false),
        ]);
        assert_eq!(r.cpu_request, 200);
        assert_eq!(r.memory_request, 128 * MI);
        assert_eq!(r.cpu_limit, 400);
        assert_eq!(r.memory_limit, 256 * MI);
        // One running pod without a limit: the workload has none.
        let r = workload_reference(&[pod("Running", true), pod("Running", false)]);
        assert_eq!((r.cpu_limit, r.memory_limit), (0, 0));
        assert_eq!(r.cpu_request, 200);
    }

    #[test]
    fn queries_match_the_pods_by_name() {
        assert_eq!(
            pod_name_pattern(WorkloadKind::Deployment, "web"),
            "web-[a-z0-9]+-[a-z0-9]+"
        );
        assert_eq!(
            pod_name_pattern(WorkloadKind::StatefulSet, "db"),
            "db-[0-9]+"
        );
        assert_eq!(
            pod_name_pattern(WorkloadKind::Job, "a.b"),
            "a\\.b-[a-z0-9]+"
        );
        let (cpu, memory) = workload_queries("demo", WorkloadKind::Deployment, "web", 30);
        assert_eq!(
            cpu,
            "sum(rate(container_cpu_usage_seconds_total{namespace=\"demo\",pod=~\"web-[a-z0-9]+-[a-z0-9]+\",container!=\"\",container!=\"POD\"}[120s]))"
        );
        assert_eq!(
            memory,
            "sum(container_memory_working_set_bytes{namespace=\"demo\",pod=~\"web-[a-z0-9]+-[a-z0-9]+\",container!=\"\",container!=\"POD\"})"
        );
        // A dot is escaped for the regex, then the backslash for PromQL.
        let (_, memory) = workload_queries("demo", WorkloadKind::Job, "a.b", 30);
        assert!(memory.contains("pod=~\"a\\\\.b-[a-z0-9]+\""), "{memory}");
    }
}
