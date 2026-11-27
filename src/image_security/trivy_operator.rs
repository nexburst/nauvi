//! The Trivy Operator's `VulnerabilityReport`s: whether the cluster serves
//! them, where the user may list them, and reading them.
//!
//! A listing reads the reports in small pages and keeps only counts of
//! each (its vulnerability list is reduced to severity and "has a fix" as
//! it is parsed), so a namespace of large reports never sits in memory. One
//! full report is read only when it is shown.

use super::{Severity, SeverityCounts, Vulnerability, Workload};
use crate::resources::{can_list, ResourceKind};
use kube::api::ListParams;
use kube::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::BTreeMap;

pub const GROUP: &str = "aquasecurity.github.io";
pub const VERSION: &str = "v1alpha1";
pub const PLURAL: &str = "vulnerabilityreports";
/// Reports asked for per request: a report can hold thousands of
/// vulnerabilities, so pages stay small.
pub const PAGE_SIZE: u32 = 20;
/// Most reports one listing reads.
pub const MAX_REPORTS: usize = 2000;

/// Whether discovery found the VulnerabilityReport kind (for a caller that
/// already has the discovered kinds, like the app).
pub fn served_in(kinds: &[ResourceKind]) -> bool {
    kinds
        .iter()
        .any(|k| k.resource.group == GROUP && k.resource.plural == PLURAL)
}

/// Whether the cluster serves VulnerabilityReports: one discovery request
/// for the group version. A 404 means no Trivy Operator CRD.
pub async fn served(client: &Client) -> kube::Result<bool> {
    match client
        .list_api_group_resources(&format!("{GROUP}/{VERSION}"))
        .await
    {
        Ok(list) => Ok(list.resources.iter().any(|r| r.name == PLURAL)),
        Err(kube::Error::Api(resp)) if resp.code == 404 => Ok(false),
        Err(e) => Err(e),
    }
}

/// Where the reports may be listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    /// In the namespace asked for, or across all namespaces.
    Scope,
    /// Not across the cluster, but in these namespaces.
    Namespaces(Vec<String>),
    /// Nowhere in the scope asked for.
    Denied,
}

/// Most namespaces checked one by one when the cluster-wide list is
/// forbidden.
const MAX_CHECKED_NAMESPACES: usize = 50;

/// Where the user may list the reports: in `namespace`, or across the
/// cluster, else namespace by namespace (the namespaces they may list, or
/// the context's own namespace).
pub async fn access(client: &Client, namespace: Option<&str>) -> Access {
    if let Some(ns) = namespace {
        return if can_list(client, GROUP, PLURAL, Some(ns)).await {
            Access::Scope
        } else {
            Access::Denied
        };
    }
    if can_list(client, GROUP, PLURAL, None).await {
        return Access::Scope;
    }
    let mut candidates: Vec<String> = match crate::list_namespaces_if_allowed(client).await {
        Ok(Some(list)) => list.into_iter().map(|n| n.name).collect(),
        _ => Vec::new(),
    };
    let own = client.default_namespace().to_string();
    if !candidates.contains(&own) {
        candidates.insert(0, own);
    }
    let mut allowed = Vec::new();
    for ns in candidates.into_iter().take(MAX_CHECKED_NAMESPACES) {
        if can_list(client, GROUP, PLURAL, Some(&ns)).await {
            allowed.push(ns);
        }
    }
    if allowed.is_empty() {
        Access::Denied
    } else {
        Access::Namespaces(allowed)
    }
}

// ---------------------------------------------------------------------------
// The report as it is stored, only the fields nauvi uses.
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
#[serde(default)]
struct Artifact {
    repository: String,
    tag: String,
    digest: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Registry {
    server: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Scanner {
    name: String,
    version: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Summary {
    critical_count: u32,
    high_count: u32,
    medium_count: u32,
    low_count: u32,
    unknown_count: u32,
}

/// What a listing keeps of a vulnerability.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LiteVuln {
    severity: String,
    fixed_version: String,
}

/// A vulnerability as shown.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FullVuln {
    #[serde(rename = "vulnerabilityID")]
    vulnerability_id: String,
    resource: String,
    installed_version: String,
    fixed_version: String,
    severity: String,
    score: Option<f64>,
    title: String,
    primary_link: String,
}

#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Body<V> {
    artifact: Artifact,
    registry: Registry,
    scanner: Scanner,
    summary: Summary,
    update_timestamp: String,
    vulnerabilities: Vec<V>,
}

impl<V> Default for Body<V> {
    fn default() -> Self {
        Body {
            artifact: Artifact::default(),
            registry: Registry::default(),
            scanner: Scanner::default(),
            summary: Summary::default(),
            update_timestamp: String::new(),
            vulnerabilities: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct Raw<V> {
    metadata: Meta,
    report: Body<V>,
}

impl<V> Default for Raw<V> {
    fn default() -> Self {
        Raw {
            metadata: Meta::default(),
            report: Body::default(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ListMeta {
    #[serde(rename = "continue")]
    continue_: String,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct RawList<V> {
    metadata: ListMeta,
    items: Vec<Raw<V>>,
}

impl<V> Default for RawList<V> {
    fn default() -> Self {
        RawList {
            metadata: ListMeta::default(),
            items: Vec::new(),
        }
    }
}

/// One report, reduced to what a listing shows.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportSummary {
    pub namespace: String,
    pub name: String,
    /// The workload container the operator scanned (its labels), e.g.
    /// ReplicaSet `web-5f6b7c`, container `nginx`.
    pub owner: Workload,
    /// `index.docker.io/library/nginx:1.27`, from the artifact.
    pub reference: String,
    /// The artifact has a tag (a reference without one is not `:latest`).
    pub tagged: bool,
    /// `sha256:...`, empty when the report has none.
    pub digest: String,
    /// `Trivy 0.58.1`.
    pub scanner: String,
    /// `updateTimestamp`, else the report's creation (unix seconds), 0
    /// when neither parses.
    pub scanned_at: i64,
    pub counts: SeverityCounts,
    pub fixable: SeverityCounts,
}

/// One full report.
#[derive(Debug, Clone, PartialEq)]
pub struct FullReport {
    pub summary: ReportSummary,
    pub vulnerabilities: Vec<Vulnerability>,
}

/// Cluster text on one line, without control, bidi or zero-width
/// characters: every string a report gives goes through it, so the JSON
/// output and the app get clean text too, not only the table.
fn clean(s: &str) -> String {
    crate::text::single_line(s)
}

fn secs(ts: &str) -> i64 {
    ts.parse::<jiff::Timestamp>()
        .map(|t| t.as_second())
        .unwrap_or(0)
}

/// A label of the report, else the annotation of the same name (the
/// operator moves names longer than a label value allows there).
fn label<'a>(m: &'a Meta, key: &str) -> &'a str {
    m.labels
        .get(key)
        .filter(|v| !v.is_empty())
        .or_else(|| m.annotations.get(key))
        .map_or("", String::as_str)
}

fn summarize<V>(raw: &Raw<V>, fixable: SeverityCounts) -> ReportSummary {
    let m = &raw.metadata;
    let r = &raw.report;
    let mut reference = String::new();
    if !r.registry.server.is_empty() {
        reference.push_str(&r.registry.server);
        reference.push('/');
    }
    reference.push_str(&r.artifact.repository);
    if !r.artifact.tag.is_empty() {
        reference.push(':');
        reference.push_str(&r.artifact.tag);
    }
    let scanned_at = match secs(&r.update_timestamp) {
        0 => secs(&m.creation_timestamp),
        t => t,
    };
    let s = &r.summary;
    let namespace = match label(m, "trivy-operator.resource.namespace") {
        "" => m.namespace.as_str(),
        ns => ns,
    };
    ReportSummary {
        namespace: clean(&m.namespace),
        name: clean(&m.name),
        owner: Workload {
            kind: clean(label(m, "trivy-operator.resource.kind")),
            namespace: clean(namespace),
            name: clean(label(m, "trivy-operator.resource.name")),
            container: clean(label(m, "trivy-operator.container.name")),
        },
        reference: clean(&reference),
        tagged: !r.artifact.tag.trim().is_empty(),
        digest: clean(&r.artifact.digest),
        scanner: clean(&format!("{} {}", r.scanner.name, r.scanner.version)),
        scanned_at,
        counts: SeverityCounts {
            critical: s.critical_count,
            high: s.high_count,
            medium: s.medium_count,
            low: s.low_count,
            unknown: s.unknown_count,
        },
        fixable,
    }
}

/// An advisory link as shown: an `http(s)://` URL with a host and no user
/// info, else empty.
pub fn safe_link(s: &str) -> String {
    let s = s.trim();
    if s.chars().any(|c| c.is_whitespace() || c.is_control()) || s != clean(s) {
        return String::new();
    }
    let Ok(uri) = s.parse::<http::Uri>() else {
        return String::new();
    };
    let scheme_ok = matches!(uri.scheme_str(), Some("https") | Some("http"));
    let host_ok = uri
        .authority()
        .is_some_and(|a| !a.as_str().contains('@') && !a.host().is_empty());
    if scheme_ok && host_ok {
        s.to_string()
    } else {
        String::new()
    }
}

fn lite_summary(raw: Raw<LiteVuln>) -> ReportSummary {
    let mut fixable = SeverityCounts::default();
    for v in &raw.report.vulnerabilities {
        if !clean(&v.fixed_version).is_empty() {
            fixable.add(Severity::parse(&v.severity));
        }
    }
    summarize(&raw, fixable)
}

fn full_report(raw: Raw<FullVuln>) -> FullReport {
    let vulnerabilities: Vec<Vulnerability> = raw
        .report
        .vulnerabilities
        .iter()
        .map(|v| Vulnerability {
            id: clean(&v.vulnerability_id),
            package: clean(&v.resource),
            installed_version: clean(&v.installed_version),
            fixed_version: clean(&v.fixed_version),
            severity: Severity::parse(&v.severity),
            score: v.score.filter(|s| s.is_finite()).unwrap_or(0.0),
            title: clean(&v.title),
            link: safe_link(&v.primary_link),
        })
        .collect();
    let mut fixable = SeverityCounts::default();
    for v in vulnerabilities
        .iter()
        .filter(|v| !v.fixed_version.is_empty())
    {
        fixable.add(v.severity);
    }
    FullReport {
        summary: summarize(&raw, fixable),
        vulnerabilities,
    }
}

/// Parse a `VulnerabilityReportList` (a listing's page) into summaries and
/// its continue token.
pub fn parse_list(json: &[u8]) -> serde_json::Result<(Vec<ReportSummary>, String)> {
    let list: RawList<LiteVuln> = serde_json::from_slice(json)?;
    let token = list.metadata.continue_;
    Ok((list.items.into_iter().map(lite_summary).collect(), token))
}

/// Parse one full `VulnerabilityReport`.
pub fn parse_report(json: &[u8]) -> serde_json::Result<FullReport> {
    serde_json::from_slice::<Raw<FullVuln>>(json).map(full_report)
}

fn url_path(namespace: Option<&str>) -> String {
    match namespace {
        Some(ns) => format!("/apis/{GROUP}/{VERSION}/namespaces/{ns}/{PLURAL}"),
        None => format!("/apis/{GROUP}/{VERSION}/{PLURAL}"),
    }
}

async fn request<T: DeserializeOwned>(
    client: &Client,
    req: Result<http::Request<Vec<u8>>, kube::core::request::Error>,
) -> kube::Result<T> {
    let req = req.map_err(kube::Error::BuildRequest)?;
    client.request::<T>(req).await
}

/// The reports read by [`list_summaries`].
#[derive(Debug, Default)]
pub struct Listed {
    pub reports: Vec<ReportSummary>,
    /// More than [`MAX_REPORTS`] exist (or a continue token expired).
    pub more: bool,
}

/// The reports in `namespace` (`None`: all namespaces), as summaries, read
/// in pages of [`PAGE_SIZE`], at most `cap` (callers share [`MAX_REPORTS`]
/// across one call).
pub async fn list_summaries(
    client: &Client,
    namespace: Option<&str>,
    cap: usize,
) -> kube::Result<Listed> {
    let cap = cap.max(1);
    let path = url_path(namespace);
    let mut out = Listed::default();
    let mut token = String::new();
    loop {
        let left = cap - out.reports.len();
        let mut lp = ListParams::default().limit(PAGE_SIZE.min(left as u32).max(1));
        let continuing = !token.is_empty();
        if continuing {
            lp.continue_token = Some(std::mem::take(&mut token));
        }
        let page = kube::core::Request::new(&path).list(&lp);
        let list: RawList<LiteVuln> = match request(client, page).await {
            Ok(l) => l,
            Err(kube::Error::Api(resp)) if continuing && resp.code == 410 => {
                out.more = true;
                return Ok(out);
            }
            Err(e) => return Err(e),
        };
        out.reports.extend(list.items.into_iter().map(lite_summary));
        token = list.metadata.continue_;
        if token.is_empty() {
            break;
        }
        if out.reports.len() >= cap {
            out.more = true;
            break;
        }
    }
    out.reports.truncate(cap);
    Ok(out)
}

/// One full report.
pub async fn get_report(client: &Client, namespace: &str, name: &str) -> kube::Result<FullReport> {
    let req = kube::core::Request::new(url_path(Some(namespace))).get(name, &Default::default());
    let raw: Raw<FullVuln> = request(client, req).await?;
    Ok(full_report(raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::client::Body;
    use std::sync::{Arc, Mutex};

    /// A fake API server: the group is served when `served`, with `total`
    /// reports in pages of what is asked for. Records each request.
    fn server(served: bool, total: usize) -> (Client, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let svc = tower::service_fn(move |req: http::Request<Body>| {
            let path = req.uri().path().to_string();
            let query = req.uri().query().unwrap_or_default().to_string();
            log.lock().unwrap().push(format!("{path}?{query}"));
            let param = |name: &str| {
                query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
                    .map(str::to_string)
            };
            let (code, body) = if !served {
                let status = serde_json::json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure",
                    "reason": "NotFound", "code": 404, "message": "the server could not find the requested resource",
                });
                (404, status)
            } else if path == "/apis/aquasecurity.github.io/v1alpha1" {
                (
                    200,
                    serde_json::json!({
                        "kind": "APIResourceList", "apiVersion": "v1",
                        "groupVersion": "aquasecurity.github.io/v1alpha1",
                        "resources": [{ "name": "vulnerabilityreports", "singularName": "vulnerabilityreport",
                            "namespaced": true, "kind": "VulnerabilityReport", "verbs": ["get", "list"] }]
                    }),
                )
            } else {
                let limit: usize = param("limit").and_then(|l| l.parse().ok()).unwrap_or(total);
                let start: usize = param("continue").and_then(|c| c.parse().ok()).unwrap_or(0);
                let end = (start + limit).min(total);
                let items: Vec<_> = (start..end)
                    .map(|i| {
                        serde_json::json!({
                            "metadata": { "name": format!("r{i}"), "namespace": "shop" },
                            "report": { "summary": { "highCount": 1 },
                                "vulnerabilities": [{ "severity": "HIGH", "fixedVersion": "2" }] }
                        })
                    })
                    .collect();
                let token = if end < total {
                    end.to_string()
                } else {
                    String::new()
                };
                (
                    200,
                    serde_json::json!({ "metadata": { "continue": token }, "items": items }),
                )
            };
            let mut resp = http::Response::new(Body::from(body.to_string().into_bytes()));
            *resp.status_mut() = http::StatusCode::from_u16(code).unwrap();
            std::future::ready(Ok::<_, std::convert::Infallible>(resp))
        });
        (Client::new(svc, "default"), seen)
    }

    #[tokio::test]
    async fn without_the_crd_there_is_no_operator() {
        let (client, seen) = server(false, 0);
        assert!(!served(&client).await.unwrap());
        let args = crate::image_security::VulnsArgs {
            namespace: Some("shop".into()),
            ..Default::default()
        };
        let s = crate::image_security::image_vulns(&client, &args)
            .await
            .unwrap();
        assert_eq!(s.state, crate::image_security::VulnsState::NoOperator);
        // One discovery request each, nothing else.
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn reports_are_read_in_small_pages() {
        let (client, seen) = server(true, 45);
        assert!(served(&client).await.unwrap());
        let listed = list_summaries(&client, Some("shop"), MAX_REPORTS)
            .await
            .unwrap();
        assert_eq!(listed.reports.len(), 45);
        assert!(!listed.more);
        assert_eq!(listed.reports[44].name, "r44");
        assert_eq!(listed.reports[0].fixable.high, 1);
        let seen = seen.lock().unwrap();
        let pages: Vec<_> = seen
            .iter()
            .filter(|r| r.contains("vulnerabilityreports"))
            .collect();
        assert_eq!(pages.len(), 3, "{pages:?}");
        assert!(pages.iter().all(|p| p.contains("limit=20")), "{pages:?}");
        assert!(pages[0].starts_with("/apis/aquasecurity.github.io/v1alpha1/namespaces/shop/"));
    }

    #[test]
    fn a_page_is_reduced_to_counts() {
        let (reports, token) = parse_list(include_bytes!("testdata/reports.json")).unwrap();
        assert_eq!(token, "next-page");
        assert_eq!(reports.len(), 3);
        let web = &reports[0];
        assert_eq!(web.namespace, "shop");
        assert_eq!(web.name, "replicaset-web-5f6b7c-nginx");
        assert_eq!(
            web.owner,
            Workload {
                kind: "ReplicaSet".into(),
                namespace: "shop".into(),
                name: "web-5f6b7c".into(),
                container: "nginx".into(),
            }
        );
        assert_eq!(web.reference, "index.docker.io/library/nginx:1.27");
        assert_eq!(web.digest, "sha256:1111");
        assert_eq!(web.scanner, "Trivy 0.58.1");
        assert_eq!(web.scanned_at, secs("2026-11-20T10:00:00Z"));
        // The summary's counts, not the list's (which may be cut).
        assert_eq!(web.counts.critical, 1);
        assert_eq!(web.counts.high, 2);
        assert_eq!(web.counts.total(), 6);
        assert_eq!(web.fixable.critical, 1);
        assert_eq!(web.fixable.high, 1);
        assert_eq!(web.fixable.total(), 3);
    }

    #[test]
    fn missing_fields_fall_back() {
        let (reports, _) = parse_list(include_bytes!("testdata/reports.json")).unwrap();
        // No digest, no updateTimestamp: the creation time; the long name
        // from the annotation.
        let cache = &reports[2];
        assert_eq!(cache.digest, "");
        assert_eq!(cache.scanned_at, secs("2026-11-18T08:00:00Z"));
        assert_eq!(cache.owner.name, "cache");
        assert_eq!(cache.counts.total(), 0);
    }

    #[test]
    fn a_full_report_keeps_what_is_shown() {
        let full = parse_report(include_bytes!("testdata/report-web.json")).unwrap();
        assert_eq!(full.vulnerabilities.len(), 6);
        let v = &full.vulnerabilities[0];
        assert_eq!(v.id, "CVE-2026-0001");
        assert_eq!(v.package, "openssl");
        assert_eq!(v.installed_version, "3.0.11-1");
        assert_eq!(v.fixed_version, "3.0.15-1");
        assert_eq!(v.severity, Severity::Critical);
        assert_eq!(v.score, 9.8);
        assert_eq!(v.link, "https://avd.aquasec.com/nvd/cve-2026-0001");
        // No score: 0.
        assert_eq!(full.vulnerabilities[5].score, 0.0);
        assert_eq!(full.summary.fixable.total(), 3);
    }

    /// Every string a report gives is clean in the types, so `-o json`
    /// and the app get it clean too, not only the table.
    #[test]
    fn report_text_is_clean_in_json() {
        let dirty = "a\u{202E}b\u{200B}c\u{1b}[31md\u{2066}e\nf";
        let report = serde_json::json!({
            "metadata": { "name": "r", "namespace": "shop", "labels": {
                "trivy-operator.resource.kind": dirty,
                "trivy-operator.resource.name": dirty,
                "trivy-operator.container.name": dirty } },
            "report": {
                "artifact": { "repository": dirty, "tag": dirty, "digest": dirty },
                "registry": { "server": dirty },
                "scanner": { "name": dirty, "version": dirty },
                "vulnerabilities": [{ "vulnerabilityID": dirty, "resource": dirty,
                    "installedVersion": dirty, "fixedVersion": dirty, "severity": "HIGH",
                    "title": dirty, "primaryLink": "https://x.example/\u{202E}a" }]
            }
        });
        let full = parse_report(report.to_string().as_bytes()).unwrap();
        let s = &full.summary;
        let v = &full.vulnerabilities[0];
        for text in [
            &s.owner.kind,
            &s.owner.name,
            &s.owner.container,
            &s.reference,
            &s.digest,
            &s.scanner,
            &v.id,
            &v.package,
            &v.installed_version,
            &v.fixed_version,
            &v.title,
        ] {
            assert!(text.starts_with("abc[31mde f"), "{text:?}");
        }
        assert_eq!(v.title, "abc[31mde f");
        assert_eq!(v.link, "");
        let json = serde_json::to_string(&full.vulnerabilities).unwrap();
        for bad in ['\u{202E}', '\u{200B}', '\u{1b}', '\u{2066}', '\n'] {
            assert!(!json.contains(bad), "{bad:?} in {json}");
        }
        // Escaped forms would be just as bad once decoded.
        assert!(!json.contains("\\u001b") && !json.contains("\\n"), "{json}");
    }

    #[test]
    fn only_plain_web_links_are_kept() {
        for ok in [
            "https://avd.aquasec.com/nvd/cve-2026-0001",
            "http://example.com/a?b=c#d",
        ] {
            assert_eq!(safe_link(ok), ok);
        }
        assert_eq!(safe_link("  https://a.example/x "), "https://a.example/x");
        for bad in [
            "",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://a.example/x",
            "https://user:pw@a.example/x",
            "https://a.example@b.example/",
            "https:///nohost",
            "//a.example/x",
            "/relative",
            "https://a.example/x y",
            "https://a.example/\u{202E}x",
            "data:text/html,hi",
        ] {
            assert_eq!(safe_link(bad), "", "{bad}");
        }
    }

    #[test]
    fn list_paths() {
        assert_eq!(
            url_path(Some("shop")),
            "/apis/aquasecurity.github.io/v1alpha1/namespaces/shop/vulnerabilityreports"
        );
        assert_eq!(
            url_path(None),
            "/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports"
        );
    }
}
