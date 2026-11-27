//! Kubescape's vulnerability scans (#538): `VulnerabilityManifestSummary`
//! (`spdx.softwarecomposition.kubescape.io/v1beta1`, one per workload
//! container, in the workload's namespace) for a listing, and the
//! `VulnerabilityManifest` it points to (a Grype document) for one image.
//!
//! The fields, from kubescape/storage's v1beta1 types and what kubevuln
//! writes (`repositories/apiserver.go`):
//!
//! - `spec.severities.{critical,high,medium,low,negligible,unknown}.all`:
//!   the counts (`relevant`: of those, the ones in use at runtime).
//! - `spec.vulnerabilitiesRef.all.{namespace,name}`: the full manifest
//!   (usually in the `kubescape` namespace).
//! - labels `kubescape.io/workload-{kind,name,namespace,container-name}`;
//!   the kind is lowercase (`deployment`).
//! - annotations `kubescape.io/image-id` (`repo@sha256:...`),
//!   `kubescape.io/image-tag` (`nginx:1.27`) and `kubescape.io/timestamp`
//!   (the scan, unix seconds).
//!
//! A summary counts by severity only: whether a vulnerability has a fix is
//! in the manifest, read only when one image is shown. Grype's
//! "Negligible" counts as low.

use super::paged::{self, url_path};
use super::trivy_operator::{clean, safe_link, secs, ReportSummary};
use super::{Severity, SeverityCounts, Vulnerability, Workload};
use kube::Client;
use serde::Deserialize;
use std::collections::BTreeMap;

pub const GROUP: &str = "spdx.softwarecomposition.kubescape.io";
pub const VERSION: &str = "v1beta1";
pub const PLURAL: &str = "vulnerabilitymanifestsummaries";
pub const MANIFESTS: &str = "vulnerabilitymanifests";
/// The resourceVersion that makes Kubescape's storage send the spec in a
/// list: without it every item is metadata only
/// (`softwarecomposition.ResourceVersionFullSpec`).
pub const FULL_SPEC: &str = "fullSpec";
/// Where kubevuln keeps the manifests when a summary does not say.
const DEFAULT_NAMESPACE: &str = "kubescape";
/// Most vulnerabilities kept of one manifest.
pub const MAX_MATCHES: usize = 5000;

/// Whether the cluster serves the summaries (one discovery request).
pub async fn served(client: &Client) -> kube::Result<bool> {
    paged::served(client, GROUP, VERSION, PLURAL).await
}

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
struct Counter {
    all: i64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Severities {
    critical: Counter,
    high: Counter,
    medium: Counter,
    low: Counter,
    negligible: Counter,
    unknown: Counter,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ObjRef {
    namespace: String,
    name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Refs {
    all: ObjRef,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Spec {
    severities: Severities,
    vulnerabilities_ref: Refs,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawSummary {
    metadata: Meta,
    spec: Spec,
}

fn count(c: &Counter) -> u32 {
    u32::try_from(c.all.max(0)).unwrap_or(u32::MAX)
}

/// `deployment` -> `Deployment`, as the pods' owners name kinds.
fn kind_name(kind: &str) -> String {
    match kind.trim().to_ascii_lowercase().as_str() {
        "deployment" => "Deployment".into(),
        "statefulset" => "StatefulSet".into(),
        "daemonset" => "DaemonSet".into(),
        "replicaset" => "ReplicaSet".into(),
        "job" => "Job".into(),
        "cronjob" => "CronJob".into(),
        "pod" => "Pod".into(),
        "" => String::new(),
        other => {
            let mut c = other.chars();
            c.next()
                .map(|f| f.to_ascii_uppercase().to_string() + c.as_str())
                .unwrap_or_default()
        }
    }
}

fn get<'a>(m: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    m.get(key).map_or("", String::as_str)
}

/// One summary as a listing row's report, `None` for a stub (a scan that
/// failed or was skipped: no counts and no manifest).
fn summarize(raw: RawSummary) -> Option<ReportSummary> {
    let m = &raw.metadata;
    let s = &raw.spec.severities;
    let r = &raw.spec.vulnerabilities_ref.all;
    if r.name.trim().is_empty() {
        return None;
    }
    let counts = SeverityCounts {
        critical: count(&s.critical),
        high: count(&s.high),
        medium: count(&s.medium),
        low: count(&s.low).saturating_add(count(&s.negligible)),
        unknown: count(&s.unknown),
    };
    let image_id = get(&m.annotations, "kubescape.io/image-id");
    let tag_ref = get(&m.annotations, "kubescape.io/image-tag");
    let reference = if tag_ref.is_empty() {
        image_id.split_once('@').map_or(image_id, |(r, _)| r)
    } else {
        tag_ref
    };
    let last = reference.rsplit('/').next().unwrap_or(reference);
    let tagged = !tag_ref.is_empty() && last.contains(':');
    let scanned_at = match get(&m.annotations, "kubescape.io/timestamp")
        .trim()
        .parse::<i64>()
    {
        Ok(t) if t > 0 => t,
        _ => secs(&m.creation_timestamp),
    };
    let namespace = match get(&m.labels, "kubescape.io/workload-namespace") {
        "" => m.namespace.as_str(),
        ns => ns,
    };
    let report_ns = match r.namespace.trim() {
        "" => DEFAULT_NAMESPACE,
        ns => ns,
    };
    Some(ReportSummary {
        namespace: clean(report_ns),
        name: clean(&r.name),
        owner: Workload {
            kind: clean(&kind_name(get(&m.labels, "kubescape.io/workload-kind"))),
            namespace: clean(namespace),
            name: clean(get(&m.labels, "kubescape.io/workload-name")),
            container: clean(get(&m.labels, "kubescape.io/workload-container-name")),
        },
        reference: clean(reference),
        tagged,
        digest: clean(&super::images::image_digest(image_id)),
        scanner: "Kubescape".to_string(),
        scanned_at,
        counts,
        fixable: SeverityCounts::default(),
    })
}

/// Parse a `VulnerabilityManifestSummaryList` page (stubs left out).
pub fn parse_list(json: &[u8]) -> serde_json::Result<Vec<ReportSummary>> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct List {
        items: Vec<RawSummary>,
    }
    let list: List = serde_json::from_slice(json)?;
    Ok(list.items.into_iter().filter_map(summarize).collect())
}

/// The summaries in `namespace` (`None`: all), at most `cap` read.
pub async fn list_summaries(
    client: &Client,
    namespace: Option<&str>,
    cap: usize,
) -> kube::Result<super::trivy_operator::Listed> {
    let path = url_path(GROUP, VERSION, PLURAL, namespace);
    let page = paged::list_paged(client, &path, cap, Some(FULL_SPEC), summarize).await?;
    Ok(super::trivy_operator::Listed {
        reports: page.items,
        more: page.more,
    })
}

// ---------------------------------------------------------------------------
// The manifest: a Grype document, only the fields shown.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Fix {
    versions: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CvssMetrics {
    #[serde(rename = "baseScore")]
    base_score: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Cvss {
    metrics: CvssMetrics,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct GrypeVuln {
    id: String,
    severity: String,
    description: String,
    data_source: String,
    fix: Fix,
    cvss: Vec<Cvss>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct GrypeArtifact {
    name: String,
    version: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Match {
    vulnerability: GrypeVuln,
    artifact: GrypeArtifact,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Payload {
    matches: Vec<Match>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ManifestSpec {
    payload: Payload,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawManifest {
    spec: ManifestSpec,
}

/// Grype's words: `Negligible` is low here.
fn severity(s: &str) -> Severity {
    if s.trim().eq_ignore_ascii_case("negligible") {
        Severity::Low
    } else {
        Severity::parse(s)
    }
}

/// Most characters of a title made from a description.
const MAX_TITLE: usize = 120;

fn title(description: &str) -> String {
    let d = clean(description);
    if d.chars().count() <= MAX_TITLE {
        return d;
    }
    let cut: String = d.chars().take(MAX_TITLE - 1).collect();
    format!("{}…", cut.trim_end())
}

fn vulnerability(m: Match) -> Vulnerability {
    let v = m.vulnerability;
    // The lowest version that fixes it: Grype lists them in order.
    let fixed = v
        .fix
        .versions
        .iter()
        .map(|f| clean(f))
        .find(|f| !f.is_empty())
        .unwrap_or_default();
    let score = v
        .cvss
        .iter()
        .filter_map(|c| c.metrics.base_score)
        .filter(|s| s.is_finite())
        .fold(0.0_f64, f64::max);
    Vulnerability {
        id: clean(&v.id),
        package: clean(&m.artifact.name),
        installed_version: clean(&m.artifact.version),
        fixed_version: fixed,
        severity: severity(&v.severity),
        score,
        title: title(&v.description),
        link: safe_link(&v.data_source),
    }
}

/// Parse one `VulnerabilityManifest` into its vulnerabilities (at most
/// [`MAX_MATCHES`]).
pub fn parse_manifest(json: &[u8]) -> serde_json::Result<Vec<Vulnerability>> {
    serde_json::from_slice(json).map(vulnerabilities)
}

/// The vulnerabilities of one manifest.
pub async fn get_manifest(
    client: &Client,
    namespace: &str,
    name: &str,
) -> kube::Result<Vec<Vulnerability>> {
    let path = url_path(GROUP, VERSION, MANIFESTS, Some(namespace));
    paged::get(client, &path, name).await.map(vulnerabilities)
}

fn vulnerabilities(raw: RawManifest) -> Vec<Vulnerability> {
    raw.spec
        .payload
        .matches
        .into_iter()
        .take(MAX_MATCHES)
        .map(vulnerability)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// How the fake API server answers a list of summaries.
    #[derive(Clone, Copy)]
    enum Server {
        /// Kubescape's storage: `total` summaries, with their spec only
        /// when the request has `resourceVersion=fullSpec`.
        Storage { total: usize },
        /// A plain CRD: 400 for `resourceVersion=fullSpec`.
        Crd { total: usize },
        /// Empty pages with a continue token, for ever.
        Endless,
        /// Discovery of Kubescape's group answers 503 (its APIService is
        /// down); the Trivy Operator's is 404.
        Unavailable,
    }

    fn summary_json(i: usize, full: bool) -> serde_json::Value {
        let mut item = serde_json::json!({
            "metadata": { "name": format!("s{i}"), "namespace": "shop",
                "labels": { "kubescape.io/workload-kind": "deployment",
                    "kubescape.io/workload-name": format!("w{i}"),
                    "kubescape.io/workload-namespace": "shop",
                    "kubescape.io/workload-container-name": "app" } }
        });
        if full {
            item["spec"] = serde_json::json!({
                "severities": { "high": { "all": 1 } },
                "vulnerabilitiesRef": { "all": { "name": format!("m{i}"), "namespace": "kubescape" } }
            });
        }
        item
    }

    fn server(kind: Server) -> (Client, Arc<Mutex<Vec<String>>>) {
        use kube::client::Body;
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
            let full = param("resourceVersion").as_deref() == Some(FULL_SPEC);
            let status = |code: u16| {
                (
                    code,
                    serde_json::json!({ "kind": "Status", "apiVersion": "v1", "status": "Failure",
                        "code": code, "message": "no" }),
                )
            };
            let (code, body) = match kind {
                // The Trivy Operator's group is not there at all.
                Server::Unavailable if path.contains("aquasecurity") => status(404),
                Server::Unavailable => status(503),
                Server::Crd { .. } if full => status(400),
                Server::Endless => (
                    200,
                    serde_json::json!({ "metadata": { "continue": "more" }, "items": [] }),
                ),
                Server::Storage { total } | Server::Crd { total } => {
                    // A CRD always has the spec; the storage only with fullSpec.
                    let spec = full || matches!(kind, Server::Crd { .. });
                    let limit: usize = param("limit").and_then(|l| l.parse().ok()).unwrap_or(total);
                    let start: usize = param("continue").and_then(|c| c.parse().ok()).unwrap_or(0);
                    let end = (start + limit).min(total);
                    let items: Vec<_> = (start..end).map(|i| summary_json(i, spec)).collect();
                    let token = if end < total {
                        end.to_string()
                    } else {
                        String::new()
                    };
                    (
                        200,
                        serde_json::json!({ "metadata": { "continue": token }, "items": items }),
                    )
                }
            };
            let mut resp = http::Response::new(Body::from(body.to_string().into_bytes()));
            *resp.status_mut() = http::StatusCode::from_u16(code).unwrap();
            std::future::ready(Ok::<_, std::convert::Infallible>(resp))
        });
        (Client::new(svc, "default"), seen)
    }

    /// Kubescape's storage sends the spec only for `resourceVersion=fullSpec`:
    /// every page asks for it, continue pages too.
    #[tokio::test]
    async fn every_page_asks_for_the_full_spec() {
        let (client, seen) = server(Server::Storage { total: 45 });
        let listed = list_summaries(&client, Some("shop"), 2000).await.unwrap();
        assert_eq!(listed.reports.len(), 45);
        assert!(!listed.more);
        assert_eq!(listed.reports[0].counts.high, 1);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "{seen:?}");
        for r in seen.iter() {
            assert!(r.contains("resourceVersion=fullSpec"), "{r}");
            assert!(r.contains("limit=20"), "{r}");
            assert!(!r.contains("resourceVersionMatch"), "{r}");
        }
        assert!(seen[1].contains("continue=20"), "{seen:?}");
    }

    /// A plain CRD (the test stand-ins) refuses `fullSpec`: asked again
    /// without it, and the later pages go without it too.
    #[tokio::test]
    async fn a_crd_that_refuses_full_spec_is_asked_without_it() {
        let (client, seen) = server(Server::Crd { total: 25 });
        let listed = list_summaries(&client, None, 2000).await.unwrap();
        assert_eq!(listed.reports.len(), 25);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3, "{seen:?}");
        assert!(seen[0].contains("resourceVersion=fullSpec"));
        assert!(!seen[1].contains("resourceVersion"), "{seen:?}");
        assert!(!seen[2].contains("resourceVersion"), "{seen:?}");
    }

    /// Empty pages that always continue end the read.
    #[tokio::test]
    async fn endless_empty_pages_end() {
        let (client, seen) = server(Server::Endless);
        let listed = list_summaries(&client, None, 40).await.unwrap();
        assert!(listed.more);
        assert!(listed.reports.is_empty());
        assert!(seen.lock().unwrap().len() <= 12);
    }

    /// Kubescape's APIService down (503): not served, so a cluster with
    /// neither scanner says so instead of failing.
    #[tokio::test]
    async fn an_unavailable_api_service_is_not_served() {
        let (client, _) = server(Server::Unavailable);
        assert!(!served(&client).await.unwrap());
        let args = crate::image_security::VulnsArgs::default();
        let s = crate::image_security::image_vulns(&client, &args)
            .await
            .unwrap();
        assert_eq!(s.state, crate::image_security::VulnsState::NoOperator);
    }

    #[test]
    fn a_summary_page_is_read_as_kubevuln_writes_it() {
        let list = parse_list(include_bytes!("testdata/kubescape-summaries.json")).unwrap();
        // The stub (a scan that failed) is left out.
        assert_eq!(list.len(), 2);
        let web = &list[0];
        assert_eq!(web.namespace, "kubescape");
        assert_eq!(web.name, "docker.io-library-nginx-1.27-abcdef");
        assert_eq!(
            web.owner,
            Workload {
                kind: "Deployment".into(),
                namespace: "shop".into(),
                name: "web".into(),
                container: "nginx".into(),
            }
        );
        assert_eq!(web.reference, "docker.io/library/nginx:1.27");
        assert!(web.tagged);
        assert_eq!(web.digest, "sha256:1111");
        assert_eq!(web.scanner, "Kubescape");
        assert_eq!(web.scanned_at, 1_795_000_000);
        assert_eq!(web.counts.critical, 1);
        assert_eq!(web.counts.high, 2);
        // Negligible counts as low.
        assert_eq!(web.counts.low, 3);
        assert_eq!(web.fixable.total(), 0);
        // No timestamp annotation, no manifest namespace: the creation
        // time and the operator's namespace.
        let api = &list[1];
        assert_eq!(api.namespace, "kubescape");
        assert_eq!(api.scanned_at, secs("2026-11-18T08:00:00Z"));
        assert_eq!(api.owner.kind, "StatefulSet");
        assert!(!api.tagged);
        assert_eq!(api.reference, "ghcr.io/acme/api");
    }

    #[test]
    fn a_manifest_gives_fixes_scores_and_safe_links() {
        let v = parse_manifest(include_bytes!("testdata/kubescape-manifest.json")).unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].id, "CVE-2026-0001");
        assert_eq!(v[0].package, "openssl");
        assert_eq!(v[0].installed_version, "3.0.11-1");
        assert_eq!(v[0].fixed_version, "3.0.15-1");
        assert_eq!(v[0].severity, Severity::Critical);
        assert_eq!(v[0].score, 9.8);
        assert_eq!(
            v[0].link,
            "https://security-tracker.debian.org/tracker/CVE-2026-0001"
        );
        // Not fixed, a long description cut, a link that is not http(s).
        assert_eq!(v[1].fixed_version, "");
        assert!(v[1].title.ends_with('…'), "{}", v[1].title);
        assert!(v[1].title.chars().count() <= MAX_TITLE);
        assert_eq!(v[1].link, "");
        assert_eq!(v[2].severity, Severity::Low);
    }

    #[test]
    fn cluster_text_is_cleaned() {
        let dirty = "a\u{202E}b\u{1b}[31mc\nd";
        let json = serde_json::json!({ "items": [{
            "metadata": { "name": "s", "namespace": "shop",
                "labels": { "kubescape.io/workload-kind": dirty, "kubescape.io/workload-name": dirty,
                    "kubescape.io/workload-container-name": dirty },
                "annotations": { "kubescape.io/image-tag": dirty, "kubescape.io/image-id": dirty } },
            "spec": { "vulnerabilitiesRef": { "all": { "name": dirty, "namespace": dirty } } }
        }]});
        let list = parse_list(json.to_string().as_bytes()).unwrap();
        let r = &list[0];
        for t in [
            &r.name,
            &r.namespace,
            &r.owner.kind,
            &r.owner.name,
            &r.owner.container,
            &r.reference,
        ] {
            assert!(!t.contains(['\u{202E}', '\u{1b}', '\n']), "{t:?}");
        }
    }

    #[test]
    fn kinds_are_named_as_the_pods_name_them() {
        assert_eq!(kind_name("deployment"), "Deployment");
        assert_eq!(kind_name("cronjob"), "CronJob");
        assert_eq!(kind_name("rollout"), "Rollout");
        assert_eq!(kind_name(""), "");
    }
}
