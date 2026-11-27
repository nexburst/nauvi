//! Misconfigurations (#538): the Trivy Operator's `ConfigAuditReport`s
//! (`aquasecurity.github.io/v1alpha1`, one per workload or other object),
//! one row per workload, and for one workload the checks it fails with
//! what to change.
//!
//! The same rules as the vulnerability listing (ADR 0011): read only when
//! asked, with the user's own RBAC, in small pages and kept as counts; one
//! full report only when it is shown. Never "problems".
//!
//! The operator audits a Deployment's ReplicaSet and a CronJob's Job; the
//! row names the Deployment or CronJob (from the owner references of the
//! ReplicaSets and Jobs, read as metadata only, when there are such
//! reports), and keeps the newest report of each.

use super::paged::{self, url_path};
use super::report::{api_error, check_namespace, check_object_name, is_forbidden};
use super::trivy_operator::{self as trivy, clean, secs, Access};
use super::{Severity, SeverityCounts, VulnsState};
use crate::resources::{can_list, ResourceKind};
use anyhow::Result;
use k8s_openapi::api::apps::v1::ReplicaSet;
use k8s_openapi::api::batch::v1::Job;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const GROUP: &str = trivy::GROUP;
pub const VERSION: &str = trivy::VERSION;
pub const PLURAL: &str = "configauditreports";
/// Most reports one listing reads.
pub const MAX_REPORTS: usize = 2000;
/// Most ReplicaSets (and Jobs) read to name their Deployments (CronJobs).
pub const MAX_OWNERS: usize = 5000;
/// Most checks kept of one report, and messages of one check.
const MAX_CHECKS: usize = 500;
const MAX_MESSAGES: usize = 20;

/// What a report is about: a Deployment, a StatefulSet, a Service, ...
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConfigTarget {
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

/// One workload (or other object) and how many checks it fails.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct WorkloadConfig {
    pub target: ConfigTarget,
    /// Failed checks by severity, from the newest report's summary.
    pub failed: SeverityCounts,
    /// The newest report.
    pub report_namespace: String,
    pub report_name: String,
    /// How many reports name it (old ReplicaSets of a Deployment too).
    pub reports: u32,
    /// `Trivy 0.69.3`.
    pub scanner: String,
    /// When the report was made (unix seconds), 0 when unknown.
    pub scanned_at: i64,
}

/// The result of a listing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConfigSummary {
    /// `no_operator`: the cluster does not serve ConfigAuditReports.
    pub state: VulnsState,
    /// The namespace asked for, empty for all.
    pub namespace: String,
    /// The namespaces read when the cluster-wide list is not allowed.
    pub namespaces_read: Vec<String>,
    /// Most failed checks first.
    pub workloads: Vec<WorkloadConfig>,
    pub forbidden_namespaces: Vec<String>,
    /// With `forbidden` for chosen namespaces: all namespaces may be listed.
    pub all_namespaces_allowed: bool,
    pub notes: Vec<String>,
}

/// One check a workload fails, in the operator's words.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConfigCheck {
    /// `KSV014`.
    pub id: String,
    /// `Root file system is not read-only`.
    pub title: String,
    pub severity: Severity,
    /// `Kubernetes Security Check`.
    pub category: String,
    /// Why it matters.
    pub description: String,
    /// What to change.
    pub remediation: String,
    /// Where, as the check found it (`Container 'nginx' of Deployment
    /// 'web' should set 'securityContext.readOnlyRootFilesystem' to true`).
    pub messages: Vec<String>,
    /// The container it is about, empty when not one.
    pub container: String,
}

/// One workload with the checks it fails.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ConfigDetail {
    pub workload: WorkloadConfig,
    /// Worst first.
    pub failed: Vec<ConfigCheck>,
    /// How many checks it passes.
    pub passed: u32,
}

/// Whether discovery found the ConfigAuditReport kind.
pub fn served_in(kinds: &[ResourceKind]) -> bool {
    kinds
        .iter()
        .any(|k| k.resource.group == GROUP && k.resource.plural == PLURAL)
}

/// Whether the cluster serves ConfigAuditReports (one discovery request).
pub async fn served(client: &Client) -> kube::Result<bool> {
    paged::served(client, GROUP, VERSION, PLURAL).await
}

// ---------------------------------------------------------------------------
// The report as stored, only what is used.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Meta {
    name: String,
    namespace: String,
    creation_timestamp: String,
    labels: BTreeMap<String, String>,
    annotations: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Summary {
    critical_count: u32,
    high_count: u32,
    medium_count: u32,
    low_count: u32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Scanner {
    name: String,
    version: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Scope {
    #[serde(rename = "type")]
    type_: String,
    value: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawCheck {
    #[serde(rename = "checkID")]
    check_id: String,
    title: String,
    severity: String,
    category: String,
    description: String,
    remediation: String,
    messages: Vec<String>,
    success: bool,
    scope: Scope,
}

/// A listing's report body: no checks (serde skips them).
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LiteBody {
    scanner: Scanner,
    summary: Summary,
    update_timestamp: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FullBody {
    scanner: Scanner,
    summary: Summary,
    update_timestamp: String,
    checks: Vec<RawCheck>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Raw<B> {
    metadata: Meta,
    report: B,
}

fn label<'a>(m: &'a Meta, key: &str) -> &'a str {
    m.labels
        .get(key)
        .filter(|v| !v.is_empty())
        .or_else(|| m.annotations.get(key))
        .map_or("", String::as_str)
}

fn row(m: &Meta, scanner: &Scanner, s: &Summary, update: &str) -> WorkloadConfig {
    let namespace = match label(m, "trivy-operator.resource.namespace") {
        "" => m.namespace.as_str(),
        ns => ns,
    };
    let scanned_at = match secs(update) {
        0 => secs(&m.creation_timestamp),
        t => t,
    };
    WorkloadConfig {
        target: ConfigTarget {
            kind: clean(label(m, "trivy-operator.resource.kind")),
            namespace: clean(namespace),
            name: clean(label(m, "trivy-operator.resource.name")),
        },
        failed: SeverityCounts {
            critical: s.critical_count,
            high: s.high_count,
            medium: s.medium_count,
            low: s.low_count,
            unknown: 0,
        },
        report_namespace: clean(&m.namespace),
        report_name: clean(&m.name),
        reports: 1,
        scanner: clean(format!("{} {}", scanner.name, scanner.version).trim()),
        scanned_at,
    }
}

fn lite_row(raw: Raw<LiteBody>) -> WorkloadConfig {
    let b = &raw.report;
    row(&raw.metadata, &b.scanner, &b.summary, &b.update_timestamp)
}

fn check(c: &RawCheck) -> ConfigCheck {
    ConfigCheck {
        id: clean(&c.check_id),
        title: clean(&c.title),
        severity: Severity::parse(&c.severity),
        category: clean(&c.category),
        description: clean(&c.description),
        remediation: clean(&c.remediation),
        messages: c
            .messages
            .iter()
            .map(|m| clean(m))
            .filter(|m| !m.is_empty())
            .take(MAX_MESSAGES)
            .collect(),
        container: if c.scope.type_.eq_ignore_ascii_case("container") {
            clean(&c.scope.value)
        } else {
            String::new()
        },
    }
}

fn detail(raw: Raw<FullBody>) -> ConfigDetail {
    let b = &raw.report;
    let workload = row(&raw.metadata, &b.scanner, &b.summary, &b.update_timestamp);
    let passed = b.checks.iter().filter(|c| c.success).count();
    let mut failed: Vec<ConfigCheck> = b
        .checks
        .iter()
        .filter(|c| !c.success)
        .take(MAX_CHECKS)
        .map(check)
        .collect();
    failed.sort_by(|a, b| b.severity.cmp(&a.severity).then_with(|| a.id.cmp(&b.id)));
    ConfigDetail {
        workload,
        failed,
        passed: u32::try_from(passed).unwrap_or(u32::MAX),
    }
}

/// Parse a `ConfigAuditReportList` page into rows (as the reports name
/// their objects).
pub fn parse_list(json: &[u8]) -> serde_json::Result<Vec<WorkloadConfig>> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct List {
        items: Vec<Raw<LiteBody>>,
    }
    let list: List = serde_json::from_slice(json)?;
    Ok(list.items.into_iter().map(lite_row).collect())
}

/// Parse one full `ConfigAuditReport`.
pub fn parse_report(json: &[u8]) -> serde_json::Result<ConfigDetail> {
    serde_json::from_slice::<Raw<FullBody>>(json).map(detail)
}

// ---------------------------------------------------------------------------
// Rows: one per workload, the newest report each.
// ---------------------------------------------------------------------------

/// The Deployment of a ReplicaSet, the CronJob of a Job:
/// `(namespace, kind, name)` -> `(kind, name)`.
pub type Owners = HashMap<(String, String, String), (String, String)>;

/// One row per target (after `owners` renamed ReplicaSets and Jobs), the
/// newest report of each, most failed checks first.
pub fn merge(reports: Vec<WorkloadConfig>, owners: &Owners) -> Vec<WorkloadConfig> {
    let mut by_target: BTreeMap<ConfigTarget, WorkloadConfig> = BTreeMap::new();
    for mut r in reports {
        let key = (
            r.target.namespace.clone(),
            r.target.kind.clone(),
            r.target.name.clone(),
        );
        if let Some((kind, name)) = owners.get(&key) {
            r.target.kind = kind.clone();
            r.target.name = name.clone();
        }
        match by_target.get_mut(&r.target) {
            Some(old) => {
                let reports = old.reports + 1;
                if r.scanned_at > old.scanned_at {
                    *old = r;
                }
                old.reports = reports;
            }
            None => {
                by_target.insert(r.target.clone(), r);
            }
        }
    }
    let mut rows: Vec<WorkloadConfig> = by_target.into_values().collect();
    rows.sort_by(|a, b| {
        b.failed
            .rank()
            .cmp(&a.failed.rank())
            .then_with(|| a.target.cmp(&b.target))
    });
    rows
}

/// The controllers of the ReplicaSets or Jobs in `namespace` (`None`:
/// all), metadata only, at most [`MAX_OWNERS`]. Errors leave them out: the
/// rows then name the ReplicaSet.
async fn owners_of<K>(
    client: &Client,
    namespace: Option<&str>,
    kind: &str,
    owner: &str,
    out: &mut Owners,
) where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug,
    <K as kube::Resource>::DynamicType: Default,
{
    let api: Api<K> = match namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut read = 0usize;
    let mut token: Option<String> = None;
    loop {
        let mut lp = ListParams::default().limit(500);
        lp.continue_token = token.take();
        let Ok(list) = api.list_metadata(&lp).await else {
            return;
        };
        for item in &list.items {
            read += 1;
            let m = &item.metadata;
            let controller = m
                .owner_references
                .iter()
                .flatten()
                .find(|o| o.controller == Some(true) && o.kind == owner);
            if let (Some(o), Some(ns), Some(name)) = (controller, &m.namespace, &m.name) {
                out.insert(
                    (clean(ns), kind.to_string(), clean(name)),
                    (owner.to_string(), clean(&o.name)),
                );
            }
        }
        token = list.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() || read >= MAX_OWNERS {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Listing.
// ---------------------------------------------------------------------------

fn summary(state: VulnsState, namespace: &str) -> ConfigSummary {
    ConfigSummary {
        state,
        namespace: namespace.to_string(),
        namespaces_read: Vec::new(),
        workloads: Vec::new(),
        forbidden_namespaces: Vec::new(),
        all_namespaces_allowed: false,
        notes: Vec::new(),
    }
}

/// The workloads of `namespace` (`None`: every namespace the user may
/// read) with their failed checks. Asks discovery whether the CRD exists.
pub async fn workload_configs(client: &Client, namespace: Option<&str>) -> Result<ConfigSummary> {
    if let Some(ns) = namespace {
        check_namespace(ns)?;
    }
    let served = served(client)
        .await
        .map_err(|e| api_error("the API groups", e))?;
    let namespaces: Vec<String> = namespace.map(str::to_string).into_iter().collect();
    read(client, served, &namespaces).await
}

/// [`workload_configs`] for the app: whether the CRD exists comes from the
/// discovered kinds, and `namespaces` are the picker's (none: all).
pub async fn workload_configs_in_namespaces(
    client: &Client,
    kinds: &[ResourceKind],
    namespaces: &[String],
) -> Result<ConfigSummary> {
    let mut list: Vec<String> = Vec::new();
    for ns in namespaces.iter().filter(|n| !n.is_empty()) {
        check_namespace(ns)?;
        if !list.contains(ns) {
            list.push(ns.clone());
        }
    }
    let mut out = read(client, served_in(kinds), &list).await?;
    if out.state == VulnsState::Forbidden && !list.is_empty() {
        out.all_namespaces_allowed = can_list(client, GROUP, PLURAL, None).await;
    }
    Ok(out)
}

/// Which scopes to read (`None` when nothing may be read; the state is
/// set).
async fn scopes(
    client: &Client,
    namespaces: &[String],
    out: &mut ConfigSummary,
) -> Option<Vec<Option<String>>> {
    match namespaces {
        [] => match trivy::access_to(client, GROUP, PLURAL, None).await {
            Access::Scope => Some(vec![None]),
            Access::Namespaces(list) => {
                out.namespaces_read = list.clone();
                out.notes.push(format!(
                    "Not allowed to list ConfigAuditReports in all namespaces; read {}.",
                    list.join(", ")
                ));
                Some(list.into_iter().map(Some).collect())
            }
            Access::Denied => {
                out.state = VulnsState::Forbidden;
                None
            }
        },
        list => {
            let mut allowed = Vec::new();
            for ns in list {
                if can_list(client, GROUP, PLURAL, Some(ns)).await {
                    allowed.push(ns.clone());
                } else {
                    out.forbidden_namespaces.push(ns.clone());
                }
            }
            if allowed.is_empty() {
                out.state = VulnsState::Forbidden;
                return None;
            }
            if list.len() > 1 {
                out.namespaces_read = allowed.clone();
            }
            Some(allowed.into_iter().map(Some).collect())
        }
    }
}

async fn read(client: &Client, served: bool, namespaces: &[String]) -> Result<ConfigSummary> {
    let one = match namespaces {
        [one] => one.as_str(),
        _ => "",
    };
    if !served {
        return Ok(summary(VulnsState::NoOperator, one));
    }
    let mut out = summary(VulnsState::Ok, one);
    let Some(scopes) = scopes(client, namespaces, &mut out).await else {
        return Ok(out);
    };
    let mut left = MAX_REPORTS;
    let mut reports = Vec::new();
    let mut owners = Owners::new();
    let mut forbidden = 0usize;
    let mut cut = false;
    for scope in &scopes {
        if left == 0 {
            cut = true;
            break;
        }
        let path = url_path(GROUP, VERSION, PLURAL, scope.as_deref());
        let page = match paged::list_paged(client, &path, left, None, |r| Some(lite_row(r))).await {
            Ok(p) => p,
            Err(e) if is_forbidden(&e) => {
                forbidden += 1;
                if let Some(ns) = scope {
                    out.forbidden_namespaces.push(ns.clone());
                }
                continue;
            }
            Err(e) => return Err(api_error("ConfigAuditReports", e)),
        };
        cut |= page.more;
        left -= page.items.len().min(left);
        let kinds = |k: &str| page.items.iter().any(|r| r.target.kind == k);
        if kinds("ReplicaSet") {
            owners_of::<ReplicaSet>(
                client,
                scope.as_deref(),
                "ReplicaSet",
                "Deployment",
                &mut owners,
            )
            .await;
        }
        if kinds("Job") {
            owners_of::<Job>(client, scope.as_deref(), "Job", "CronJob", &mut owners).await;
        }
        reports.extend(page.items);
    }
    if forbidden == scopes.len() {
        out.state = VulnsState::Forbidden;
        out.notes.clear();
        return Ok(out);
    }
    if cut {
        out.notes.push(format!(
            "Only the first {MAX_REPORTS} ConfigAuditReports were read; narrow with -n."
        ));
    }
    if reports.is_empty() {
        out.state = VulnsState::NoReports;
    }
    out.workloads = merge(reports, &owners);
    Ok(out)
}

/// The failed checks of `row` (a row of a listing): one request.
pub async fn config_detail(client: &Client, row: WorkloadConfig) -> Result<ConfigDetail> {
    check_namespace(&row.report_namespace)?;
    check_object_name(&row.report_name)?;
    let path = url_path(GROUP, VERSION, PLURAL, Some(&row.report_namespace));
    let raw: Raw<FullBody> = paged::get(client, &path, &row.report_name)
        .await
        .map_err(|e| api_error(&format!("ConfigAuditReport {}", row.report_name), e))?;
    let mut d = detail(raw);
    // The row as listed (named after the Deployment, with its report count).
    d.workload = row;
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<WorkloadConfig> {
        parse_list(include_bytes!("testdata/configaudit-reports.json")).unwrap()
    }

    #[test]
    fn a_page_is_reduced_to_counts() {
        let r = rows();
        assert_eq!(r.len(), 3);
        let web = &r[0];
        assert_eq!(
            web.target,
            ConfigTarget {
                kind: "ReplicaSet".into(),
                namespace: "shop".into(),
                name: "web-5f6b7c".into()
            }
        );
        assert_eq!(web.failed.high, 1);
        assert_eq!(web.failed.medium, 2);
        assert_eq!(web.failed.low, 3);
        assert_eq!(web.scanner, "Trivy 0.69.3");
        assert_eq!(web.scanned_at, secs("2026-11-20T10:00:00Z"));
        assert_eq!(web.report_name, "replicaset-web-5f6b7c");
        // No updateTimestamp: the creation time.
        assert_eq!(r[2].scanned_at, secs("2026-11-18T08:00:00Z"));
    }

    #[test]
    fn replicasets_are_named_after_their_deployment_and_the_newest_wins() {
        let mut owners = Owners::new();
        for rs in ["web-5f6b7c", "web-old"] {
            owners.insert(
                ("shop".into(), "ReplicaSet".into(), rs.into()),
                ("Deployment".into(), "web".into()),
            );
        }
        let merged = merge(rows(), &owners);
        assert_eq!(merged.len(), 2);
        let web = &merged[0];
        assert_eq!(web.target.kind, "Deployment");
        assert_eq!(web.target.name, "web");
        assert_eq!(web.reports, 2);
        // The newer report's counts, not the old ReplicaSet's.
        assert_eq!(web.report_name, "replicaset-web-5f6b7c");
        assert_eq!(web.failed.high, 1);
        // Without an owner the report's own name stays.
        let merged = merge(rows(), &Owners::new());
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn a_full_report_keeps_the_failed_checks_worst_first() {
        let d = parse_report(include_bytes!("testdata/configaudit-report-web.json")).unwrap();
        assert_eq!(d.passed, 1);
        assert_eq!(d.failed.len(), 3);
        let first = &d.failed[0];
        assert_eq!(first.id, "KSV014");
        assert_eq!(first.severity, Severity::High);
        assert_eq!(first.title, "Root file system is not read-only");
        assert_eq!(
            first.remediation,
            "Change 'containers[].securityContext.readOnlyRootFilesystem' to 'true'."
        );
        assert_eq!(first.container, "nginx");
        assert_eq!(first.messages.len(), 1);
        assert_eq!(d.failed[1].severity, Severity::Medium);
        assert_eq!(d.failed[2].severity, Severity::Low);
        assert_eq!(d.failed[2].container, "");
    }

    #[test]
    fn report_text_is_clean() {
        let dirty = "a\u{202E}b\u{200B}c\u{1b}[31md\ne";
        let json = serde_json::json!({
            "metadata": { "name": dirty, "namespace": "shop", "labels": {
                "trivy-operator.resource.kind": dirty, "trivy-operator.resource.name": dirty } },
            "report": { "scanner": { "name": dirty, "version": dirty },
                "checks": [{ "checkID": dirty, "title": dirty, "severity": "HIGH", "category": dirty,
                    "description": dirty, "remediation": dirty, "messages": [dirty], "success": false,
                    "scope": { "type": "Container", "value": dirty } }] }
        });
        let d = parse_report(json.to_string().as_bytes()).unwrap();
        let c = &d.failed[0];
        let w = &d.workload;
        for t in [
            &w.target.kind,
            &w.target.name,
            &w.report_name,
            &w.scanner,
            &c.id,
            &c.title,
            &c.category,
            &c.description,
            &c.remediation,
            &c.messages[0],
            &c.container,
        ] {
            assert!(
                !t.contains(['\u{202E}', '\u{200B}', '\u{1b}', '\n']),
                "{t:?}"
            );
        }
    }

    #[test]
    fn list_paths() {
        assert_eq!(
            url_path(GROUP, VERSION, PLURAL, Some("shop")),
            "/apis/aquasecurity.github.io/v1alpha1/namespaces/shop/configauditreports"
        );
    }
}
