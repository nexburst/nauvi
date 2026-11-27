//! One row per image from the running pods and the reports, the filters,
//! and a report's fixes grouped by package.

use super::images::{normalize, pod_images, short_reference, RunningImage};
use super::trivy_operator::{self as trivy, Access, ReportSummary};
use super::{
    FixGroup, ImageDetail, ImageVulns, ScanSource, Severity, SeverityCounts, Vulnerability,
    VulnsArgs, VulnsState, VulnsSummary, Workload,
};
use crate::bounded_list::list_bounded;
use crate::resources::ResourceKind;
use anyhow::{bail, Result};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::Client;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Most pods one listing reads.
pub const MAX_PODS: usize = 5000;

/// How a row of a report no running pod matched names its image:
/// `nginx:1.27`, or `nginx@sha256:...` without a tag.
fn report_image(r: &ReportSummary) -> String {
    let repo = short_reference(&r.reference);
    if r.tagged {
        return repo;
    }
    let repo = repo.strip_suffix(":latest").unwrap_or(&repo);
    if r.digest.is_empty() {
        repo.to_string()
    } else {
        format!("{repo}@{}", r.digest)
    }
}

fn empty_row(image: String, digest: String) -> ImageVulns {
    ImageVulns {
        source: ScanSource::TrivyOperator,
        image,
        digest,
        running: false,
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
        row.running = true;
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
        // A report with a digest joins only that digest: one whose digest
        // no pod runs is of another build (an older push of a mutable
        // tag), even when its workload still runs. Without a digest it
        // joins its workload, else a unique reference, and only a tagged
        // one (no tag is not `:latest`).
        let by_owner_row = owner.as_ref().map(|(i, _)| *i);
        let found = if !r.digest.is_empty() {
            by_digest.get(&r.digest).copied()
        } else {
            by_owner_row.or_else(
                || match (r.tagged, by_ref.get(&normalized).map(Vec::as_slice)) {
                    (true, Some(&[i])) => Some(i),
                    _ => None,
                },
            )
        };
        let joined_owner = found.is_some() && found == by_owner_row;
        let i = match found {
            Some(i) => i,
            None => {
                let i = rows.len();
                rows.push(empty_row(report_image(r), r.digest.clone()));
                if !r.digest.is_empty() {
                    by_digest.insert(r.digest.clone(), i);
                }
                if r.tagged {
                    by_ref.entry(normalized).or_default().push(i);
                }
                i
            }
        };
        let row = &mut rows[i];
        // A report's own workload, as the pods show it when it joined them
        // (the Deployment, not its ReplicaSet); as the report names it
        // otherwise.
        let workload = match owner {
            Some((_, w)) if joined_owner => w,
            _ => r.owner.clone(),
        };
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

/// What one call may still read, shared by every namespace it reads (the
/// per-namespace fallback reads many).
struct Budget {
    reports: usize,
    pods: usize,
    /// Reports or pods were left unread.
    cut_reports: bool,
    cut_pods: bool,
}

impl Budget {
    fn new() -> Self {
        Budget {
            reports: trivy::MAX_REPORTS,
            pods: MAX_PODS,
            cut_reports: false,
            cut_pods: false,
        }
    }

    fn notes(&self, notes: &mut Vec<String>) {
        if self.cut_reports {
            notes.push(format!(
                "Only the first {} VulnerabilityReports were read; narrow with -n.",
                trivy::MAX_REPORTS
            ));
        }
        if self.cut_pods {
            notes.push(format!(
                "Only the first {MAX_PODS} pods were read; narrow with -n."
            ));
        }
    }
}

async fn read_scope(
    client: &Client,
    namespace: Option<&str>,
    budget: &mut Budget,
    notes: &mut Vec<String>,
) -> Result<Read> {
    let mut out = Read::default();
    let place = namespace.map_or("all namespaces".to_string(), |n| n.to_string());
    if budget.reports == 0 {
        budget.cut_reports = true;
    } else {
        match trivy::list_summaries(client, namespace, budget.reports).await {
            Ok(listed) => {
                budget.cut_reports |= listed.more;
                budget.reports -= listed.reports.len().min(budget.reports);
                out.reports = listed.reports;
            }
            Err(e) if is_forbidden(&e) => {
                out.forbidden = true;
                return Ok(out);
            }
            Err(e) => return Err(api_error("VulnerabilityReports", e)),
        }
    }
    if budget.pods == 0 {
        budget.cut_pods = true;
        return Ok(out);
    }
    let api: Api<Pod> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    match list_bounded(&api, &ListParams::default(), budget.pods).await {
        Ok(list) => {
            budget.cut_pods |= list.more;
            budget.pods -= list.items.len().min(budget.pods);
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
        source: ScanSource::TrivyOperator,
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
/// watch, nothing cached. Asks discovery whether the CRD exists; a caller
/// that already discovered the kinds uses [`image_vulns_in`].
pub async fn image_vulns(client: &Client, args: &VulnsArgs) -> Result<VulnsSummary> {
    check_args(args)?;
    let served = trivy::served(client)
        .await
        .map_err(|e| api_error("the API groups", e))?;
    read_vulns(client, args, served).await
}

/// [`image_vulns`] for a caller that has the discovered kinds (the app):
/// whether the CRD exists comes from them, without another request.
pub async fn image_vulns_in(
    client: &Client,
    kinds: &[ResourceKind],
    args: &VulnsArgs,
) -> Result<VulnsSummary> {
    check_args(args)?;
    read_vulns(client, args, trivy::served_in(kinds)).await
}

fn check_args(args: &VulnsArgs) -> Result<()> {
    match args.namespace.as_deref().filter(|n| !n.is_empty()) {
        Some(ns) => check_namespace(ns),
        None => Ok(()),
    }
}

async fn read_vulns(client: &Client, args: &VulnsArgs, served: bool) -> Result<VulnsSummary> {
    let namespace = args.namespace.as_deref().filter(|n| !n.is_empty());
    if !served {
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
    let mut budget = Budget::new();
    for scope in &scopes {
        let read = read_scope(client, scope.as_deref(), &mut budget, &mut out.notes).await?;
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
    budget.notes(&mut out.notes);
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

    fn summary_of(owner: Workload, reference: &str, tagged: bool, digest: &str) -> ReportSummary {
        ReportSummary {
            namespace: "shop".into(),
            name: "r".into(),
            owner,
            reference: reference.into(),
            tagged,
            digest: digest.into(),
            scanner: "Trivy 0.58.1".into(),
            scanned_at: 1,
            counts: SeverityCounts {
                high: 4,
                ..Default::default()
            },
            fixable: SeverityCounts::default(),
        }
    }

    fn running() -> Vec<RunningImage> {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("testdata/pods.json")).unwrap();
        let pods: Vec<Pod> = serde_json::from_value(v["items"].clone()).unwrap();
        pod_images(&pods)
    }

    /// A report of an older build of a mutable tag: its workload still
    /// runs, but with another digest. It is its own row, not running, and
    /// the running image stays unscanned.
    #[test]
    fn a_stale_digest_does_not_join_by_workload() {
        let stale = summary_of(
            w("ReplicaSet", "web-5f6b7c", "nginx"),
            "index.docker.io/library/nginx:1.27",
            true,
            "sha256:0ld",
        );
        let rows = aggregate(&running(), &[stale]);
        let nginx: Vec<_> = rows.iter().filter(|r| r.image == "nginx:1.27").collect();
        assert_eq!(nginx.len(), 2, "{rows:?}");
        let (scanned, live): (Vec<&ImageVulns>, Vec<&ImageVulns>) =
            nginx.iter().copied().partition(|r| r.scanned);
        assert_eq!(scanned[0].digest, "sha256:0ld");
        assert!(!scanned[0].running);
        // Named as the report names it, not as the Deployment.
        assert_eq!(
            scanned[0].workloads,
            [w("ReplicaSet", "web-5f6b7c", "nginx")]
        );
        assert!(live[0].running && live[0].digest == "sha256:1111");
    }

    /// A report with a digest but no tag is not `:latest`: it never joins
    /// by reference, and its row is named by digest.
    #[test]
    fn an_untagged_report_does_not_join_latest() {
        let pod: Pod = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "p", "namespace": "shop" },
            "spec": { "containers": [{ "name": "c", "image": "app" }] },
            "status": { "phase": "Pending" }
        }))
        .unwrap();
        let untagged = summary_of(w("Pod", "other", "c"), "ghcr.io/org/app", false, "");
        let digested = summary_of(
            w("Pod", "other", "c"),
            "index.docker.io/library/app",
            false,
            "sha256:abc",
        );
        let rows = aggregate(&pod_images(&[pod]), &[untagged, digested]);
        let live = rows.iter().find(|r| r.running).unwrap();
        assert!(!live.scanned, "{rows:?}");
        let names: Vec<_> = rows
            .iter()
            .filter(|r| r.scanned)
            .map(|r| r.image.as_str())
            .collect();
        assert_eq!(names, ["app@sha256:abc", "ghcr.io/org/app"]);
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

    /// A cluster where only namespaced lists are allowed: `default` and
    /// `ns-0`..`ns-2`, each with 900 reports and no pods. Records the path
    /// of each request.
    fn fallback_server() -> (Client, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use http_body_util::BodyExt;
        use kube::client::Body;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let svc = tower::service_fn(move |req: http::Request<Body>| {
            let log = log.clone();
            async move {
                let path = req.uri().path().to_string();
                let query = req.uri().query().unwrap_or_default().to_string();
                log.lock().unwrap().push(path.clone());
                let param = |name: &str| {
                    query
                        .split('&')
                        .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
                        .map(str::to_string)
                };
                let body = if path == "/apis/aquasecurity.github.io/v1alpha1" {
                    serde_json::json!({
                        "kind": "APIResourceList", "groupVersion": "aquasecurity.github.io/v1alpha1",
                        "resources": [{ "name": "vulnerabilityreports", "singularName": "",
                            "namespaced": true, "kind": "VulnerabilityReport", "verbs": ["list"] }]
                    })
                } else if path.ends_with("/selfsubjectaccessreviews") {
                    let bytes = req.into_body().collect().await.unwrap().to_bytes();
                    let review: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    let namespaced = review
                        .pointer("/spec/resourceAttributes/namespace")
                        .is_some_and(|n| n.is_string());
                    let mut review = review;
                    review["status"] = serde_json::json!({ "allowed": namespaced });
                    review
                } else if path == "/api/v1/namespaces" {
                    let items: Vec<_> = (0..3)
                        .map(|i| serde_json::json!({ "metadata": { "name": format!("ns-{i}") } }))
                        .collect();
                    serde_json::json!({ "kind": "NamespaceList", "metadata": {}, "items": items })
                } else if path.ends_with("/vulnerabilityreports") {
                    let limit: usize = param("limit").and_then(|l| l.parse().ok()).unwrap_or(900);
                    let start: usize = param("continue").and_then(|c| c.parse().ok()).unwrap_or(0);
                    let end = (start + limit).min(900);
                    let items: Vec<_> = (start..end)
                        .map(|i| serde_json::json!({
                            "metadata": { "name": format!("r{i}"), "namespace": "x" },
                            "report": { "artifact": { "repository": format!("{}-app{i}", path.split('/').nth(5).unwrap_or("")), "tag": "1" },
                                "summary": { "lowCount": 1 } }
                        }))
                        .collect();
                    let token = if end < 900 {
                        end.to_string()
                    } else {
                        String::new()
                    };
                    serde_json::json!({ "metadata": { "continue": token }, "items": items })
                } else {
                    serde_json::json!({ "kind": "PodList", "metadata": {}, "items": [] })
                };
                Ok::<_, std::convert::Infallible>(http::Response::new(Body::from(
                    body.to_string().into_bytes(),
                )))
            }
        });
        (Client::new(svc, "default"), seen)
    }

    /// The per-namespace fallback shares one budget: 4 namespaces of 900
    /// reports give 2000 in all, and the last namespace is not read.
    #[tokio::test]
    async fn the_namespace_fallback_shares_one_budget() {
        let (client, seen) = fallback_server();
        let s = image_vulns(&client, &VulnsArgs::default()).await.unwrap();
        assert_eq!(s.state, VulnsState::Ok);
        assert_eq!(s.namespaces_read, ["default", "ns-0", "ns-1", "ns-2"]);
        assert_eq!(
            s.images.len(),
            crate::image_security::trivy_operator::MAX_REPORTS
        );
        assert!(
            s.notes
                .iter()
                .any(|n| n.starts_with("Only the first 2000 VulnerabilityReports")),
            "{:?}",
            s.notes
        );
        let seen = seen.lock().unwrap();
        assert!(
            !seen
                .iter()
                .any(|p| p.contains("/namespaces/ns-2/vulnerabilityreports")),
            "{seen:?}"
        );
    }

    /// The app passes the kinds it discovered: no discovery request.
    #[tokio::test]
    async fn the_discovered_kinds_say_whether_the_crd_exists() {
        let (client, seen) = fallback_server();
        let s = image_vulns_in(&client, &[], &VulnsArgs::default())
            .await
            .unwrap();
        assert_eq!(s.state, VulnsState::NoOperator);
        assert_eq!(s.source, ScanSource::TrivyOperator);
        assert!(seen.lock().unwrap().is_empty());
    }
}
