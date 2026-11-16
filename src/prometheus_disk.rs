//! Disk use of each node from Prometheus (#225): the node-exporter metrics
//! `node_filesystem_size_bytes` and `node_filesystem_avail_bytes` of the
//! filesystem that holds the kubelet's data (`/var/lib/kubelet`: `/` on most
//! nodes, `/var` where it is a separate volume, as on kind), read like the
//! usage charts through the API server's service proxy. Without
//! node-exporter the queries return nothing and the Nodes table shows no
//! Disk column.

use crate::{query_range, PromSeries, PrometheusTarget};
use anyhow::{anyhow, Result};
use kube::Client;
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Duration;

/// How long the Disk column waits for Prometheus.
const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// Where the kubelet keeps pods' data; the Disk column shows the
/// filesystem it is on.
const KUBELET_DIR: &str = "/var/lib/kubelet";

/// The filesystem of one node that holds the kubelet's data.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NodeDisk {
    /// The node name.
    pub name: String,
    /// Where it is mounted (`/`, `/var`, ...).
    pub mountpoint: String,
    pub used_bytes: u64,
    pub size_bytes: u64,
}

/// Size and free space of the mounts that can hold `/var/lib/kubelet`, per
/// node and mount. The node is the `node` label (the prometheus-community
/// chart) or `instance` (kube-prometheus, which sets it to the node name).
/// The fstype is not filtered: node-exporter already leaves out pseudo
/// filesystems (and, by default, overlay, which kind's `/` is).
pub fn node_disk_queries() -> (String, String) {
    let sel = r#"{mountpoint=~"/|/var|/var/lib|/var/lib/kubelet"}"#;
    (
        format!("max by (node, instance, mountpoint) (node_filesystem_size_bytes{sel})"),
        format!("max by (node, instance, mountpoint) (node_filesystem_avail_bytes{sel})"),
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

/// Whether `/var/lib/kubelet` lies under `mountpoint`.
fn holds_kubelet(mountpoint: &str) -> bool {
    if mountpoint.is_empty() {
        return false;
    }
    mountpoint == "/"
        || KUBELET_DIR == mountpoint
        || KUBELET_DIR.starts_with(&format!("{mountpoint}/"))
}

/// The latest value per (node, mountpoint).
fn latest(series: &[PromSeries]) -> BTreeMap<(String, String), f64> {
    let mut out = BTreeMap::new();
    for s in series {
        let mount = s.labels.get("mountpoint").cloned().unwrap_or_default();
        if let (Some(node), Some((_, v))) = (node_of(&s.labels), s.points.last()) {
            out.insert((node, mount), *v);
        }
    }
    out
}

/// Pair the size and free-space results, and keep per node the deepest
/// mount that holds `/var/lib/kubelet`.
pub fn to_node_disks(size: &[PromSeries], avail: &[PromSeries]) -> Vec<NodeDisk> {
    let avail = latest(avail);
    let mut best: BTreeMap<String, NodeDisk> = BTreeMap::new();
    for ((name, mount), size) in latest(size) {
        if size <= 0.0 || !holds_kubelet(&mount) {
            continue;
        }
        let Some(free) = avail.get(&(name.clone(), mount.clone())) else {
            continue;
        };
        let deeper = best
            .get(&name)
            .is_none_or(|d| mount.len() > d.mountpoint.len());
        if deeper {
            best.insert(
                name.clone(),
                NodeDisk {
                    name,
                    mountpoint: mount,
                    used_bytes: (size - free).max(0.0) as u64,
                    size_bytes: size as u64,
                },
            );
        }
    }
    best.into_values().collect()
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
        let cp = [
            ("node", "kind-control-plane"),
            ("instance", "10.0.0.5:9100"),
        ];
        let at = |labels: &[(&str, &str)], mount: &'static str, v: f64| {
            let mut l = labels.to_vec();
            l.push(("mountpoint", mount));
            series(&l, v)
        };
        let size = [
            // kind: `/` is overlay (left out by node-exporter), `/var` a volume.
            at(&cp, "/var", 100.0),
            at(&[("instance", "worker-1")], "/", 50.0),
            at(&[("instance", "worker-2:9100")], "/", 0.0),
            at(&[("instance", "lonely:9100")], "/", 10.0),
            // A separate /var/lib/kubelet wins over `/`.
            at(&[("instance", "big")], "/", 10.0),
            at(&[("instance", "big")], "/var/lib/kubelet", 200.0),
        ];
        let avail = [
            at(&cp, "/var", 40.0),
            at(&[("instance", "worker-1")], "/", 60.0),
            at(&[("instance", "worker-2:9100")], "/", 0.0),
            at(&[("instance", "big")], "/", 5.0),
            at(&[("instance", "big")], "/var/lib/kubelet", 50.0),
        ];
        let disks = to_node_disks(&size, &avail);
        let got: Vec<_> = disks
            .iter()
            .map(|d| {
                (
                    d.name.as_str(),
                    d.mountpoint.as_str(),
                    d.used_bytes,
                    d.size_bytes,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("big", "/var/lib/kubelet", 150, 200),
                ("kind-control-plane", "/var", 60, 100),
                ("worker-1", "/", 0, 50),
            ]
        );
    }

    #[test]
    fn only_mounts_that_hold_the_kubelet_count() {
        for m in ["/", "/var", "/var/lib", "/var/lib/kubelet"] {
            assert!(holds_kubelet(m), "{m}");
        }
        for m in [
            "/v",
            "/var/lib/kube",
            "/boot",
            "/var/lib/kubelet/pods/x",
            "",
        ] {
            assert!(!holds_kubelet(m), "{m}");
        }
        let (size, avail) = node_disk_queries();
        assert!(size.contains("node_filesystem_size_bytes{mountpoint=~"));
        assert!(avail.contains("node_filesystem_avail_bytes"));
        assert!(size.starts_with("max by (node, instance, mountpoint)"));
    }
}
