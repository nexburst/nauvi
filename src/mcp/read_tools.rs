//! The read-only tools: list, get, describe, logs, events and top. Each one
//! takes its arguments as a struct (unknown fields are refused) and returns
//! text; [`super::tools`] caps that text.

use super::limits::{self, clamp};
use super::list_table::list_table;
use super::redact::{redact_annotations, safe_value};
use crate::bounded_list::list_bounded;
use crate::resources::{self, align_columns};
use crate::{
    age_of_secs, get_node_metrics, get_pod_metrics, object_namespace, parse_log_target,
    render_describe_with, resolve_kind_named, split_target, workload_selector, LogTarget,
};
use anyhow::{bail, Result};
use k8s_openapi::api::core::v1::{Event, Pod};
use kube::api::{Api, ListParams, LogParams};
use kube::Client;
use serde::Deserialize;

/// Bytes the API server sends for one pod's log at most: a memory guard;
/// the result is cut to [`limits::MAX_BYTES`] afterwards.
const LOG_FETCH_BYTES: i64 = 2 * 1024 * 1024;

/// Kind and name: `kind` alone may be `<kind>/<name>`.
fn target<'a>(kind: &'a str, name: Option<&'a str>) -> Result<(&'a str, &'a str)> {
    match split_target(kind, name)? {
        (kind, Some(name)) => Ok((kind, name)),
        (_, None) => bail!("give the object's name (`name`, or `kind` as <kind>/<name>)"),
    }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    pub kind: String,
    pub namespace: Option<String>,
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
    pub limit: Option<u32>,
    /// Only these columns (header names, any case), in this order.
    pub columns: Option<Vec<String>>,
    /// Leave out NODE, and NAMESPACE when a namespace is given.
    #[serde(default)]
    pub compact: bool,
}

/// A `kubectl get`-style table of one kind, at most `limit` objects.
pub async fn list(client: &Client, a: &ListArgs) -> Result<String> {
    let kind = resolve_kind_named(client, &a.kind).await?;
    let limit = clamp(a.limit, limits::DEFAULT_LIST, limits::MAX_LIST);
    let mut lp = ListParams::default().limit(limit);
    if let Some(s) = &a.label_selector {
        lp = lp.labels(s);
    }
    if let Some(f) = &a.field_selector {
        lp = lp.fields(f);
    }
    let namespace = a.namespace.as_deref().filter(|n| !n.is_empty());
    let list = resources::dyn_api(client, &kind.resource, namespace)
        .list(&lp)
        .await?;
    let more = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|c| !c.is_empty());
    if list.items.is_empty() {
        return Ok(match namespace {
            Some(ns) if kind.resource.namespaced => format!("No {} found in {ns}.", kind.label),
            _ => format!("No {} found.", kind.label),
        });
    }
    let mut text = list_table(
        &kind,
        &list.items,
        a.columns.as_deref(),
        a.compact,
        namespace.is_some(),
    )?;
    if more {
        text.push_str(&format!(
            "[more objects exist: showing the first {limit}. Narrow the list with namespace, label_selector or field_selector (limit is at most {}).]\n",
            limits::MAX_LIST
        ));
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectArgs {
    pub kind: String,
    pub name: Option<String>,
    pub namespace: Option<String>,
}

/// One object as YAML, Secret values and last-applied redacted.
pub async fn get(client: &Client, a: &ObjectArgs) -> Result<String> {
    let (kind, name) = target(&a.kind, a.name.as_deref())?;
    let kind = resolve_kind_named(client, kind).await?;
    let ns = object_namespace(client, &kind.resource, a.namespace.as_deref());
    let obj = resources::get_resource(client, &kind.resource, &ns, name).await?;
    resources::to_yaml(safe_value(&kind.resource, obj)?)
}

/// `kubectl describe`: metadata, related objects, conditions, events.
pub async fn describe(client: &Client, a: &ObjectArgs) -> Result<String> {
    let (kind, name) = target(&a.kind, a.name.as_deref())?;
    let kind = resolve_kind_named(client, kind).await?;
    let ns = object_namespace(client, &kind.resource, a.namespace.as_deref());
    let mut detail = resources::get_resource_detail(client, &kind.resource, &ns, name).await?;
    redact_annotations(&mut detail.annotations);
    // Best effort, as in the CLI: the object was readable, its relations
    // may not be.
    let related = resources::get_related(client, &kind.resource, &ns, name)
        .await
        .unwrap_or_default();
    Ok(render_describe_with(&detail, &related))
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogsArgs {
    /// A pod name, or `deploy/<name>`, `sts/<name>`, `ds/<name>`,
    /// `job/<name>`, `rs/<name>`.
    pub target: String,
    pub namespace: Option<String>,
    pub container: Option<String>,
    #[serde(default)]
    pub previous: bool,
    pub tail: Option<i64>,
    pub since_seconds: Option<i64>,
}

/// The container `kubectl logs` reads without `-c`: the
/// `kubectl.kubernetes.io/default-container` annotation, else the first.
pub fn default_container(pod: &Pod) -> Option<String> {
    let annotated = pod
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("kubectl.kubernetes.io/default-container"))
        .cloned();
    annotated.or_else(|| {
        pod.spec
            .as_ref()
            .and_then(|s| s.containers.first())
            .map(|c| c.name.clone())
    })
}

/// The last lines of `text` that fit in `max_lines` and `max_bytes` (logs
/// keep their newest lines), with a note when lines were dropped.
pub fn tail_text(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut start = lines.len();
    let mut bytes = 0;
    while start > 0 && lines.len() - start < max_lines {
        let len = lines[start - 1].len() + 1;
        if bytes + len > max_bytes {
            break;
        }
        bytes += len;
        start -= 1;
    }
    let mut out = String::new();
    if start > 0 {
        out.push_str(&format!(
            "[truncated: {start} older lines left out; the limit is {max_lines} lines and {} KiB per call]\n",
            max_bytes / 1024
        ));
    }
    for line in &lines[start..] {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// The last `tail` lines of a pod, or of each pod of a workload (at most
/// [`limits::MAX_LOG_PODS`]), newest lines kept when over the caps.
pub async fn logs(client: &Client, a: &LogsArgs) -> Result<String> {
    let ns = a
        .namespace
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| client.default_namespace().to_string());
    let tail = clamp(a.tail, limits::DEFAULT_TAIL, limits::MAX_TAIL);
    let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
    let (pods, label, more) = match parse_log_target(&a.target)? {
        LogTarget::Pod(name) => (vec![api.get(&name).await?], None, false),
        LogTarget::Workload(kind, name) => {
            let selector = workload_selector(client, kind, &ns, &name).await?;
            // The API server lists a namespace's pods by name: the first
            // MAX_LOG_PODS listed are the first by name.
            let read = list_bounded(
                &api,
                &ListParams::default().labels(&selector),
                limits::MAX_LOG_PODS,
            )
            .await?;
            let mut pods = read.items;
            pods.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));
            (pods, Some(format!("{}/{name}", kind.as_str())), read.more)
        }
    };
    if pods.is_empty() {
        bail!(
            "{} in {ns} has no pods",
            label.unwrap_or_else(|| a.target.clone())
        );
    }
    let total = pods.len();
    let shown = total.min(limits::MAX_LOG_PODS);
    let prefixed = label.is_some();
    // Each pod gets an equal share of the caps.
    let max_lines = limits::MAX_LINES / shown;
    let max_bytes = limits::MAX_BYTES / shown;
    let mut out = String::new();
    if more {
        out.push_str(&format!(
            "[{} has more than {shown} pods: showing the logs of the first {shown}]\n",
            label.as_deref().unwrap_or_default()
        ));
    }
    for pod in pods.iter().take(shown) {
        let name = pod.metadata.name.clone().unwrap_or_default();
        let params = LogParams {
            container: a.container.clone().or_else(|| default_container(pod)),
            previous: a.previous,
            tail_lines: Some(tail),
            since_seconds: a.since_seconds,
            limit_bytes: Some(LOG_FETCH_BYTES),
            ..LogParams::default()
        };
        let text = match api.logs(&name, &params).await {
            Ok(t) => tail_text(&t, max_lines, max_bytes),
            Err(e) if prefixed => format!(
                "[cannot read the logs: {}]\n",
                crate::error_text(&anyhow::Error::from(e))
            ),
            Err(e) => return Err(e.into()),
        };
        if prefixed {
            for line in text.lines() {
                out.push_str(&format!("[{name}] {line}\n"));
            }
        } else {
            out.push_str(&text);
        }
    }
    if out.is_empty() {
        out.push_str("(no log lines)\n");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsArgs {
    pub namespace: Option<String>,
    /// With `name`: only the events of that object.
    pub kind: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub warnings_only: bool,
    pub limit: Option<usize>,
}

/// When an event last happened (seconds since the epoch).
fn event_time(e: &Event) -> i64 {
    e.series
        .as_ref()
        .and_then(|s| s.last_observed_time.as_ref())
        .map(|t| t.0.as_second())
        .or_else(|| e.last_timestamp.as_ref().map(|t| t.0.as_second()))
        .or_else(|| e.event_time.as_ref().map(|t| t.0.as_second()))
        .or_else(|| {
            e.metadata
                .creation_timestamp
                .as_ref()
                .map(|t| t.0.as_second())
        })
        .unwrap_or(0)
}

/// Under an empty events list: an empty list does not mean nothing
/// happened.
pub const EVENTS_EXPIRE: &str = "Events are kept for about 1 hour by default (the API \
     server's --event-ttl), so older problems are not here: see the problems tool, or describe \
     (last state, conditions).";

/// Most characters of an event's type or reason.
const MAX_EVENT_FIELD: usize = 60;

/// Events as a table, newest first, at most `limit`, messages shortened and
/// all cluster text on one line without control, bidi or zero-width
/// characters ([`limits::one_line`]).
pub fn events_table(mut events: Vec<Event>, limit: usize, with_namespace: bool) -> String {
    if events.is_empty() {
        return format!("No events found.\n{EVENTS_EXPIRE}\n");
    }
    events.sort_by_key(|e| std::cmp::Reverse(event_time(e)));
    let total = events.len();
    let mut header = vec!["LAST SEEN", "TYPE", "REASON", "OBJECT", "COUNT", "MESSAGE"];
    if with_namespace {
        header.insert(0, "NAMESPACE");
    }
    let mut table = vec![header.into_iter().map(String::from).collect::<Vec<_>>()];
    for e in events.iter().take(limit) {
        let obj = &e.involved_object;
        let mut row = vec![
            age_of_secs(event_time(e)),
            limits::one_line(e.type_.as_deref().unwrap_or_default(), MAX_EVENT_FIELD),
            limits::one_line(e.reason.as_deref().unwrap_or_default(), MAX_EVENT_FIELD),
            limits::one_line(
                &format!(
                    "{}/{}",
                    obj.kind.as_deref().unwrap_or_default().to_lowercase(),
                    obj.name.as_deref().unwrap_or_default()
                ),
                limits::MAX_EVENT_MESSAGE,
            ),
            e.series
                .as_ref()
                .and_then(|s| s.count)
                .or(e.count)
                .unwrap_or(1)
                .to_string(),
            limits::one_line(
                e.message.as_deref().unwrap_or_default(),
                limits::MAX_EVENT_MESSAGE,
            ),
        ];
        if with_namespace {
            row.insert(0, e.metadata.namespace.clone().unwrap_or_default());
        }
        table.push(row);
    }
    let mut out = align_columns(&table);
    if total > limit {
        out.push_str(&format!("[showing the newest {limit} of {total} events]\n"));
    }
    out
}

/// The events of a namespace (or all of them), or of one object.
pub async fn events(client: &Client, a: &EventsArgs) -> Result<String> {
    let mut fields = Vec::new();
    let mut namespace = a.namespace.clone().filter(|n| !n.is_empty());
    match (&a.kind, &a.name) {
        (Some(kind), Some(name)) => {
            let kind = resolve_kind_named(client, kind).await?;
            fields.push(format!("involvedObject.kind={}", kind.resource.kind));
            fields.push(format!("involvedObject.name={name}"));
            if kind.resource.namespaced && namespace.is_none() {
                namespace = Some(client.default_namespace().to_string());
            }
        }
        (None, None) => {}
        _ => bail!("give both kind and name to see the events of one object"),
    }
    if a.warnings_only {
        fields.push("type=Warning".into());
    }
    let api: Api<Event> = match &namespace {
        Some(ns) => Api::namespaced(client.clone(), ns),
        None => Api::all(client.clone()),
    };
    let mut lp = ListParams::default();
    if !fields.is_empty() {
        lp = lp.fields(&fields.join(","));
    }
    // The newest come from sorting, so more than `limit` are read, but at
    // most MAX_EVENTS_READ: never a whole cluster's.
    let read = list_bounded(&api, &lp, limits::MAX_EVENTS_READ).await?;
    let limit = clamp(a.limit, limits::DEFAULT_EVENTS, limits::MAX_EVENTS);
    let mut out = events_table(read.items, limit, namespace.is_none());
    if read.more {
        out.push_str(&events_read_note());
    }
    Ok(out)
}

/// The note under an events table when more events matched than were read.
fn events_read_note() -> String {
    format!(
        "[more than {max} events match: these are the newest of the first {max} the API server listed. Narrow them with namespace, kind and name, or warnings_only.]\n",
        max = limits::MAX_EVENTS_READ
    )
}

// ---------------------------------------------------------------------------
// top
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopArgs {
    /// `pods` (default) or `nodes`.
    pub resource: Option<String>,
    pub namespace: Option<String>,
    /// `cpu` (default) or `memory`.
    pub sort_by: Option<String>,
    pub limit: Option<usize>,
}

const NO_METRICS: &str = "Metrics API not available on this cluster (is metrics-server installed?)";

/// CPU and memory usage of pods or nodes, the heaviest first.
pub async fn top(client: &Client, a: &TopArgs) -> Result<String> {
    let by_memory = match a.sort_by.as_deref() {
        None | Some("cpu") => false,
        Some("memory") => true,
        Some(other) => bail!("sort_by is cpu or memory, not {other}"),
    };
    let limit = clamp(
        a.limit,
        limits::DEFAULT_LIST as usize,
        limits::MAX_LIST as usize,
    );
    let (text, total) = match a.resource.as_deref().unwrap_or("pods") {
        "pods" | "pod" => {
            let ns = a.namespace.as_deref().filter(|n| !n.is_empty());
            let Some(mut usages) = get_pod_metrics(client, ns).await? else {
                bail!(NO_METRICS)
            };
            usages.sort_by_key(|u| {
                std::cmp::Reverse(if by_memory {
                    u.memory_bytes
                } else {
                    u.cpu_millicores
                })
            });
            let total = usages.len();
            usages.truncate(limit);
            (crate::cli::top_pods_table(&usages), total)
        }
        "nodes" | "node" => {
            let Some(mut usages) = get_node_metrics(client).await? else {
                bail!(NO_METRICS)
            };
            usages.sort_by_key(|u| {
                std::cmp::Reverse(if by_memory {
                    u.memory_bytes
                } else {
                    u.cpu_millicores
                })
            });
            let total = usages.len();
            usages.truncate(limit);
            (crate::cli::top_nodes_table(&usages), total)
        }
        other => bail!("resource is pods or nodes, not {other}"),
    };
    if total == 0 {
        return Ok("No metrics yet.\n".into());
    }
    Ok(if total > limit {
        format!("{text}[showing the top {limit} of {total}]\n")
    } else {
        text
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn target_takes_both_forms() {
        assert_eq!(target("pod/web", None).unwrap(), ("pod", "web"));
        assert_eq!(target("pod", Some("web")).unwrap(), ("pod", "web"));
        assert!(target("pod", None).is_err());
    }

    #[test]
    fn args_refuse_unknown_fields() {
        let ok: ObjectArgs = serde_json::from_value(json!({ "kind": "pod", "name": "x" })).unwrap();
        assert_eq!(ok.kind, "pod");
        let bad = serde_json::from_value::<ObjectArgs>(json!({ "kind": "pod", "reveal": true }));
        assert!(bad.is_err());
        let logs: LogsArgs = serde_json::from_value(json!({ "target": "deploy/web" })).unwrap();
        assert!(!logs.previous);
        assert!(serde_json::from_value::<ListArgs>(json!({})).is_err());
    }

    fn pod(v: serde_json::Value) -> Pod {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn default_container_follows_the_annotation_then_the_first() {
        let spec = json!({ "containers": [{ "name": "app" }, { "name": "sidecar" }] });
        assert_eq!(
            default_container(&pod(json!({ "spec": spec }))).as_deref(),
            Some("app")
        );
        let annotated = pod(json!({
            "metadata": { "annotations": { "kubectl.kubernetes.io/default-container": "sidecar" } },
            "spec": spec
        }));
        assert_eq!(default_container(&annotated).as_deref(), Some("sidecar"));
        assert_eq!(default_container(&pod(json!({}))), None);
    }

    #[test]
    fn tail_text_keeps_the_newest_lines() {
        let text: String = (0..10).map(|i| format!("line {i}\n")).collect();
        assert_eq!(tail_text(&text, 100, 10_000), text);
        let out = tail_text(&text, 3, 10_000);
        assert!(
            out.starts_with("[truncated: 7 older lines left out"),
            "{out}"
        );
        assert!(out.ends_with("line 7\nline 8\nline 9\n"), "{out}");
        let out = tail_text(&text, 100, 14);
        assert!(out.ends_with("\nline 8\nline 9\n"), "{out}");
        assert!(!out.contains("line 7"), "{out}");
    }

    fn event(ns: &str, reason: &str, ts: &str, message: &str) -> Event {
        serde_json::from_value(json!({
            "metadata": { "name": format!("e-{reason}"), "namespace": ns },
            "involvedObject": { "kind": "Pod", "name": "web-1" },
            "reason": reason,
            "type": "Warning",
            "message": message,
            "count": 2,
            "lastTimestamp": ts,
        }))
        .unwrap()
    }

    #[test]
    fn events_are_newest_first_limited_and_shortened() {
        let long = "x".repeat(2000);
        let events = vec![
            event("demo", "Old", "2020-01-01T00:00:00Z", "first\nsecond"),
            event("demo", "New", "2024-01-01T00:00:00Z", &long),
            event("demo", "Mid", "2022-01-01T00:00:00Z", "mid"),
        ];
        let out = events_table(events, 2, true);
        let lines: Vec<_> = out.lines().collect();
        assert!(lines[0].starts_with("NAMESPACE  LAST SEEN"), "{out}");
        assert!(
            lines[1].contains("New") && lines[1].contains("pod/web-1"),
            "{out}"
        );
        assert!(lines[1].contains(&format!("{}…", "x".repeat(500))), "{out}");
        assert!(!lines[1].contains(&"x".repeat(501)));
        assert!(lines[2].contains("Mid"), "{out}");
        assert!(!out.contains("Old"), "{out}");
        assert_eq!(lines[3], "[showing the newest 2 of 3 events]");
        let none = events_table(vec![], 5, false);
        assert!(
            none.starts_with("No events found.\nEvents are kept for about 1 hour"),
            "{none}"
        );
        let one = events_table(
            vec![event("demo", "Old", "2020-01-01T00:00:00Z", "a\nb")],
            5,
            false,
        );
        assert!(one.starts_with("LAST SEEN"), "{one}");
        assert!(one.contains("a b"), "{one}");
    }

    #[test]
    fn event_text_is_sanitised() {
        let out = events_table(
            vec![event(
                "demo",
                "Bad\u{1b}[31m\u{200D}",
                "2024-01-01T00:00:00Z",
                "pull\u{202E}gnp.exe\u{202C}\u{200B} failed\r\n\u{FEFF}again\u{2060}\u{7}",
            )],
            5,
            false,
        );
        assert!(out.contains("Bad[31m"), "{out}");
        assert!(out.contains("pullgnp.exe failed again\n"), "{out}");
        for c in [
            '\u{1b}', '\u{202E}', '\u{200B}', '\u{200D}', '\u{FEFF}', '\u{2060}', '\u{7}', '\r',
        ] {
            assert!(!out.contains(c), "{c:?} in {out:?}");
        }
        assert_eq!(out.lines().count(), 2, "{out}");
    }
}
