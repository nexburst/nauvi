//! The running images to scan with a local scanner (#536), and the local
//! scanner's results on the rows of a listing.
//!
//! Without the Trivy Operator (or with the local scanner as the only
//! source) the listing is the pods' images, unscanned; [`overlay`] puts
//! the cached local scans on them.

use super::cache::CachedScan;
use super::images::pod_images;
use super::local::check_platform;
use super::report::{
    aggregate, api_error, check_namespace, filter_vulnerabilities, fix_groups, is_forbidden,
    sort_rows, MAX_PODS,
};
use super::{ImageDetail, ImageVulns, ScanSource, VulnsArgs, VulnsState, VulnsSummary};
use crate::bounded_list::list_bounded;
use anyhow::{bail, Result};
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, ListParams};
use kube::Client;
use std::collections::{BTreeMap, BTreeSet};

/// Most nodes read to find an image's platform.
const MAX_NODES: usize = 2000;

/// The images the pods of `namespaces` (none: all) run, each unscanned,
/// for the local scanner. Namespaces where the pods may not be listed are
/// named in `forbidden_namespaces`; when that is all of them it fails.
pub async fn running_images(client: &Client, namespaces: &[String]) -> Result<VulnsSummary> {
    let mut list: Vec<String> = Vec::new();
    for ns in namespaces.iter().filter(|n| !n.is_empty()) {
        check_namespace(ns)?;
        if !list.contains(ns) {
            list.push(ns.clone());
        }
    }
    let scopes: Vec<Option<String>> = if list.is_empty() {
        vec![None]
    } else {
        list.iter().cloned().map(Some).collect()
    };
    let mut out = VulnsSummary {
        source: ScanSource::LocalScanner,
        state: VulnsState::Ok,
        namespace: match list.as_slice() {
            [one] => one.clone(),
            _ => String::new(),
        },
        namespaces_read: Vec::new(),
        images: Vec::new(),
        forbidden_namespaces: Vec::new(),
        all_namespaces_allowed: false,
        unscanned: 0,
        notes: Vec::new(),
    };
    let mut pods: Vec<Pod> = Vec::new();
    let mut left = MAX_PODS;
    let mut cut = false;
    for scope in &scopes {
        if left == 0 {
            cut = true;
            break;
        }
        let api: Api<Pod> = match scope {
            Some(ns) => Api::namespaced(client.clone(), ns),
            None => Api::all(client.clone()),
        };
        match list_bounded(&api, &ListParams::default(), left).await {
            Ok(b) => {
                cut |= b.more;
                left -= b.items.len().min(left);
                pods.extend(b.items);
            }
            Err(e) if is_forbidden(&e) => {
                out.forbidden_namespaces
                    .push(scope.clone().unwrap_or_default());
            }
            Err(e) => return Err(api_error("the pods", e)),
        }
    }
    if out.forbidden_namespaces.len() == scopes.len() {
        let place = match list.as_slice() {
            [] => "any namespace".to_string(),
            [one] => format!("namespace {one}"),
            many => format!("namespaces {}", many.join(", ")),
        };
        bail!("You are not allowed to list pods in {place}, so nauvi does not know which images run there.");
    }
    out.forbidden_namespaces.retain(|n| !n.is_empty());
    if !out.forbidden_namespaces.is_empty() {
        out.notes.push(format!(
            "Not allowed to list pods in {}: their images are not listed.",
            out.forbidden_namespaces.join(", ")
        ));
    }
    if cut {
        out.notes.push(format!(
            "Only the first {MAX_PODS} pods were read; pick fewer namespaces."
        ));
    }
    if list.len() > 1 {
        out.namespaces_read = list
            .iter()
            .filter(|n| !out.forbidden_namespaces.contains(n))
            .cloned()
            .collect();
    }
    let mut rows = aggregate(&pod_images(&pods), &[]);
    for r in &mut rows {
        r.source = ScanSource::LocalScanner;
    }
    out.unscanned = rows.len() as u32;
    out.images = rows;
    Ok(out)
}

/// Put `scan` on `row`: its counts, scanner and time.
pub fn apply_scan(row: &mut ImageVulns, scan: &CachedScan) {
    let (counts, fixable) = scan.counts();
    row.source = ScanSource::LocalScanner;
    row.scanned = true;
    row.counts = counts;
    row.fixable = fixable;
    row.scanner = scan.scanner_text();
    row.scanned_at = scan.scanned_at;
    row.report_namespace.clear();
    row.report_name.clear();
}

/// The local scans `lookup` finds (by digest) on the running rows of
/// `summary` without a report, then the rows sorted again and
/// `unscanned` counted again.
pub fn overlay(summary: &mut VulnsSummary, lookup: impl Fn(&str) -> Option<CachedScan>) {
    for row in &mut summary.images {
        if row.scanned || !row.running || row.digest.is_empty() {
            continue;
        }
        if let Some(scan) = lookup(&row.digest) {
            apply_scan(row, &scan);
        }
    }
    sort_rows(&mut summary.images);
    summary.unscanned = summary.images.iter().filter(|r| !r.scanned).count() as u32;
    // A scan here is something to show, whatever the operator had.
    if summary.state == VulnsState::NoReports && summary.unscanned < summary.images.len() as u32 {
        summary.state = VulnsState::Ok;
    }
}

/// `row` with the vulnerabilities and fixes of `scan` after `args`'
/// filters.
pub fn detail_of_scan(mut row: ImageVulns, scan: &CachedScan, args: &VulnsArgs) -> ImageDetail {
    apply_scan(&mut row, scan);
    let vulnerabilities = filter_vulnerabilities(scan.vulnerabilities(), args);
    let fix_groups = fix_groups(&vulnerabilities);
    ImageDetail {
        image: row,
        vulnerabilities,
        fix_groups,
    }
}

fn node_platform(n: &Node) -> String {
    let Some(info) = n.status.as_ref().and_then(|s| s.node_info.as_ref()) else {
        return String::new();
    };
    let p = format!(
        "{}/{}",
        info.operating_system.to_ascii_lowercase(),
        info.architecture.to_ascii_lowercase()
    );
    if check_platform(&p).is_ok() {
        p
    } else {
        String::new()
    }
}

/// The platform (`linux/amd64`) the nodes run `row`'s image on: the one of
/// every node when they all share it, else the node of a pod that runs its
/// digest. Empty when it cannot be told (nodes not readable): the scanner
/// then picks its default.
pub async fn platform_of(client: &Client, row: &ImageVulns) -> String {
    let nodes: Api<Node> = Api::all(client.clone());
    let Ok(list) = list_bounded(&nodes, &ListParams::default(), MAX_NODES).await else {
        return String::new();
    };
    let by_node: BTreeMap<String, String> = list
        .items
        .iter()
        .map(|n| {
            (
                n.metadata.name.clone().unwrap_or_default(),
                node_platform(n),
            )
        })
        .filter(|(_, p)| !p.is_empty())
        .collect();
    let distinct: BTreeSet<&String> = by_node.values().collect();
    if distinct.len() == 1 {
        return distinct.into_iter().next().cloned().unwrap_or_default();
    }
    if row.digest.is_empty() {
        return String::new();
    }
    let namespaces: BTreeSet<&str> = row
        .workloads
        .iter()
        .map(|w| w.namespace.as_str())
        .take(5)
        .collect();
    for ns in namespaces {
        let api: Api<Pod> = Api::namespaced(client.clone(), ns);
        let Ok(pods) = list_bounded(&api, &ListParams::default(), 500).await else {
            continue;
        };
        for pod in &pods.items {
            let runs = pod
                .status
                .as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .is_some_and(|cs| cs.iter().any(|c| c.image_id.ends_with(&row.digest)));
            let node = pod.spec.as_ref().and_then(|s| s.node_name.as_ref());
            if let (true, Some(p)) = (runs, node.and_then(|n| by_node.get(n))) {
                return p.clone();
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_security::local::ScannerKind;
    use crate::image_security::{Severity, SeverityCounts, Vulnerability, Workload};

    fn row(image: &str, digest: &str, scanned: bool) -> ImageVulns {
        ImageVulns {
            source: ScanSource::TrivyOperator,
            image: image.into(),
            digest: digest.into(),
            running: true,
            scanned,
            counts: SeverityCounts::default(),
            fixable: SeverityCounts::default(),
            workloads: vec![Workload {
                kind: "Deployment".into(),
                namespace: "a".into(),
                name: "web".into(),
                container: "app".into(),
            }],
            report_namespace: String::new(),
            report_name: String::new(),
            reports: 0,
            scanner: String::new(),
            scanned_at: 0,
        }
    }

    fn scan(digest: &str) -> CachedScan {
        let v = |id: &str, s, fixed: &str| Vulnerability {
            id: id.into(),
            package: "openssl".into(),
            installed_version: "1".into(),
            fixed_version: fixed.into(),
            severity: s,
            score: 0.0,
            title: String::new(),
            link: String::new(),
        };
        CachedScan::new(
            ScannerKind::Trivy,
            "0.58.1",
            "db",
            "linux/amd64",
            digest,
            "r",
            50,
            &[
                v("CVE-1", Severity::Critical, "2"),
                v("CVE-2", Severity::Low, ""),
            ],
        )
    }

    #[test]
    fn overlay_fills_only_running_rows_without_a_report() {
        let d1 = format!("sha256:{}", "1".repeat(64));
        let d2 = format!("sha256:{}", "2".repeat(64));
        let mut summary = VulnsSummary {
            source: ScanSource::TrivyOperator,
            state: VulnsState::NoReports,
            namespace: String::new(),
            namespaces_read: vec![],
            images: vec![
                row("a:1", &d1, false),
                row("b:1", &d2, true),
                row("c:1", "", false),
            ],
            forbidden_namespaces: vec![],
            all_namespaces_allowed: false,
            unscanned: 2,
            notes: vec![],
        };
        overlay(&mut summary, |d| Some(scan(d)));
        let a = summary.images.iter().find(|r| r.image == "a:1").unwrap();
        assert!(a.scanned);
        assert_eq!(a.source, ScanSource::LocalScanner);
        assert_eq!(a.counts.critical, 1);
        assert_eq!(a.fixable.critical, 1);
        assert_eq!(a.fixable.low, 0);
        assert_eq!(a.scanner, "Trivy 0.58.1");
        assert_eq!(a.scanned_at, 50);
        // The operator's row is left alone; a row without a digest too.
        let b = summary.images.iter().find(|r| r.image == "b:1").unwrap();
        assert_eq!(b.source, ScanSource::TrivyOperator);
        assert!(
            !summary
                .images
                .iter()
                .find(|r| r.image == "c:1")
                .unwrap()
                .scanned
        );
        assert_eq!(summary.unscanned, 1);
        assert_eq!(summary.state, VulnsState::Ok);
        assert_eq!(summary.images[0].image, "a:1", "worst first");
    }

    #[test]
    fn detail_of_a_scan_is_filtered() {
        let d = format!("sha256:{}", "1".repeat(64));
        let args = VulnsArgs {
            severity: Some(Severity::High),
            ..Default::default()
        };
        let detail = detail_of_scan(row("a:1", &d, false), &scan(&d), &args);
        assert_eq!(detail.vulnerabilities.len(), 1);
        assert_eq!(detail.fix_groups.len(), 1);
        assert_eq!(detail.image.counts.low, 1, "the row counts everything");
    }
}
