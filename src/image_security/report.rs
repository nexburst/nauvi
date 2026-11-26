//! One row per image from the running pods and the reports, the filters,
//! and a report's fixes grouped by package.

use super::images::{normalize, pod_images, short_reference, RunningImage};
use super::trivy_operator::{self as trivy, Access, ReportSummary};
use super::{
    FixGroup, ImageDetail, ImageVulns, Severity, SeverityCounts, Vulnerability, VulnsArgs,
    VulnsState, VulnsSummary, Workload,
};
use crate::bounded_list::list_bounded;
use anyhow::{bail, Result};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::Client;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Most pods one listing reads.
pub const MAX_PODS: usize = 5000;

fn empty_row(image: String, digest: String) -> ImageVulns {
    ImageVulns {
        image,
        digest,
        scanned: false,
        counts: SeverityCounts::default(),
        fixable: SeverityCounts::default(),
        workloads: Vec::new(),
        report_namespace: String::new(),
        report_name: String::new(),
        reports: 0,
        scanner: String::new(),
        scanned_at: 0,
    }
}

fn add_workload(row: &mut ImageVulns, w: Workload) {
    if !row.workloads.contains(&w) {
        row.workloads.push(w);
    }
}

/// One row per distinct image: every running image, and every image a
/// report covers. A report joins a running image by digest, else by the
/// workload container it scanned, else by reference; the newest report of
/// an image gives its counts.
pub fn aggregate(running: &[RunningImage], reports: &[ReportSummary]) -> Vec<ImageVulns> {
    let mut rows: Vec<ImageVulns> = Vec::new();
    let mut by_digest: HashMap<String, usize> = HashMap::new();
    let mut by_ref: HashMap<String, Vec<usize>> = HashMap::new();
    // (namespace, owner kind, owner name, container) -> row, and the
    // workload shown for that owner.
    let mut by_owner: HashMap<(String, String, String, String), (usize, Workload)> = HashMap::new();
    for img in running {
        let i = rows.len();
        let mut row = empty_row(img.reference.clone(), img.digest.clone());
        for u in &img.uses {
            add_workload(&mut row, u.workload.clone());
            by_owner.insert(
                (
                    u.workload.namespace.clone(),
                    u.owner_kind.clone(),
                    u.owner_name.clone(),
                    u.workload.container.clone(),
                ),
                (i, u.workload.clone()),
            );
        }
        rows.push(row);
        if !img.digest.is_empty() {
            by_digest.insert(img.digest.clone(), i);
        }
        by_ref.entry(normalize(&img.reference)).or_default().push(i);
    }
    let running_rows = rows.len();
    for r in reports {
        let owner_key = (
            r.owner.namespace.clone(),
            r.owner.kind.clone(),
            r.owner.name.clone(),
            r.owner.container.clone(),
        );
        let owner = by_owner.get(&owner_key).cloned();
        let normalized = normalize(&r.reference);
        let found = (!r.digest.is_empty())
            .then(|| by_digest.get(&r.digest).copied())
            .flatten()
            .or_else(|| owner.as_ref().map(|(i, _)| *i))
            .or_else(|| match by_ref.get(&normalized).map(Vec::as_slice) {
                Some(&[i]) => Some(i),
                _ => None,
            });
        let i = match found {
            Some(i) => i,
            None => {
                let i = rows.len();
                rows.push(empty_row(short_reference(&r.reference), r.digest.clone()));
                if !r.digest.is_empty() {
                    by_digest.insert(r.digest.clone(), i);
                }
                by_ref.entry(normalized).or_default().push(i);
                i
            }
        };
        let row = &mut rows[i];
        // A report's own workload, as the pods show it when one matched
        // (the Deployment, not its ReplicaSet).
        let workload = owner.map_or_else(|| r.owner.clone(), |(_, w)| w);
        if i >= running_rows && !workload.name.is_empty() {
            add_workload(row, workload);
        }
        row.reports += 1;
        if row.digest.is_empty() {
            row.digest = r.digest.clone();
        }
        if !row.scanned || r.scanned_at > row.scanned_at {
            row.scanned = true;
            row.counts = r.counts;
            row.fixable = r.fixable;
            row.report_namespace = r.namespace.clone();
            row.report_name = r.name.clone();
            row.scanner = r.scanner.clone();
            row.scanned_at = r.scanned_at;
        }
    }
    for row in &mut rows {
        row.workloads.sort();
    }
    sort_rows(&mut rows);
    rows
}

/// Worst first (more critical, then more high, ...), then by image; images
/// without a report last.
pub fn sort_rows(rows: &mut [ImageVulns]) {
    rows.sort_by(|a, b| {
        b.scanned
            .cmp(&a.scanned)
            .then_with(|| b.counts.rank().cmp(&a.counts.rank()))
            .then_with(|| a.image.cmp(&b.image))
            .then_with(|| a.digest.cmp(&b.digest))
    });
}

/// The rows `args` asks for: with `severity`, only scanned images with a
/// vulnerability that bad or worse; with `fixable`, only ones with a fix
/// (that bad or worse).
pub fn filter(rows: Vec<ImageVulns>, args: &VulnsArgs) -> Vec<ImageVulns> {
    if args.severity.is_none() && !args.fixable {
        return rows;
    }
    let min = args.severity.unwrap_or(Severity::Unknown);
    rows.into_iter()
        .filter(|r| {
            let c = if args.fixable { &r.fixable } else { &r.counts };
            r.scanned && c.at_least(min) > 0
        })
        .collect()
}

/// The vulnerabilities `args` asks for, worst first (then by score, id).
pub fn filter_vulnerabilities(
    mut vulns: Vec<Vulnerability>,
    args: &VulnsArgs,
) -> Vec<Vulnerability> {
    let min = args.severity.unwrap_or(Severity::Unknown);
    vulns.retain(|v| v.severity >= min && (!args.fixable || !v.fixed_version.is_empty()));
    vulns.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| b.score.total_cmp(&a.score))
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.package.cmp(&b.package))
    });
    vulns
}

/// The fixes by package: one group per package and installed version,
/// with the versions that fix its vulnerabilities. Worst first, then the
/// groups with more fixes. `vulns` come worst first.
pub fn fix_groups(vulns: &[Vulnerability]) -> Vec<FixGroup> {
    let mut groups: BTreeMap<(String, String), (FixGroup, BTreeSet<String>)> = BTreeMap::new();
    for v in vulns {
        let (g, fixed) = groups
            .entry((v.package.clone(), v.installed_version.clone()))
            .or_insert_with(|| {
                (
                    FixGroup {
                        package: v.package.clone(),
                        installed_version: v.installed_version.clone(),
                        fixed_in: Vec::new(),
                        counts: SeverityCounts::default(),
                        fixable: 0,
                        ids: Vec::new(),
                    },
                    BTreeSet::new(),
                )
            });
        g.counts.add(v.severity);
        if !v.fixed_version.is_empty() {
            g.fixable += 1;
            fixed.insert(v.fixed_version.clone());
        }
        if !g.ids.contains(&v.id) {
            g.ids.push(v.id.clone());
        }
    }
    let mut out: Vec<FixGroup> = groups
        .into_values()
        .map(|(mut g, fixed)| {
            g.fixed_in = fixed.into_iter().collect();
            g
        })
        .collect();
    out.sort_by(|a, b| {
        b.counts
            .rank()
            .cmp(&a.counts.rank())
            .then_with(|| b.fixable.cmp(&a.fixable))
            .then_with(|| a.package.cmp(&b.package))
            .then_with(|| a.installed_version.cmp(&b.installed_version))
    });
    out
}

/// A namespace as the API accepts it (a DNS label), so it can go into a
/// request path.
fn check_namespace(ns: &str) -> Result<()> {
    let ok = !ns.is_empty()
        && ns.len() <= 63
        && ns
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !ns.starts_with('-')
        && !ns.ends_with('-');
    if !ok {
        bail!("{ns:?} is not a valid namespace name");
    }
    Ok(())
}

fn api_error(what: &str, e: kube::Error) -> anyhow::Error {
    anyhow::Error::from(e).context(format!("cannot read {what}"))
}

fn is_forbidden(e: &kube::Error) -> bool {
    matches!(e, kube::Error::Api(resp) if resp.code == 403)
}

/// What one scope (a namespace, or all) holds.
#[derive(Default)]
struct Read {
    pods: Vec<Pod>,
    reports: Vec<ReportSummary>,
    forbidden: bool,
}

async fn read_scope(
    client: &Client,
    namespace: Option<&str>,
    notes: &mut Vec<String>,
) -> Result<Read> {
    let mut out = Read::default();
    let place = namespace.map_or("all namespaces".to_string(), |n| n.to_string());
    match trivy::list_summaries(client, namespace).await {
        Ok(listed) => {
            if listed.more {
                notes.push(format!(
                    "Only the first {} VulnerabilityReports in {place} were read; narrow with -n.",
                    trivy::MAX_REPORTS
                ));
            }
            out.reports = listed.reports;
        }
        Err(e) if is_forbidden(&e) => {
            out.forbidden = true;
            return Ok(out);
        }
        Err(e) => return Err(api_error("VulnerabilityReports", e)),
    }
    let api: Api<Pod> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    match list_bounded(&api, &ListParams::default(), MAX_PODS).await {
        Ok(list) => {
            if list.more {
                notes.push(format!(
                    "Only the first {MAX_PODS} pods in {place} were read; narrow with -n."
                ));
            }
            out.pods = list.items;
        }
        Err(e) => notes.push(format!(
            "Cannot read the pods in {place} ({}): only the images the reports name are listed, without the pods that run them.",
            crate::error_text(&anyhow::Error::from(e))
        )),
    }
    Ok(out)
}

fn summary(state: VulnsState, args: &VulnsArgs) -> VulnsSummary {
    VulnsSummary {
        state,
        namespace: args.namespace.clone().unwrap_or_default(),
        namespaces_read: Vec::new(),
        images: Vec::new(),
        unscanned: 0,
        notes: Vec::new(),
    }
}

/// The images of a namespace (or of every namespace the user may read)
/// with their vulnerability counts. Reads the reports only when asked: no
/// watch, nothing cached.
pub async fn image_vulns(client: &Client, args: &VulnsArgs) -> Result<VulnsSummary> {
    let namespace = args.namespace.as_deref().filter(|n| !n.is_empty());
    if let Some(ns) = namespace {
        check_namespace(ns)?;
    }
    if !trivy::served(client)
        .await
        .map_err(|e| api_error("the API groups", e))?
    {
        return Ok(summary(VulnsState::NoOperator, args));
    }
    let mut out = summary(VulnsState::Ok, args);
    let scopes: Vec<Option<String>> = match trivy::access(client, namespace).await {
        Access::Scope => vec![namespace.map(str::to_string)],
        Access::Namespaces(list) => {
            out.namespaces_read = list.clone();
            out.notes.push(format!(
                "Not allowed to list VulnerabilityReports in all namespaces; read {}.",
                list.join(", ")
            ));
            list.into_iter().map(Some).collect()
        }
        Access::Denied => {
            out.state = VulnsState::Forbidden;
            return Ok(out);
        }
    };
    let (mut pods, mut reports) = (Vec::new(), Vec::new());
    let mut forbidden = 0;
    for scope in &scopes {
        let read = read_scope(client, scope.as_deref(), &mut out.notes).await?;
        if read.forbidden {
            forbidden += 1;
        }
        pods.extend(read.pods);
        reports.extend(read.reports);
    }
    if forbidden == scopes.len() {
        out.state = VulnsState::Forbidden;
        out.notes.clear();
        return Ok(out);
    }
    let running = pod_images(&pods);
    let rows = aggregate(&running, &reports);
    out.unscanned = rows.iter().filter(|r| !r.scanned).count() as u32;
    if reports.is_empty() {
        out.state = VulnsState::NoReports;
    }
    out.images = filter(rows, args);
    Ok(out)
}

/// Whether `query` names `row`: its reference (as listed, or the same
/// image normalized) or its digest (a prefix of at least 12 characters,
/// with or without `sha256:`).
pub fn matches(row: &ImageVulns, query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() {
        return false;
    }
    if row.image == q || (!q.contains('@') && normalize(&row.image) == normalize(q)) {
        return true;
    }
    let d = q.rsplit_once('@').map_or(q, |(_, d)| d);
    let hex = d.strip_prefix("sha256:").unwrap_or(d);
    let row_hex = row.digest.strip_prefix("sha256:").unwrap_or(&row.digest);
    hex.len() >= 12 && !row_hex.is_empty() && row_hex.starts_with(hex)
}

/// One image (named as [`matches`] takes it) with its newest full report,
/// its vulnerabilities and fixes after `args`' filters.
pub async fn image_detail(client: &Client, args: &VulnsArgs, image: &str) -> Result<ImageDetail> {
    let all = VulnsArgs {
        severity: None,
        fixable: false,
        ..args.clone()
    };
    let list = image_vulns(client, &all).await?;
    let place = match &list.namespace {
        n if n.is_empty() => "all namespaces".to_string(),
        n => n.clone(),
    };
    match list.state {
        VulnsState::NoOperator => bail!("{}", super::render::state_message(&list)),
        VulnsState::Forbidden => bail!("{}", super::render::state_message(&list)),
        _ => {}
    }
    let found: Vec<&ImageVulns> = list.images.iter().filter(|r| matches(r, image)).collect();
    let row = match found.as_slice() {
        [] => bail!("No image {image:?} runs or was scanned in {place}; `nauvi vulns` lists them."),
        [one] => (*one).clone(),
        many => bail!(
            "{image:?} names {} images in {place}; give the digest: {}",
            many.len(),
            many.iter()
                .map(|r| format!("{} {}", r.image, r.digest))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    if !row.scanned {
        return Ok(ImageDetail {
            image: row,
            vulnerabilities: Vec::new(),
            fix_groups: Vec::new(),
        });
    }
    let full = trivy::get_report(client, &row.report_namespace, &row.report_name)
        .await
        .map_err(|e| api_error(&format!("VulnerabilityReport {}", row.report_name), e))?;
    let vulnerabilities = filter_vulnerabilities(full.vulnerabilities, args);
    let fix_groups = fix_groups(&vulnerabilities);
    Ok(ImageDetail {
        image: row,
        vulnerabilities,
        fix_groups,
    })
}

/// `nauvi vulns`: the list, or one image with `image`, as text or JSON.
/// No Trivy Operator and not allowed are errors (exit 1); in JSON the
/// result, with its `state`, is printed first.
pub async fn cli_vulns(
    client: &Client,
    args: &VulnsArgs,
    image: Option<&str>,
    json: bool,
) -> Result<()> {
    let now = jiff::Timestamp::now().as_second();
    if let Some(image) = image {
        let detail = image_detail(client, args, image).await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&detail)?);
        } else {
            print!("{}", super::render::render_detail(&detail, now));
        }
        return Ok(());
    }
    let list = image_vulns(client, args).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&list)?);
    }
    match list.state {
        VulnsState::NoOperator | VulnsState::Forbidden => {
            bail!("{}", super::render::state_message(&list))
        }
        _ if !json => print!("{}", super::render::render_list(&list, now)),
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::image_security::trivy_operator::{parse_list, parse_report};

    pub(crate) fn fixture_rows() -> Vec<ImageVulns> {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("testdata/pods.json")).unwrap();
        let pods: Vec<Pod> = serde_json::from_value(v["items"].clone()).unwrap();
        let (reports, _) = parse_list(include_bytes!("testdata/reports.json")).unwrap();
        aggregate(&pod_images(&pods), &reports)
    }

    fn w(kind: &str, name: &str, container: &str) -> Workload {
        Workload {
            kind: kind.into(),
            namespace: "shop".into(),
            name: name.into(),
            container: container.into(),
        }
    }

    #[test]
    fn one_row_per_image_with_the_newest_report() {
        let rows = fixture_rows();
        let images: Vec<_> = rows.iter().map(|r| r.image.as_str()).collect();
        assert_eq!(images, ["nginx:1.27", "redis:7", "busybox:1.36"]);

        let nginx = &rows[0];
        assert!(nginx.scanned);
        assert_eq!(nginx.digest, "sha256:1111");
        assert_eq!(nginx.reports, 2);
        // The Deployment's report (2026-11-20) is newer than the pod's.
        assert_eq!(nginx.report_name, "replicaset-web-5f6b7c-nginx");
        assert_eq!(nginx.counts.critical, 1);
        assert_eq!(nginx.fixable.total(), 3);
        assert_eq!(nginx.scanner, "Trivy 0.58.1");
        assert_eq!(
            nginx.workloads,
            [w("Deployment", "web", "nginx"), w("Pod", "static", "nginx")]
        );

        // Joined by the workload (the report has no digest); clean.
        let redis = &rows[1];
        assert!(redis.scanned);
        assert_eq!(redis.digest, "sha256:3333");
        assert_eq!(redis.counts.total(), 0);
        assert_eq!(redis.workloads, [w("StatefulSet", "cache", "redis")]);

        // No report: last.
        assert!(!rows[2].scanned);
        assert_eq!(rows[2].workloads, [w("Pod", "static", "init")]);
    }

    #[test]
    fn a_report_without_a_running_pod_is_its_own_row() {
        let (reports, _) = parse_list(include_bytes!("testdata/reports.json")).unwrap();
        let rows = aggregate(&[], &reports);
        let images: Vec<_> = rows.iter().map(|r| r.image.as_str()).collect();
        assert_eq!(images, ["nginx:1.27", "redis:7"]);
        // Without pods the scanned ReplicaSet is shown as it is.
        assert_eq!(
            rows[0].workloads,
            [
                w("Pod", "static", "nginx"),
                w("ReplicaSet", "web-5f6b7c", "nginx")
            ]
        );
        assert_eq!(rows[0].reports, 2);
    }

    #[test]
    fn filters_by_severity_and_fix() {
        let rows = fixture_rows();
        let only = |severity, fixable| {
            filter(
                rows.clone(),
                &VulnsArgs {
                    namespace: None,
                    severity,
                    fixable,
                },
            )
            .into_iter()
            .map(|r| r.image)
            .collect::<Vec<_>>()
        };
        assert_eq!(only(None, false).len(), 3);
        assert_eq!(only(Some(Severity::Critical), false), ["nginx:1.27"]);
        assert_eq!(only(Some(Severity::Low), true), ["nginx:1.27"]);
        // nginx has no fixable low (CVE-0005 has none) but a fixable medium.
        assert_eq!(only(None, true), ["nginx:1.27"]);
        assert!(only(Some(Severity::Unknown), false).contains(&"nginx:1.27".to_string()));
        assert!(!only(Some(Severity::Unknown), false).contains(&"redis:7".to_string()));
    }

    #[test]
    fn fixes_group_by_package() {
        let full = parse_report(include_bytes!("testdata/report-web.json")).unwrap();
        let vulns = filter_vulnerabilities(full.vulnerabilities, &VulnsArgs::default());
        let ids: Vec<_> = vulns.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "CVE-2026-0001",
                "CVE-2026-0002",
                "CVE-2026-0003",
                "CVE-2026-0004",
                "CVE-2026-0005",
                "CVE-2026-0006"
            ]
        );
        let groups = fix_groups(&vulns);
        let packages: Vec<_> = groups.iter().map(|g| g.package.as_str()).collect();
        assert_eq!(packages, ["openssl", "zlib1g", "curl", "libc6"]);
        let openssl = &groups[0];
        assert_eq!(openssl.fixed_in, ["3.0.14-1", "3.0.15-1"]);
        assert_eq!(openssl.fixable, 2);
        assert_eq!(openssl.counts.critical, 1);
        assert_eq!(openssl.ids, ["CVE-2026-0001", "CVE-2026-0002"]);
        let curl = &groups[2];
        assert_eq!(curl.fixable, 1);
        assert_eq!(curl.counts.total(), 2);
        assert!(groups[1].fixed_in.is_empty());

        let fixable = filter_vulnerabilities(
            parse_report(include_bytes!("testdata/report-web.json"))
                .unwrap()
                .vulnerabilities,
            &VulnsArgs {
                severity: Some(Severity::High),
                fixable: true,
                ..Default::default()
            },
        );
        let ids: Vec<_> = fixable.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["CVE-2026-0001", "CVE-2026-0002"]);
    }

    #[test]
    fn images_are_named_by_reference_or_digest() {
        let rows = fixture_rows();
        let nginx = &rows[0];
        for q in ["nginx:1.27", "docker.io/library/nginx:1.27", "sha256:1111"] {
            // A digest needs 12 characters: the fixture's is too short.
            assert_eq!(matches(nginx, q), q != "sha256:1111", "{q}");
        }
        let mut long = nginx.clone();
        long.digest = "sha256:0123456789abcdef".into();
        assert!(matches(&long, "0123456789ab"));
        assert!(matches(&long, "nginx@sha256:0123456789abcdef"));
        assert!(!matches(&long, "0123456789"));
        assert!(!matches(nginx, "redis:7"));
        assert!(!matches(nginx, ""));
    }

    #[test]
    fn namespaces_are_dns_labels() {
        assert!(check_namespace("team-a").is_ok());
        for bad in ["", "../x", "a/b", "A", "-a", "a-", &"a".repeat(64)] {
            assert!(check_namespace(bad).is_err(), "{bad}");
        }
    }
}
