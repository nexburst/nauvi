//! Disk use of each node's root filesystem from Prometheus (#225): the
//! node-exporter metrics `node_filesystem_size_bytes` and
//! `node_filesystem_avail_bytes` for `mountpoint="/"`, read like the usage
//! charts through the API server's service proxy. Without node-exporter
//! the queries return nothing and the Nodes table shows no Disk column.

use crate::{query_range, PromSeries, PrometheusTarget};
use anyhow::{anyhow, Result};
use kube::Client;
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;

/// How long the Disk column waits for Prometheus.
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// The root filesystem of one node.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NodeDisk {
    /// The node name.
    pub name: String,
    pub used_bytes: u64,
    pub size_bytes: u64,
}

/// Size and free space of `/`, per node. The node is the `node` label (the
/// prometheus-community chart) or `instance` (kube-prometheus, which sets
/// it to the node name).
pub fn node_disk_queries() -> (String, String) {
    let sel = r#"{mountpoint="/",fstype!="rootfs"}"#;
    (
        format!("max by (node, instance) (node_filesystem_size_bytes{sel})"),
        format!("max by (node, instance) (node_filesystem_avail_bytes{sel})"),
    )
}

/// The node a series is about: its `node` label, else `instance` without
/// a port.
fn node_of(labels: &BTreeMap<String, String>) -> Option<String> {
    if let Some(n) = labels.get("node").filter(|n| !n.is_empty()) {
        return Some(n.clone());
    }
    let inst = labels.get("instance")?;
    let host = match inst.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => inst.as_str(),
    };
    (!host.is_empty()).then(|| host.to_string())
}

fn latest(series: &[PromSeries]) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for s in series {
        if let (Some(node), Some((_, v))) = (node_of(&s.labels), s.points.last()) {
            out.insert(node, *v);
        }
    }
    out
}

/// Pair the size and free-space results by node.
pub fn to_node_disks(size: &[PromSeries], avail: &[PromSeries]) -> Vec<NodeDisk> {
    let avail = latest(avail);
    latest(size)
        .into_iter()
        .filter(|(_, size)| *size > 0.0)
        .filter_map(|(name, size)| {
            let free = *avail.get(&name)?;
            Some(NodeDisk {
                name,
                used_bytes: (size - free).max(0.0) as u64,
                size_bytes: size as u64,
            })
        })
        .collect()
}

/// The disk use of every node node-exporter reports, as of `now_secs`.
pub async fn prometheus_node_disks(
    client: &Client,
    target: &PrometheusTarget,
    now_secs: u64,
) -> Result<Vec<NodeDisk>> {
    let (size_q, avail_q) = node_disk_queries();
    // A range of one point: the parser and errors of the usage charts.
    let both = async {
        tokio::try_join!(
            query_range(client, target, &size_q, now_secs, now_secs, 60),
            query_range(client, target, &avail_q, now_secs, now_secs, 60),
        )
    };
    let (size, avail) = tokio::time::timeout(QUERY_TIMEOUT, both)
        .await
        .map_err(|_| {
            anyhow!(
                "Prometheus at {} did not answer within {} s",
                target.label(),
                QUERY_TIMEOUT.as_secs()
            )
        })??;
    Ok(to_node_disks(&size, &avail))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(labels: &[(&str, &str)], v: f64) -> PromSeries {
        PromSeries {
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            points: vec![(1_000, v)],
        }
    }

    #[test]
    fn pairs_size_and_free_space_by_node() {
        let size = [
            series(&[("node", "kind-control-plane"), ("instance", "10.0.0.5:9100")], 100.0),
            series(&[("instance", "worker-1")], 50.0),
            series(&[("instance", "worker-2:9100")], 0.0),
            series(&[("instance", "lonely:9100")], 10.0),
        ];
        let avail = [
            series(&[("node", "kind-control-plane"), ("instance", "10.0.0.5:9100")], 40.0),
            series(&[("instance", "worker-1")], 60.0),
            series(&[("instance", "worker-2:9100")], 0.0),
        ];
        let disks = to_node_disks(&size, &avail);
        assert_eq!(
            disks,
            [
                NodeDisk {
                    name: "kind-control-plane".into(),
                    used_bytes: 60,
                    size_bytes: 100
                },
                NodeDisk {
                    name: "worker-1".into(),
                    used_bytes: 0,
                    size_bytes: 50
                },
            ]
        );
    }

    #[test]
    fn queries_read_the_root_filesystem() {
        let (size, avail) = node_disk_queries();
        assert!(size.contains(r#"node_filesystem_size_bytes{mountpoint="/""#));
        assert!(avail.contains("node_filesystem_avail_bytes"));
        assert!(size.starts_with("max by (node, instance)"));
    }
}
