//! Usage history from Prometheus (#47 phase 2): find a Prometheus Service in
//! the cluster and run `query_range` through the API server's service proxy
//! (`/api/v1/namespaces/<ns>/services/<name>:<port>/proxy/...`) with the
//! existing client, so no port-forward or extra credentials are needed.
//!
//! The queries read the kubelet's cAdvisor metrics, which every common
//! Prometheus setup scrapes: `container_cpu_usage_seconds_total` (as a rate)
//! and `container_memory_working_set_bytes`, per container for pods and for
//! the root cgroup (`id="/"`) for nodes. The results come back as a
//! [`SeriesView`], the same shape as the metrics-server history, so the
//! charts draw either.

use crate::{is_forbidden, ContainerSeries, SeriesView, UsageSample};
use anyhow::{anyhow, Context, Result};
use k8s_openapi::api::core::v1::Service;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Service names that are Prometheus, best first: the kube-prometheus
/// (`prometheus-k8s`), kube-prometheus-stack and prometheus-operator (any
/// instance) Services, and the prometheus-community chart's server.
pub const PROMETHEUS_SERVICE_NAMES: &[&str] = &[
    "prometheus-k8s",
    "kube-prometheus-stack-prometheus",
    "prometheus-operated",
    "prometheus-server",
];

/// A Service with this label is taken when none has a well-known name.
pub const PROMETHEUS_LABEL: &str = "app.kubernetes.io/name=prometheus";

/// Where the well-known Services usually live, tried one by one when
/// Services may not be listed across the cluster.
const USUAL_NAMESPACES: &[&str] = &["monitoring", "prometheus", "kube-prometheus-stack"];

/// How long a chart waits for Prometheus before it falls back.
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The Settings value that turns Prometheus off for a context.
pub const PROMETHEUS_OFF: &str = "off";

/// A Prometheus Service and the port to reach it on (a port name or number).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrometheusTarget {
    pub namespace: String,
    pub name: String,
    pub port: String,
}

impl PrometheusTarget {
    /// Parse a Settings value: `namespace/service:port`, or
    /// `namespace/service` for port 9090.
    pub fn parse(s: &str) -> Option<Self> {
        let (namespace, rest) = s.trim().split_once('/')?;
        let (name, port) = match rest.split_once(':') {
            Some((name, port)) => (name, port),
            None => (rest, "9090"),
        };
        let ok = |v: &str| {
            !v.is_empty()
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        };
        (ok(namespace) && ok(name) && ok(port)).then(|| Self {
            namespace: namespace.into(),
            name: name.into(),
            port: port.into(),
        })
    }

    /// `namespace/service:port`, as Settings takes it.
    pub fn label(&self) -> String {
        format!("{}/{}:{}", self.namespace, self.name, self.port)
    }

    /// The API server path that proxies to `path` on this Service.
    pub fn proxy_path(&self, path: &str) -> String {
        format!(
            "/api/v1/namespaces/{}/services/{}:{}/proxy{}",
            self.namespace, self.name, self.port, path
        )
    }
}

/// The port of a Prometheus Service: the one named like Prometheus' web
/// port, else 9090, else the first one.
fn service_port(svc: &Service) -> Option<String> {
    let ports = svc.spec.as_ref()?.ports.as_ref()?;
    let named = |p: &&k8s_openapi::api::core::v1::ServicePort| {
        matches!(p.name.as_deref(), Some("web" | "http-web" | "http"))
    };
    let port = ports
        .iter()
        .find(named)
        .or_else(|| ports.iter().find(|p| p.port == 9090))
        .or_else(|| ports.first())?;
    Some(match port.name.as_deref() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => port.port.to_string(),
    })
}

/// The best Prometheus among `services`: a well-known name first (in the
/// order of [`PROMETHEUS_SERVICE_NAMES`]), then the label; `monitoring`
/// before other namespaces, then by namespace.
pub fn pick_prometheus(services: &[Service]) -> Option<PrometheusTarget> {
    let rank = |svc: &Service| -> Option<(usize, bool, String)> {
        let name = svc.metadata.name.as_deref()?;
        let ns = svc.metadata.namespace.clone().unwrap_or_default();
        let by_name = PROMETHEUS_SERVICE_NAMES.iter().position(|n| *n == name);
        let labelled = svc
            .metadata
            .labels
            .as_ref()
            .and_then(|l| l.get("app.kubernetes.io/name"))
            .is_some_and(|v| v == "prometheus");
        let r = by_name.or(labelled.then_some(PROMETHEUS_SERVICE_NAMES.len()))?;
        Some((r, ns != "monitoring", ns))
    };
    services
        .iter()
        .filter_map(|svc| Some((rank(svc)?, svc, service_port(svc)?)))
        .min_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, svc, port)| PrometheusTarget {
            namespace: svc.metadata.namespace.clone().unwrap_or_default(),
            name: svc.metadata.name.clone().unwrap_or_default(),
            port,
        })
}

/// What [`resolve_prometheus`] found, and why not when it found nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrometheusDetection {
    pub target: Option<PrometheusTarget>,
    /// The target comes from Settings, not detection.
    pub from_settings: bool,
    /// Why there is no target ("" when there is one).
    pub note: String,
}

/// What the app shows about Prometheus in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PrometheusStatus {
    /// `namespace/service:port`, or "" when there is none.
    pub target: String,
    /// The target was set in Settings rather than detected.
    pub from_settings: bool,
    /// Why there is no Prometheus ("" when there is one).
    pub note: String,
}

impl PrometheusDetection {
    pub fn status(&self) -> PrometheusStatus {
        PrometheusStatus {
            target: self.target.as_ref().map(|t| t.label()).unwrap_or_default(),
            from_settings: self.from_settings,
            note: self.note.clone(),
        }
    }
}

/// Look for a Prometheus Service in the cluster. Lists Services by the
/// well-known names and the label across the cluster; a user who may not do
/// that gets the well-known names in the usual namespaces tried one by one.
pub async fn detect_prometheus(client: &Client) -> PrometheusDetection {
    match list_candidates(client).await {
        Ok(found) => match pick_prometheus(&found) {
            Some(target) => PrometheusDetection {
                target: Some(target),
                ..Default::default()
            },
            None => PrometheusDetection {
                note: format!(
                    "No Prometheus Service found (looked for {} and the label {PROMETHEUS_LABEL}).",
                    PROMETHEUS_SERVICE_NAMES.join(", ")
                ),
                ..Default::default()
            },
        },
        Err(e) if is_forbidden(&e) => {
            let found = get_usual(client).await;
            match pick_prometheus(&found) {
                Some(target) => PrometheusDetection {
                    target: Some(target),
                    ..Default::default()
                },
                None => PrometheusDetection {
                    note: format!(
                        "Not allowed to list Services across the cluster, and no Prometheus in {}. \
                         Set its Service in Settings.",
                        USUAL_NAMESPACES.join(", ")
                    ),
                    ..Default::default()
                },
            }
        }
        Err(e) => PrometheusDetection {
            note: format!("Could not look for Prometheus: {e:#}"),
            ..Default::default()
        },
    }
}

async fn list_candidates(client: &Client) -> Result<Vec<Service>> {
    let api: Api<Service> = Api::all(client.clone());
    let mut found = Vec::new();
    for name in PROMETHEUS_SERVICE_NAMES {
        let lp = ListParams::default().fields(&format!("metadata.name={name}"));
        found.extend(api.list(&lp).await?.items);
    }
    let lp = ListParams::default().labels(PROMETHEUS_LABEL);
    found.extend(api.list(&lp).await?.items);
    Ok(found)
}

async fn get_usual(client: &Client) -> Vec<Service> {
    let mut found = Vec::new();
    for ns in USUAL_NAMESPACES {
        let api: Api<Service> = Api::namespaced(client.clone(), ns);
        for name in PROMETHEUS_SERVICE_NAMES {
            if let Ok(Some(svc)) = api.get_opt(name).await {
                found.push(svc);
            }
        }
    }
    found
}

/// The Prometheus to use, given the context's Settings value: `""` detects
/// one, [`PROMETHEUS_OFF`] turns it off, anything else names the Service.
pub async fn resolve_prometheus(client: &Client, setting: &str) -> PrometheusDetection {
    let setting = setting.trim();
    if setting.is_empty() {
        return detect_prometheus(client).await;
    }
    if setting.eq_ignore_ascii_case(PROMETHEUS_OFF) {
        return PrometheusDetection {
            note: "Prometheus is turned off for this context in Settings.".into(),
            ..Default::default()
        };
    }
    match PrometheusTarget::parse(setting) {
        Some(target) => PrometheusDetection {
            target: Some(target),
            from_settings: true,
            note: String::new(),
        },
        None => PrometheusDetection {
            note: format!(
                "The Prometheus Service in Settings, \"{setting}\", is not namespace/service:port."
            ),
            ..Default::default()
        },
    }
}

/// How far back a chart goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum UsageRange {
    /// The metrics-server history the app collects (30 minutes).
    #[default]
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "1h")]
    Hour,
    #[serde(rename = "6h")]
    SixHours,
    #[serde(rename = "24h")]
    Day,
}

impl UsageRange {
    /// Seconds covered and the step between points (120 points each), or
    /// `None` for [`UsageRange::Live`].
    pub fn span(self) -> Option<(u64, u64)> {
        match self {
            UsageRange::Live => None,
            UsageRange::Hour => Some((3600, 30)),
            UsageRange::SixHours => Some((6 * 3600, 180)),
            UsageRange::Day => Some((24 * 3600, 720)),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            UsageRange::Live => "live",
            UsageRange::Hour => "1h",
            UsageRange::SixHours => "6h",
            UsageRange::Day => "24h",
        }
    }
}

/// The window of a `rate()` at this step: two steps, and at least 2 minutes
/// so it spans several scrapes at the usual 30 s interval.
pub(crate) fn rate_window(step: u64) -> String {
    format!("{}s", (2 * step).max(120))
}

/// Quote a label value for PromQL.
pub(crate) fn quote(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// CPU (cores) and memory (bytes) queries per container of one pod.
pub fn pod_queries(namespace: &str, pod: &str, step: u64) -> (String, String) {
    let sel = format!(
        "namespace={},pod={},container!=\"\",container!=\"POD\"",
        quote(namespace),
        quote(pod)
    );
    let cpu = format!(
        "sum by (container) (rate(container_cpu_usage_seconds_total{{{sel}}}[{}]))",
        rate_window(step)
    );
    let memory = format!("sum by (container) (container_memory_working_set_bytes{{{sel}}})");
    (cpu, memory)
}

/// CPU (cores) and memory (bytes) queries of one node's root cgroup. The
/// node is the `node` label (kube-prometheus) or `instance` (the
/// prometheus-community chart, which scrapes cAdvisor through the API server).
pub fn node_queries(node: &str, step: u64) -> (String, String) {
    let w = rate_window(step);
    let n = quote(node);
    let cpu = format!(
        "sum(rate(container_cpu_usage_seconds_total{{id=\"/\",node={n}}}[{w}])) \
         or sum(rate(container_cpu_usage_seconds_total{{id=\"/\",instance={n}}}[{w}]))"
    );
    let memory = format!(
        "sum(container_memory_working_set_bytes{{id=\"/\",node={n}}}) \
         or sum(container_memory_working_set_bytes{{id=\"/\",instance={n}}})"
    );
    (cpu, memory)
}

/// One series of a `query_range` result: its labels and `(epoch ms, value)`
/// points. Points that are not finite numbers are left out.
#[derive(Debug, Clone, PartialEq)]
pub struct PromSeries {
    pub labels: BTreeMap<String, String>,
    pub points: Vec<(u64, f64)>,
}

#[derive(Deserialize)]
struct PromResponse {
    status: String,
    #[serde(default)]
    data: Option<PromData>,
    #[serde(default, rename = "errorType")]
    error_type: String,
    #[serde(default)]
    error: String,
}

#[derive(Deserialize)]
struct PromData {
    #[serde(rename = "resultType")]
    result_type: String,
    #[serde(default)]
    result: Vec<PromMatrix>,
}

#[derive(Deserialize)]
struct PromMatrix {
    #[serde(default)]
    metric: BTreeMap<String, String>,
    #[serde(default)]
    values: Vec<(f64, String)>,
}

/// Parse the body of a `query_range` response.
pub fn parse_query_range(body: &str) -> Result<Vec<PromSeries>> {
    let resp: PromResponse = serde_json::from_str(body)
        .map_err(|_| anyhow!("Prometheus sent something that is not a query result"))?;
    if resp.status != "success" {
        return Err(anyhow!(
            "Prometheus could not run the query ({}): {}",
            if resp.error_type.is_empty() {
                "error"
            } else {
                &resp.error_type
            },
            resp.error
        ));
    }
    let data = resp
        .data
        .ok_or_else(|| anyhow!("Prometheus sent a result without data"))?;
    if data.result_type != "matrix" {
        return Err(anyhow!(
            "Prometheus sent a {} instead of a range (matrix)",
            data.result_type
        ));
    }
    Ok(data
        .result
        .into_iter()
        .map(|m| PromSeries {
            labels: m.metric,
            points: m
                .values
                .into_iter()
                .filter_map(|(t, v)| {
                    let v: f64 = v.parse().ok()?;
                    v.is_finite().then(|| ((t * 1000.0).round() as u64, v))
                })
                .collect(),
        })
        .collect())
}

/// Combine CPU (cores) and memory (bytes) results into a [`SeriesView`].
/// With `by_container`, each series is one container (its `container`
/// label) and the total is their sum; otherwise the series are summed into
/// the total alone. A point counts only where both CPU and memory have one.
pub fn to_series_view(cpu: &[PromSeries], memory: &[PromSeries], by_container: bool) -> SeriesView {
    type Points = BTreeMap<u64, (Option<f64>, Option<f64>)>;
    let key = |s: &PromSeries| {
        if by_container {
            s.labels.get("container").cloned().unwrap_or_default()
        } else {
            String::new()
        }
    };
    let mut per: BTreeMap<String, Points> = BTreeMap::new();
    for (series, is_cpu) in cpu
        .iter()
        .map(|s| (s, true))
        .chain(memory.iter().map(|s| (s, false)))
    {
        let points = per.entry(key(series)).or_default();
        for &(t, v) in &series.points {
            let slot = points.entry(t).or_default();
            let cell = if is_cpu { &mut slot.0 } else { &mut slot.1 };
            *cell = Some(cell.unwrap_or(0.0) + v);
        }
    }
    let samples = |points: &Points| -> Vec<UsageSample> {
        points
            .iter()
            .filter_map(|(&t, &(cpu, mem))| {
                Some(UsageSample {
                    t,
                    cpu_millicores: (cpu? * 1000.0).round().max(0.0) as u64,
                    memory_bytes: mem?.round().max(0.0) as u64,
                })
            })
            .collect()
    };
    let mut total: Points = BTreeMap::new();
    for points in per.values() {
        for (&t, &(cpu, mem)) in points {
            let slot = total.entry(t).or_default();
            if let Some(c) = cpu {
                slot.0 = Some(slot.0.unwrap_or(0.0) + c);
            }
            if let Some(m) = mem {
                slot.1 = Some(slot.1.unwrap_or(0.0) + m);
            }
        }
    }
    let samples_total = samples(&total);
    let containers = if by_container {
        per.iter()
            .map(|(name, points)| ContainerSeries {
                name: name.clone(),
                samples: samples(points),
            })
            .filter(|c| !c.name.is_empty() && !c.samples.is_empty())
            .collect()
    } else {
        Vec::new()
    };
    SeriesView {
        since: samples_total.first().map(|s| s.t).unwrap_or(0),
        samples: samples_total,
        containers,
    }
}

/// Percent-encode a query parameter value.
fn encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The `query_range` path (with its query string) on the API server.
pub fn query_range_path(
    target: &PrometheusTarget,
    query: &str,
    start: u64,
    end: u64,
    step: u64,
) -> String {
    target.proxy_path(&format!(
        "/api/v1/query_range?query={}&start={start}&end={end}&step={step}",
        encode(query)
    ))
}

/// Run one `query_range` through the service proxy. `start` and `end` are
/// epoch seconds.
pub async fn query_range(
    client: &Client,
    target: &PrometheusTarget,
    query: &str,
    start: u64,
    end: u64,
    step: u64,
) -> Result<Vec<PromSeries>> {
    let path = query_range_path(target, query, start, end, step);
    let req = http::Request::get(path)
        .body(Vec::new())
        .context("building the Prometheus request")?;
    let body = client
        .request_text(req)
        .await
        .map_err(|e| explain_proxy_error(target, e))?;
    parse_query_range(&body)
}

/// A plain reason for a failed proxy request.
fn explain_proxy_error(target: &PrometheusTarget, e: kube::Error) -> anyhow::Error {
    let label = target.label();
    let kube::Error::Api(resp) = &e else {
        return anyhow!("Could not reach Prometheus at {label}: {e}");
    };
    // A body that is not a Kubernetes Status arrives quoted; it may be
    // Prometheus' own error.
    let body = serde_json::from_str::<String>(&resp.message).unwrap_or(resp.message.clone());
    if let Ok(p) = serde_json::from_str::<PromResponse>(&body) {
        if p.status == "error" {
            return anyhow!("Prometheus at {label} rejected the query: {}", p.error);
        }
    }
    match resp.code {
        403 => anyhow!(
            "Not allowed to reach Prometheus at {label} through the API server's service proxy \
             (needs get on services/proxy in {}).",
            target.namespace
        ),
        404 => anyhow!(
            "Prometheus at {label} was not found: the Service, its port or the query API is missing."
        ),
        // The API server says this both for a missing Service and for one
        // without ready pods.
        503 => anyhow!(
            "Prometheus at {label} is not available: the Service is missing or has no ready pod ({}).",
            body.trim()
        ),
        code => anyhow!(
            "Prometheus at {label} failed (HTTP {code}): {}",
            body.chars().take(200).collect::<String>()
        ),
    }
}

/// The CPU and memory history of a pod (`namespace` set) or node over
/// `range`, ending at `now_secs`.
pub async fn prometheus_usage(
    client: &Client,
    target: &PrometheusTarget,
    namespace: Option<&str>,
    name: &str,
    range: UsageRange,
    now_secs: u64,
) -> Result<SeriesView> {
    let step = range_step(range)?;
    let (cpu_q, mem_q) = match namespace {
        Some(ns) => pod_queries(ns, name, step),
        None => node_queries(name, step),
    };
    let queries = (cpu_q.as_str(), mem_q.as_str());
    query_usage(
        client,
        target,
        queries,
        range,
        now_secs,
        namespace.is_some(),
    )
    .await
}

/// The step between points of a Prometheus range; an error for `live`.
pub(crate) fn range_step(range: UsageRange) -> Result<u64> {
    range
        .span()
        .map(|(_, step)| step)
        .ok_or_else(|| anyhow!("The live range comes from metrics-server, not Prometheus"))
}

/// Run a CPU (cores) and a memory (bytes) query over `range`, ending at
/// `now_secs`, into a [`SeriesView`] ([`to_series_view`]).
pub(crate) async fn query_usage(
    client: &Client,
    target: &PrometheusTarget,
    (cpu_q, mem_q): (&str, &str),
    range: UsageRange,
    now_secs: u64,
    by_container: bool,
) -> Result<SeriesView> {
    let step = range_step(range)?;
    let span = range.span().map(|(span, _)| span).unwrap_or_default();
    // On a 30 s grid, so polls close together ask the same thing. Not on
    // the step's own grid: at 24h that could leave out the last 12 minutes.
    let end = now_secs - now_secs % 30;
    let start = end.saturating_sub(span);
    let both = async {
        futures::try_join!(
            query_range(client, target, cpu_q, start, end, step),
            query_range(client, target, mem_q, start, end, step),
        )
    };
    let (cpu, memory) = tokio::time::timeout(QUERY_TIMEOUT, both)
        .await
        .map_err(|_| {
            anyhow!(
                "Prometheus at {} did not answer within {} s.",
                target.label(),
                QUERY_TIMEOUT.as_secs()
            )
        })??;
    Ok(to_series_view(&cpu, &memory, by_container))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{ServicePort, ServiceSpec};

    fn svc(ns: &str, name: &str, labels: &[(&str, &str)], ports: &[(&str, i32)]) -> Service {
        let mut s = Service::default();
        s.metadata.namespace = Some(ns.into());
        s.metadata.name = Some(name.into());
        if !labels.is_empty() {
            s.metadata.labels = Some(
                labels
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            );
        }
        s.spec = Some(ServiceSpec {
            ports: Some(
                ports
                    .iter()
                    .map(|(n, p)| ServicePort {
                        name: (!n.is_empty()).then(|| n.to_string()),
                        port: *p,
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        });
        s
    }

    #[test]
    fn well_known_names_win_over_the_label() {
        let found = vec![
            svc(
                "obs",
                "my-prom",
                &[("app.kubernetes.io/name", "prometheus")],
                &[("", 9090)],
            ),
            svc("monitoring", "prometheus-operated", &[], &[("web", 9090)]),
            svc(
                "monitoring",
                "prometheus-k8s",
                &[],
                &[("web", 9090), ("reloader-web", 8080)],
            ),
        ];
        let t = pick_prometheus(&found).unwrap();
        assert_eq!(t.label(), "monitoring/prometheus-k8s:web");
        // Without the well-known ones the labelled Service is taken, by number.
        let t = pick_prometheus(&found[..1]).unwrap();
        assert_eq!(t.label(), "obs/my-prom:9090");
    }

    #[test]
    fn monitoring_comes_first_and_ports_are_chosen_sensibly() {
        let found = vec![
            svc(
                "apps",
                "kube-prometheus-stack-prometheus",
                &[],
                &[("reloader-web", 8080), ("http-web", 9090)],
            ),
            svc(
                "monitoring",
                "kube-prometheus-stack-prometheus",
                &[],
                &[("http-web", 9090)],
            ),
        ];
        assert_eq!(
            pick_prometheus(&found).unwrap().label(),
            "monitoring/kube-prometheus-stack-prometheus:http-web"
        );
        assert_eq!(
            pick_prometheus(&found[..1]).unwrap().label(),
            "apps/kube-prometheus-stack-prometheus:http-web"
        );
        // Other labels or names are not Prometheus; a Service without
        // ports cannot be used.
        let none = vec![
            svc(
                "monitoring",
                "grafana",
                &[("app.kubernetes.io/name", "grafana")],
                &[("", 80)],
            ),
            svc("monitoring", "prometheus-k8s", &[], &[]),
        ];
        assert_eq!(pick_prometheus(&none), None);
    }

    #[test]
    fn settings_targets_parse() {
        let t = PrometheusTarget::parse(" monitoring/prometheus-k8s:web ").unwrap();
        assert_eq!(t.namespace, "monitoring");
        assert_eq!(t.name, "prometheus-k8s");
        assert_eq!(t.port, "web");
        assert_eq!(PrometheusTarget::parse("obs/prom").unwrap().port, "9090");
        for bad in [
            "",
            "prom",
            "/prom:9090",
            "obs/:9090",
            "obs/prom:",
            "obs/prom:9090/x",
            "a b/c",
        ] {
            assert_eq!(PrometheusTarget::parse(bad), None, "{bad}");
        }
        assert_eq!(
            t.proxy_path("/api/v1/query"),
            "/api/v1/namespaces/monitoring/services/prometheus-k8s:web/proxy/api/v1/query"
        );
    }

    #[test]
    fn query_paths_are_encoded() {
        let t = PrometheusTarget::parse("monitoring/prometheus-k8s:web").unwrap();
        let p = query_range_path(&t, "sum(x{a=\"b c\"})", 100, 200, 30);
        assert_eq!(
            p,
            "/api/v1/namespaces/monitoring/services/prometheus-k8s:web/proxy/api/v1/query_range\
             ?query=sum%28x%7Ba%3D%22b%20c%22%7D%29&start=100&end=200&step=30"
        );
    }

    #[test]
    fn queries_select_the_object_and_quote_values() {
        let (cpu, mem) = pod_queries("demo", "web-1", 30);
        assert_eq!(
            cpu,
            "sum by (container) (rate(container_cpu_usage_seconds_total{namespace=\"demo\",\
             pod=\"web-1\",container!=\"\",container!=\"POD\"}[120s]))"
        );
        assert!(mem.starts_with("sum by (container) (container_memory_working_set_bytes{"));
        let (cpu, _) = pod_queries("demo", "we\"ird", 720);
        assert!(cpu.contains("pod=\"we\\\"ird\""));
        assert!(cpu.contains("[1440s]"));
        let (cpu, mem) = node_queries("kind-control-plane", 180);
        assert!(cpu.contains("{id=\"/\",node=\"kind-control-plane\"}[360s]"));
        assert!(cpu.contains(" or "));
        assert!(mem.contains("{id=\"/\",instance=\"kind-control-plane\"}"));
    }

    #[test]
    fn ranges() {
        assert_eq!(UsageRange::Live.span(), None);
        for r in [UsageRange::Hour, UsageRange::SixHours, UsageRange::Day] {
            let (span, step) = r.span().unwrap();
            assert_eq!(span / step, 120, "{}", r.label());
        }
        let r: UsageRange = serde_json::from_str("\"6h\"").unwrap();
        assert_eq!(r, UsageRange::SixHours);
        assert_eq!(
            serde_json::to_string(&UsageRange::Live).unwrap(),
            "\"live\""
        );
    }

    // Recorded from Prometheus 2.x (`query_range` of the pod queries above
    // for a pod with two containers), trimmed to three steps.
    const POD_CPU: &str = r#"{"status":"success","data":{"resultType":"matrix","result":[
        {"metric":{"container":"app"},"values":[[1700000000,"0.08"],[1700000030,"0.091"],[1700000060,"0.1"]]},
        {"metric":{"container":"sidecar"},"values":[[1700000030,"0.005"],[1700000060,"NaN"]]}]}}"#;
    const POD_MEM: &str = r#"{"status":"success","data":{"resultType":"matrix","result":[
        {"metric":{"container":"app"},"values":[[1700000000,"41943040"],[1700000030,"47185920"],[1700000060,"52428800"]]},
        {"metric":{"container":"sidecar"},"values":[[1700000030,"8388608"],[1700000060,"8388608"]]}]}}"#;

    #[test]
    fn pod_results_become_a_series_per_container() {
        let cpu = parse_query_range(POD_CPU).unwrap();
        let mem = parse_query_range(POD_MEM).unwrap();
        assert_eq!(cpu.len(), 2);
        // NaN is left out.
        assert_eq!(cpu[1].points, vec![(1_700_000_030_000, 0.005)]);
        let v = to_series_view(&cpu, &mem, true);
        assert_eq!(v.since, 1_700_000_000_000);
        let total: Vec<(u64, u64)> = v
            .samples
            .iter()
            .map(|s| (s.cpu_millicores, s.memory_bytes >> 20))
            .collect();
        // At the last step the sidecar has memory but no CPU: the total
        // still adds up what there is.
        assert_eq!(total, vec![(80, 40), (96, 53), (100, 58)]);
        assert_eq!(v.containers.len(), 2);
        assert_eq!(v.containers[0].name, "app");
        assert_eq!(v.containers[0].samples.len(), 3);
        assert_eq!(v.containers[0].samples[1].cpu_millicores, 91);
        // A container point needs both values.
        assert_eq!(v.containers[1].name, "sidecar");
        assert_eq!(v.containers[1].samples.len(), 1);
    }

    #[test]
    fn node_results_are_one_total() {
        let cpu = parse_query_range(
            r#"{"status":"success","data":{"resultType":"matrix","result":[
            {"metric":{},"values":[[1700000000.5,"1.25"],[1700000720.5,"0.9"]]}]}}"#,
        )
        .unwrap();
        let mem = parse_query_range(
            r#"{"status":"success","data":{"resultType":"matrix","result":[
            {"metric":{},"values":[[1700000000.5,"2147483648"],[1700000720.5,"2200000000"]]}]}}"#,
        )
        .unwrap();
        let v = to_series_view(&cpu, &mem, false);
        assert!(v.containers.is_empty());
        assert_eq!(v.samples[0].t, 1_700_000_000_500);
        assert_eq!(v.samples[0].cpu_millicores, 1250);
        assert_eq!(v.samples[1].memory_bytes, 2_200_000_000);
    }

    #[test]
    fn empty_and_failed_results() {
        let empty =
            parse_query_range(r#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#)
                .unwrap();
        assert_eq!(to_series_view(&empty, &empty, true), SeriesView::default());
        let e = parse_query_range(
            r#"{"status":"error","errorType":"bad_data","error":"parse error at char 5"}"#,
        )
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "Prometheus could not run the query (bad_data): parse error at char 5"
        );
        let e =
            parse_query_range(r#"{"status":"success","data":{"resultType":"vector","result":[]}}"#)
                .unwrap_err();
        assert!(e.to_string().contains("vector"));
        assert!(parse_query_range("<html>nope</html>").is_err());
    }

    fn api_error(code: u16, message: &str) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: message.into(),
            reason: "".into(),
            code,
            ..Default::default()
        }))
    }

    #[test]
    fn proxy_errors_say_what_happened() {
        let t = PrometheusTarget::parse("monitoring/prometheus-k8s:web").unwrap();
        let msg = |code, m: &str| explain_proxy_error(&t, api_error(code, m)).to_string();
        assert!(msg(403, "services \"prometheus-k8s:web\" is forbidden")
            .starts_with("Not allowed to reach Prometheus at monitoring/prometheus-k8s:web"));
        assert!(msg(403, "").contains("services/proxy in monitoring"));
        assert!(msg(404, "not found").contains("was not found"));
        assert!(msg(503, "no endpoints available")
            .contains("is missing or has no ready pod (no endpoints available)"));
        // Prometheus' own error, quoted by kube since it is not a Status.
        let quoted = format!(
            "{:?}",
            r#"{"status":"error","errorType":"bad_data","error":"bad step"}"#
        );
        assert_eq!(
            msg(400, &quoted),
            "Prometheus at monitoring/prometheus-k8s:web rejected the query: bad step"
        );
        assert!(msg(500, "\"boom\"").contains("HTTP 500"));
    }

    #[tokio::test]
    async fn settings_values() {
        // No requests are made for these, so any client will do.
        let config = kube::Config::new("http://127.0.0.1:1".parse().unwrap());
        let client = Client::try_from(config).unwrap();
        let d = resolve_prometheus(&client, "off").await;
        assert_eq!(d.target, None);
        assert!(d.note.contains("turned off"));
        let d = resolve_prometheus(&client, "obs/prom:http").await;
        assert!(d.from_settings);
        assert_eq!(d.status().target, "obs/prom:http");
        let d = resolve_prometheus(&client, "prom").await;
        assert!(d.note.contains("is not namespace/service:port"));
    }
}
