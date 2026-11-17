//! The CPU and memory use of the whole cluster over the last hour from
//! Prometheus (#328), for the overview's chart: the nodes' root cgroups
//! summed, read like the node charts through the API server's service proxy.

use crate::prometheus::{query_usage, range_step, rate_window};
use crate::{PrometheusTarget, SeriesView, UsageRange};
use anyhow::Result;
use kube::Client;

/// How far back the overview's chart goes.
pub const CLUSTER_USAGE_RANGE: UsageRange = UsageRange::Hour;

/// CPU (cores) and memory (bytes) of all nodes' root cgroups (`id="/"`), as
/// [`crate::node_queries`] reads one node. `max by (node, instance)` first, so
/// a node scraped by two jobs counts once.
pub fn cluster_queries(step: u64) -> (String, String) {
    let w = rate_window(step);
    let cpu = format!(
        "sum(max by (node, instance) (rate(container_cpu_usage_seconds_total{{id=\"/\"}}[{w}])))"
    );
    let memory =
        "sum(max by (node, instance) (container_memory_working_set_bytes{id=\"/\"}))".to_string();
    (cpu, memory)
}

/// The cluster's CPU and memory use over the last hour, ending at
/// `now_secs`; no samples if Prometheus has none.
pub async fn prometheus_cluster_usage(
    client: &Client,
    target: &PrometheusTarget,
    now_secs: u64,
) -> Result<SeriesView> {
    let (cpu, memory) = cluster_queries(range_step(CLUSTER_USAGE_RANGE)?);
    query_usage(
        client,
        target,
        (&cpu, &memory),
        CLUSTER_USAGE_RANGE,
        now_secs,
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{parse_query_range, to_series_view};

    #[test]
    fn queries_sum_the_nodes_root_cgroups() {
        let (cpu, memory) = cluster_queries(30);
        assert_eq!(
            cpu,
            "sum(max by (node, instance) (rate(container_cpu_usage_seconds_total{id=\"/\"}[120s])))"
        );
        assert_eq!(
            memory,
            "sum(max by (node, instance) (container_memory_working_set_bytes{id=\"/\"}))"
        );
        assert_eq!(CLUSTER_USAGE_RANGE.span(), Some((3600, 30)));
    }

    #[test]
    fn a_summed_result_becomes_one_series() {
        let body = |v: &str| {
            format!(
                r#"{{"status":"success","data":{{"resultType":"matrix","result":[
                    {{"metric":{{}},"values":[[1800000000,"{v}"],[1800000030,"{v}"]]}}]}}}}"#
            )
        };
        let cpu = parse_query_range(&body("1.25")).unwrap();
        let memory = parse_query_range(&body("2147483648")).unwrap();
        let view = to_series_view(&cpu, &memory, false);
        assert_eq!(view.samples.len(), 2);
        assert_eq!(view.samples[0].t, 1_800_000_000_000);
        assert_eq!(view.samples[0].cpu_millicores, 1250);
        assert_eq!(view.samples[1].memory_bytes, 2 << 30);
        assert!(view.containers.is_empty());
    }
}
