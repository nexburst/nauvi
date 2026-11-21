//! The `problems` tool (#377): the unhealthy objects of a namespace (or of
//! the cluster) in one call, each with the "why" a human would `describe`
//! for.
//!
//! Which objects are problems is decided by the app's own rule,
//! [`row_problem`] (the table badges; for pods it agrees with the
//! overview's [`crate::overview::pod_problem`]), so the badges, the overview
//! and the assistant agree. On top of it, a pod that restarted in the last
//! [`RECENT_RESTART_SECS`] is listed as "Restarted N times", and one whose
//! restarts are older is listed apart, as history.
//!
//! Read-only, and it never reads Secrets: `kinds` takes only the kinds
//! below.

use super::limits::{self, clamp, shorten};
use crate::bounded_list::list_bounded;
use crate::resources::{self, align_columns, row_problem, ResourceRef};
use anyhow::{bail, Result};
use kube::api::ListParams;
use kube::Client;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

/// A restart newer than this counts as a problem; older ones are history.
pub const RECENT_RESTART_SECS: i64 = 24 * 3600;
/// Problem rows per call when the caller gives no `limit`.
pub const DEFAULT_PROBLEMS: usize = 50;
/// Most problem rows one call returns.
pub const MAX_PROBLEMS: usize = 200;
/// Most objects of one kind a call reads.
pub const MAX_READ_PER_KIND: usize = 2000;
/// Most characters of one row's detail.
pub const MAX_DETAIL: usize = 300;
/// Most characters of one message quoted in a detail.
const MAX_MESSAGE: usize = 160;

/// The kinds `problems` checks: (group, version, kind, plural, namespaced,
/// other names).
type KindDef = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    bool,
    &'static [&'static str],
);
const KINDS: &[KindDef] = &[
    ("", "v1", "Pod", "pods", true, &["pod", "po"]),
    (
        "apps",
        "v1",
        "Deployment",
        "deployments",
        true,
        &["deployment", "deploy"],
    ),
    (
        "apps",
        "v1",
        "StatefulSet",
        "statefulsets",
        true,
        &["statefulset", "sts"],
    ),
    (
        "apps",
        "v1",
        "DaemonSet",
        "daemonsets",
        true,
        &["daemonset", "ds"],
    ),
    (
        "apps",
        "v1",
        "ReplicaSet",
        "replicasets",
        true,
        &["replicaset", "rs"],
    ),
    ("batch", "v1", "Job", "jobs", true, &["job"]),
    ("", "v1", "Node", "nodes", false, &["node", "no"]),
    (
        "",
        "v1",
        "PersistentVolumeClaim",
        "persistentvolumeclaims",
        true,
        &["persistentvolumeclaim", "pvc"],
    ),
];

fn kind_ref(i: usize) -> ResourceRef {
    let (group, version, kind, plural, namespaced, _) = KINDS[i];
    ResourceRef {
        group: group.into(),
        version: version.into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced,
    }
}

/// The indexes into [`KINDS`] that `names` asks for (all when `None`;
/// Nodes only for the whole cluster unless asked for).
pub fn parse_kinds(names: Option<&[String]>, namespace: Option<&str>) -> Result<Vec<usize>> {
    let Some(names) = names.filter(|n| !n.is_empty()) else {
        return Ok((0..KINDS.len())
            .filter(|&i| namespace.is_none() || KINDS[i].4)
            .collect());
    };
    let mut out = Vec::new();
    for name in names {
        let n = name.trim().to_lowercase();
        let Some(i) = KINDS
            .iter()
            .position(|k| k.2.to_lowercase() == n || k.3 == n || k.5.contains(&n.as_str()))
        else {
            let known: Vec<_> = KINDS.iter().map(|k| k.3).collect();
            bail!(
                "problems covers {}, not {name}; use list or describe for other kinds",
                known.join(", ")
            );
        };
        if !out.contains(&i) {
            out.push(i);
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProblemsArgs {
    pub namespace: Option<String>,
    pub kinds: Option<Vec<String>>,
    pub limit: Option<usize>,
}

/// One row of the result.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub problem: String,
    pub detail: String,
    /// When the problem started or last happened (unix seconds), for the
    /// order; 0 if unknown.
    pub when: i64,
}

fn str_at<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

fn int_at(v: &Value, pointer: &str) -> Option<i64> {
    v.pointer(pointer).and_then(Value::as_i64)
}

fn array<'a>(v: &'a Value, pointer: &str) -> impl Iterator<Item = &'a Value> {
    v.pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn secs(ts: &str) -> i64 {
    ts.parse::<jiff::Timestamp>()
        .map(|t| t.as_second())
        .unwrap_or(0)
}

/// A short span: `45s`, `12m`, `5h`, `27d`.
pub fn span(secs: i64) -> String {
    let s = secs.max(0);
    match s {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

fn ago(when: i64, now: i64) -> String {
    if when > 0 {
        format!("{} ago", span(now - when))
    } else {
        String::new()
    }
}

/// A status or event message on one line, shortened (see
/// [`limits::one_line`]).
fn one_line(s: &str) -> String {
    limits::one_line(s, MAX_MESSAGE)
}

/// Most characters of a termination or condition reason.
const MAX_REASON: usize = 60;

/// The newest condition change of `v` (unix seconds), 0 if none.
fn latest_transition(v: &Value) -> i64 {
    array(v, "/status/conditions")
        .map(|c| secs(str_at(c, "/lastTransitionTime")))
        .max()
        .unwrap_or(0)
}

/// The message of the first condition in `wanted` ((type, bad status))
/// that has that status.
fn condition_message(v: &Value, wanted: &[(&str, &str)]) -> Option<String> {
    wanted.iter().find_map(|(t, bad)| {
        array(v, "/status/conditions")
            .find(|c| str_at(c, "/type") == *t && str_at(c, "/status") == *bad)
            .map(|c| {
                let m = str_at(c, "/message");
                let r = str_at(c, "/reason");
                match (r.is_empty(), m.is_empty()) {
                    (_, false) => one_line(m),
                    (false, true) => limits::one_line(r, MAX_REASON),
                    _ => format!("{t} {bad}"),
                }
            })
    })
}

/// A container's last termination: the current one if it is terminated,
/// else `lastState`.
struct Termination<'a> {
    container: &'a str,
    reason: &'a str,
    exit: Option<i64>,
    finished: i64,
}

fn terminations(pod: &Value) -> impl Iterator<Item = Termination<'_>> {
    array(pod, "/status/initContainerStatuses")
        .chain(array(pod, "/status/containerStatuses"))
        .filter_map(|c| {
            let t = c
                .pointer("/state/terminated")
                .filter(|t| str_at(t, "/reason") != "Completed")
                .or_else(|| c.pointer("/lastState/terminated"))?;
            Some(Termination {
                container: str_at(c, "/name"),
                reason: str_at(t, "/reason"),
                exit: int_at(t, "/exitCode"),
                finished: secs(str_at(t, "/finishedAt")),
            })
        })
}

/// The `list` tool's LAST cell for a pod: its newest termination and its
/// age (`OOMKilled 27d`, `Error 2h`); empty if none.
pub fn last_termination_cell(pod: &Value, now: i64) -> String {
    let Some(t) = terminations(pod).max_by_key(|t| t.finished) else {
        return String::new();
    };
    let reason = match limits::one_line(t.reason, MAX_REASON) {
        r if r.is_empty() => "Terminated".to_string(),
        r => r,
    };
    if t.finished > 0 {
        format!("{reason} {}", span(now - t.finished))
    } else {
        reason
    }
}

/// The memory limit of `container` in `pod`'s spec ("" if none).
fn memory_limit<'a>(pod: &'a Value, container: &str) -> &'a str {
    array(pod, "/spec/initContainers")
        .chain(array(pod, "/spec/containers"))
        .find(|c| str_at(c, "/name") == container)
        .map(|c| str_at(c, "/resources/limits/memory"))
        .unwrap_or("")
}

fn restarts(pod: &Value) -> i64 {
    array(pod, "/status/containerStatuses")
        .filter_map(|c| int_at(c, "/restartCount"))
        .sum()
}

/// "last: OOMKilled (exit 137) 27d ago; limit memory 8Gi", for the newest
/// termination. An `Error` with exit code 137 (SIGKILL) is most often the
/// kernel's OOM killer too, so it gets the limit as well:
/// "last: Error, exit 137 (likely OOM-killed) 2h ago; limit memory 8Gi".
fn last_termination(pod: &Value, now: i64) -> Option<(String, i64)> {
    let t = terminations(pod).max_by_key(|t| t.finished)?;
    let several =
        array(pod, "/spec/containers").count() + array(pod, "/spec/initContainers").count() > 1;
    let reason = limits::one_line(t.reason, MAX_REASON);
    let likely_oom = t.exit == Some(137) && (reason == "Error" || reason.is_empty());
    let mut s = "last: ".to_string();
    s.push_str(if reason.is_empty() {
        "terminated"
    } else {
        &reason
    });
    match t.exit {
        Some(137) if likely_oom => s.push_str(", exit 137 (likely OOM-killed)"),
        Some(code) => s.push_str(&format!(" (exit {code})")),
        None => {}
    }
    if several && !t.container.is_empty() {
        s.push_str(&format!(" in {}", t.container));
    }
    let when = ago(t.finished, now);
    if !when.is_empty() {
        s.push(' ');
        s.push_str(&when);
    }
    if reason == "OOMKilled" || likely_oom {
        match memory_limit(pod, t.container) {
            "" => s.push_str("; no memory limit"),
            l => s.push_str(&format!(
                "; limit memory {}",
                limits::one_line(l, MAX_REASON)
            )),
        }
    }
    Some((s, t.finished))
}

/// The objects the details refer to: ReplicaSets and Deployments read by
/// the same call, by `namespace/name`.
#[derive(Default)]
pub struct Owners {
    pub replicasets: HashMap<String, Value>,
    pub deployments: HashMap<String, Value>,
}

fn controller<'a>(v: &'a Value, kind: &str) -> Option<&'a str> {
    array(v, "/metadata/ownerReferences")
        .find(|o| str_at(o, "/kind") == kind)
        .map(|o| str_at(o, "/name"))
}

/// "old ReplicaSet api-5f6b; Deployment api is 4/4 ready", for a failed pod
/// whose ReplicaSet has since been scaled down.
fn replaced_owner(pod: &Value, owners: &Owners) -> Option<String> {
    let ns = str_at(pod, "/metadata/namespace");
    let rs_name = controller(pod, "ReplicaSet")?;
    let rs = owners.replicasets.get(&format!("{ns}/{rs_name}"))?;
    if int_at(rs, "/spec/replicas").unwrap_or(1) > 0 {
        return None;
    }
    let mut s = format!("old ReplicaSet {rs_name}");
    if let Some(d) = controller(rs, "Deployment")
        .and_then(|d| owners.deployments.get(&format!("{ns}/{d}")).map(|v| (d, v)))
    {
        let (name, v) = d;
        s.push_str(&format!(
            "; Deployment {name} is {}/{} ready",
            int_at(v, "/status/readyReplicas").unwrap_or(0),
            int_at(v, "/spec/replicas").unwrap_or(1)
        ));
    }
    Some(s)
}

/// What a pod's row says: a problem, restart history, or nothing.
#[derive(Debug, PartialEq)]
pub enum PodVerdict {
    Problem(Finding),
    /// Restarted, but not lately: listed apart.
    History(Finding),
    Fine,
}

fn finding(v: &Value, kind: &str, problem: String, detail: Vec<String>, when: i64) -> Finding {
    let detail: Vec<_> = detail.into_iter().filter(|d| !d.is_empty()).collect();
    Finding {
        kind: kind.to_string(),
        namespace: str_at(v, "/metadata/namespace").to_string(),
        name: str_at(v, "/metadata/name").to_string(),
        problem,
        detail: shorten(&detail.join("; "), MAX_DETAIL),
        when: if when > 0 {
            when
        } else {
            secs(str_at(v, "/metadata/creationTimestamp"))
        },
    }
}

/// A pod: its problem by the app's rule ([`row_problem`]), else a recent
/// restart, else restart history; with the why.
pub fn pod_verdict(pod: &Value, owners: &Owners, now: i64) -> PodVerdict {
    let created = secs(str_at(pod, "/metadata/creationTimestamp"));
    let problem = row_problem(&kind_ref(0), pod, created, now);
    let restarts = restarts(pod);
    let last = last_termination(pod, now);
    let last_when = last.as_ref().map(|l| l.1).unwrap_or(0);
    let mut detail = Vec::new();
    if restarts > 0 {
        detail.push(format!(
            "restarted {restarts} time{}",
            if restarts == 1 { "" } else { "s" }
        ));
    }
    if problem.is_empty() {
        if restarts == 0 || pod.pointer("/metadata/deletionTimestamp").is_some() {
            return PodVerdict::Fine;
        }
        detail.clear();
        detail.extend(last.map(|l| l.0));
        let recent = last_when > 0 && now - last_when <= RECENT_RESTART_SECS;
        let text = format!(
            "Restarted {restarts} time{}",
            if restarts == 1 { "" } else { "s" }
        );
        if recent {
            return PodVerdict::Problem(finding(pod, "Pod", text, detail, last_when));
        }
        if last_when > 0 {
            detail.push(format!("stable since {}", ago(last_when, now)));
        }
        return PodVerdict::History(finding(pod, "Pod", text, detail, last_when));
    }
    let mut when = last_when.max(latest_transition(pod));
    if str_at(pod, "/status/phase") == "Failed" {
        let message = str_at(pod, "/status/message");
        if !message.is_empty() {
            detail.push(one_line(message));
        }
        detail.extend(replaced_owner(pod, owners));
    }
    // A waiting reason's message says more than the reason (image pull,
    // config errors); a crash loop's says less than the last termination.
    let waiting = array(pod, "/status/initContainerStatuses")
        .chain(array(pod, "/status/containerStatuses"))
        .filter_map(|c| c.pointer("/state/waiting"))
        .find(|w| str_at(w, "/reason") == problem);
    if let Some(w) = waiting.filter(|_| problem != "CrashLoopBackOff") {
        let m = str_at(w, "/message");
        if !m.is_empty() {
            detail.push(one_line(m));
        }
    }
    detail.extend(last.map(|l| l.0));
    if problem.starts_with("Pending") {
        detail.extend(condition_message(pod, &[("PodScheduled", "False")]));
        when = when.max(created);
    }
    if problem == "Not ready" {
        // "containers with unready status: [c]"
        detail.extend(condition_message(pod, &[("ContainersReady", "False")]));
    }
    PodVerdict::Problem(finding(pod, "Pod", problem, detail, when))
}

/// Any other kind: its problem by [`row_problem`], with the why.
pub fn object_finding(r: &ResourceRef, v: &Value, now: i64) -> Option<Finding> {
    let created = secs(str_at(v, "/metadata/creationTimestamp"));
    let problem = row_problem(r, v, created, now);
    if problem.is_empty() {
        return None;
    }
    let mut detail = Vec::new();
    match r.kind.as_str() {
        "Deployment" | "StatefulSet" | "ReplicaSet" => {
            detail.extend(condition_message(
                v,
                &[
                    ("ReplicaFailure", "True"),
                    ("Progressing", "False"),
                    ("Available", "False"),
                ],
            ));
            if let Some(u) = int_at(v, "/status/unavailableReplicas") {
                detail.push(format!("{u} unavailable"));
            }
        }
        "DaemonSet" => {
            if let Some(u) = int_at(v, "/status/numberUnavailable") {
                detail.push(format!("{u} unavailable"));
            }
            if let Some(m) = int_at(v, "/status/numberMisscheduled").filter(|m| *m > 0) {
                detail.push(format!("{m} misscheduled"));
            }
        }
        "Job" => {
            detail.extend(condition_message(v, &[("Failed", "True")]));
            if let Some(f) = int_at(v, "/status/failed") {
                detail.push(format!("{f} failed pod{}", if f == 1 { "" } else { "s" }));
            }
        }
        "Node" => {
            detail.extend(condition_message(
                v,
                &[("Ready", "False"), ("Ready", "Unknown")],
            ));
            for p in ["MemoryPressure", "DiskPressure", "PIDPressure"] {
                if array(v, "/status/conditions")
                    .any(|c| str_at(c, "/type") == p && str_at(c, "/status") == "True")
                {
                    detail.push(p.to_string());
                }
            }
            if v.pointer("/spec/unschedulable") == Some(&Value::Bool(true)) {
                detail.push("cordoned".into());
            }
        }
        _ => {}
    }
    Some(finding(v, &r.kind, problem, detail, latest_transition(v)))
}

/// The table of `findings`, newest first, at most `limit` rows.
pub fn findings_table(mut findings: Vec<Finding>, limit: usize) -> (String, usize) {
    findings.sort_by(|a, b| {
        b.when
            .cmp(&a.when)
            .then_with(|| (&a.kind, &a.namespace, &a.name).cmp(&(&b.kind, &b.namespace, &b.name)))
    });
    let total = findings.len();
    let mut table = vec![["KIND", "NAMESPACE", "NAME", "PROBLEM", "DETAIL"]
        .map(String::from)
        .to_vec()];
    for f in findings.into_iter().take(limit) {
        let ns = if f.namespace.is_empty() {
            "-".to_string()
        } else {
            f.namespace
        };
        table.push(vec![f.kind, ns, f.name, f.problem, f.detail]);
    }
    (align_columns(&table), total)
}

/// What one call found: problems, restart history and notes.
pub fn render(
    problems: Vec<Finding>,
    history: Vec<Finding>,
    notes: &[String],
    limit: usize,
) -> String {
    let mut out = String::new();
    let shown;
    if problems.is_empty() {
        out.push_str("No problems found.\n");
        shown = 0;
    } else {
        let (table, total) = findings_table(problems, limit);
        out.push_str(&table);
        shown = total.min(limit);
        if total > limit {
            out.push_str(&format!(
                "[showing the newest {limit} of {total} problems; narrow them with namespace or kinds]\n"
            ));
        }
    }
    let room = limit.saturating_sub(shown);
    if !history.is_empty() && room > 0 {
        out.push_str("\nRestarted earlier, running fine since:\n");
        let (table, total) = findings_table(history, room);
        out.push_str(&table);
        if total > room {
            out.push_str(&format!("[showing {room} of {total}]\n"));
        }
    }
    for n in notes {
        out.push_str(n);
        out.push('\n');
    }
    out
}

/// The unhealthy objects of a namespace (or of every namespace).
pub async fn problems(client: &Client, a: &ProblemsArgs) -> Result<String> {
    let namespace = a.namespace.as_deref().filter(|n| !n.is_empty());
    let kinds = parse_kinds(a.kinds.as_deref(), namespace)?;
    let limit = clamp(a.limit, DEFAULT_PROBLEMS, MAX_PROBLEMS);
    let now = jiff::Timestamp::now().as_second();
    let mut notes = Vec::new();
    let mut read: Vec<(usize, Vec<Value>)> = Vec::new();
    for &i in &kinds {
        let r = kind_ref(i);
        let api = resources::dyn_api(client, &r, namespace);
        match list_bounded(&api, &ListParams::default(), MAX_READ_PER_KIND).await {
            Ok(list) => {
                if list.more {
                    notes.push(format!(
                        "[more than {MAX_READ_PER_KIND} {} exist: only the first {MAX_READ_PER_KIND} were checked; narrow with namespace]",
                        r.plural
                    ));
                }
                let values = list
                    .items
                    .into_iter()
                    .filter_map(|o| serde_json::to_value(o).ok())
                    .collect();
                read.push((i, values));
            }
            Err(e) => notes.push(format!(
                "[cannot read {}: {}]",
                r.plural,
                crate::error_text(&anyhow::Error::from(e))
            )),
        }
    }
    let key = |v: &Value| {
        format!(
            "{}/{}",
            str_at(v, "/metadata/namespace"),
            str_at(v, "/metadata/name")
        )
    };
    let mut owners = Owners::default();
    for (i, values) in &read {
        let map = match KINDS[*i].2 {
            "ReplicaSet" => &mut owners.replicasets,
            "Deployment" => &mut owners.deployments,
            _ => continue,
        };
        map.extend(values.iter().map(|v| (key(v), v.clone())));
    }
    let (mut found, mut history) = (Vec::new(), Vec::new());
    for (i, values) in &read {
        let r = kind_ref(*i);
        for v in values {
            if r.kind == "Pod" {
                match pod_verdict(v, &owners, now) {
                    PodVerdict::Problem(f) => found.push(f),
                    PodVerdict::History(f) => history.push(f),
                    PodVerdict::Fine => {}
                }
            } else {
                found.extend(object_finding(&r, v, now));
            }
        }
    }
    let checked: Vec<_> = read.iter().map(|(i, _)| KINDS[*i].3).collect();
    let mut out = render(found, history, &notes, limit);
    out.push_str(&format!(
        "(checked {} in {})\n",
        checked.join(", "),
        namespace.unwrap_or("all namespaces")
    ));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;

    fn ts(secs_ago: i64) -> String {
        jiff::Timestamp::from_second(NOW - secs_ago)
            .unwrap()
            .to_string()
    }

    fn merge(a: &mut Value, b: Value) {
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                for (k, v) in b {
                    merge(a.entry(k).or_insert(Value::Null), v);
                }
            }
            (a, b) => *a = b,
        }
    }

    fn pod(phase: &str, extra: Value) -> Value {
        let mut v = json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "p", "namespace": "n", "creationTimestamp": ts(40 * 86_400) },
            "spec": { "containers": [{ "name": "db", "image": "x",
                "resources": { "limits": { "memory": "8Gi" } } }] },
            "status": { "phase": phase, "conditions": [{ "type": "Ready", "status": "True" }] }
        });
        merge(&mut v, extra);
        v
    }

    fn status(restarts: i64, state: Value, last: Value) -> Value {
        json!({ "status": { "containerStatuses": [{
            "name": "db", "image": "x", "imageID": "", "ready": true,
            "restartCount": restarts, "state": state, "lastState": last
        }] } })
    }

    fn oom(secs_ago: i64) -> Value {
        json!({ "terminated": { "reason": "OOMKilled", "exitCode": 137, "finishedAt": ts(secs_ago) } })
    }

    fn verdict(v: &Value) -> PodVerdict {
        pod_verdict(v, &Owners::default(), NOW)
    }

    #[test]
    fn one_line_collapses_whitespace() {
        assert_eq!(
            one_line("  back-off\n\trestarting   failed "),
            "back-off restarting failed"
        );
    }

    #[test]
    fn one_line_drops_control_characters() {
        // ESC (C0), DEL, CSI (C1), NUL and BEL.
        assert_eq!(one_line("\u{1b}[31mred\u{1b}[0m"), "[31mred[0m");
        assert_eq!(one_line("a\u{7f}b\u{9b}c\0d\u{7}e"), "abcde");
        // A line break still separates words.
        assert_eq!(one_line("one\r\ntwo\u{85}three"), "one two three");
    }

    #[test]
    fn one_line_drops_bidi_controls() {
        assert_eq!(
            one_line("ok \u{202E}lmth.exe\u{202C} \u{2066}x\u{2069}\u{200E}\u{200F}\u{061C}"),
            "ok lmth.exe x"
        );
        // Other non-ASCII text is kept.
        assert_eq!(one_line("café 日本"), "café 日本");
    }

    #[test]
    fn healthy_pods_are_not_listed() {
        assert_eq!(verdict(&pod("Running", json!({}))), PodVerdict::Fine);
        assert_eq!(verdict(&pod("Succeeded", json!({}))), PodVerdict::Fine);
    }

    #[test]
    fn a_recent_oom_kill_is_a_problem_with_the_limit() {
        let v = pod(
            "Running",
            status(18, json!({ "running": {} }), oom(2 * 3600)),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(f.problem, "Restarted 18 times");
        assert_eq!(
            f.detail,
            "last: OOMKilled (exit 137) 2h ago; limit memory 8Gi"
        );
    }

    #[test]
    fn old_restarts_are_history() {
        let v = pod(
            "Running",
            status(18, json!({ "running": {} }), oom(27 * 86_400)),
        );
        let PodVerdict::History(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(f.problem, "Restarted 18 times");
        assert!(f.detail.contains("OOMKilled (exit 137) 27d ago"), "{f:?}");
        assert!(f.detail.ends_with("stable since 27d ago"), "{f:?}");
    }

    #[test]
    fn a_crash_loop_says_how_it_last_ended() {
        let mut v = pod(
            "Running",
            status(
                4,
                json!({ "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 40s" } }),
                json!({ "terminated": { "reason": "Error", "exitCode": 1, "finishedAt": ts(30) } }),
            ),
        );
        merge(
            &mut v,
            json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } }),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(f.problem, "CrashLoopBackOff");
        assert_eq!(f.detail, "restarted 4 times; last: Error (exit 1) 30s ago");
    }

    #[test]
    fn an_evicted_pod_of_a_replaced_replicaset() {
        let v = pod(
            "Failed",
            json!({
                "metadata": { "ownerReferences": [{ "kind": "ReplicaSet", "name": "api-5f6b" }] },
                "status": { "reason": "Evicted",
                    "message": "The node was low on resource: ephemeral-storage. Threshold quantity: 1Gi." }
            }),
        );
        let mut owners = Owners::default();
        owners.replicasets.insert(
            "n/api-5f6b".into(),
            json!({ "metadata": { "ownerReferences": [{ "kind": "Deployment", "name": "api" }] },
                    "spec": { "replicas": 0 } }),
        );
        owners.deployments.insert(
            "n/api".into(),
            json!({ "spec": { "replicas": 4 }, "status": { "readyReplicas": 4 } }),
        );
        let PodVerdict::Problem(f) = pod_verdict(&v, &owners, NOW) else {
            panic!("{v}")
        };
        assert_eq!(f.problem, "Evicted");
        assert!(
            f.detail
                .starts_with("The node was low on resource: ephemeral-storage"),
            "{f:?}"
        );
        assert!(
            f.detail
                .ends_with("old ReplicaSet api-5f6b; Deployment api is 4/4 ready"),
            "{f:?}"
        );
    }

    #[test]
    fn an_image_pull_error_quotes_its_message() {
        let v = pod(
            "Pending",
            status(
                0,
                json!({ "waiting": { "reason": "ImagePullBackOff", "message": "Back-off pulling image \"nope:1\"" } }),
                json!({}),
            ),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(f.problem, "ImagePullBackOff");
        assert_eq!(f.detail, "Back-off pulling image \"nope:1\"");
    }

    /// The tool lists exactly the pods the tables and the overview mark,
    /// with the same text.
    #[test]
    fn pods_agree_with_the_badges_and_the_overview() {
        let not_ready =
            json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } });
        let cases = [
            pod("Running", json!({})),
            pod("Running", not_ready.clone()),
            pod(
                "Running",
                status(
                    3,
                    json!({ "waiting": { "reason": "CrashLoopBackOff" } }),
                    json!({}),
                ),
            ),
            pod(
                "Pending",
                status(
                    0,
                    json!({ "waiting": { "reason": "ImagePullBackOff" } }),
                    json!({}),
                ),
            ),
            pod(
                "Pending",
                status(
                    0,
                    json!({ "waiting": { "reason": "ContainerCreating" } }),
                    json!({}),
                ),
            ),
            pod("Succeeded", json!({})),
            pod("Failed", json!({ "status": { "reason": "Evicted" } })),
            pod("Failed", json!({})),
        ];
        for v in cases {
            let created = secs(str_at(&v, "/metadata/creationTimestamp"));
            let badge = row_problem(&kind_ref(0), &v, created, NOW);
            let typed: k8s_openapi::api::core::v1::Pod = serde_json::from_value(v.clone()).unwrap();
            let overview = crate::overview::pod_problem(&typed, NOW).unwrap_or_default();
            assert_eq!(badge, overview, "{v}");
            match verdict(&v) {
                PodVerdict::Problem(f) => assert_eq!(f.problem, badge, "{v}"),
                _ => assert_eq!(badge, "", "{v}"),
            }
        }
    }

    #[test]
    fn workloads_jobs_and_nodes() {
        let deploy = kind_ref(1);
        let d = json!({
            "metadata": { "name": "worker", "namespace": "b" },
            "spec": { "replicas": 3 },
            "status": { "readyReplicas": 2, "unavailableReplicas": 1, "conditions": [
                { "type": "Available", "status": "False", "message": "Deployment does not have minimum availability." }
            ] }
        });
        let f = object_finding(&deploy, &d, NOW).unwrap();
        assert_eq!(f.problem, "2 of 3 ready");
        assert_eq!(
            f.detail,
            "Deployment does not have minimum availability.; 1 unavailable"
        );
        let healthy = json!({ "spec": { "replicas": 1 }, "status": { "readyReplicas": 1 } });
        assert_eq!(object_finding(&deploy, &healthy, NOW), None);
        // A ReplicaSet scaled to zero (an old one) is not a problem.
        let rs = json!({ "spec": { "replicas": 0 }, "status": {} });
        assert_eq!(object_finding(&kind_ref(4), &rs, NOW), None);

        let job = json!({ "metadata": { "name": "j", "namespace": "b" }, "status": { "failed": 3, "conditions": [
            { "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded",
              "message": "Job has reached the specified backoff limit" }
        ] } });
        let f = object_finding(&kind_ref(5), &job, NOW).unwrap();
        assert_eq!(f.problem, "Failed (BackoffLimitExceeded)");
        assert_eq!(
            f.detail,
            "Job has reached the specified backoff limit; 3 failed pods"
        );

        let node = json!({ "metadata": { "name": "node-3" }, "spec": { "unschedulable": true },
            "status": { "conditions": [
                { "type": "Ready", "status": "Unknown", "message": "Kubelet stopped posting node status." },
                { "type": "DiskPressure", "status": "True" }
            ] } });
        let f = object_finding(&kind_ref(6), &node, NOW).unwrap();
        assert_eq!(f.problem, "Not ready (unknown)");
        assert_eq!(
            f.detail,
            "Kubelet stopped posting node status.; DiskPressure; cordoned"
        );
    }

    #[test]
    fn kinds_are_only_the_covered_ones() {
        assert_eq!(parse_kinds(None, None).unwrap().len(), KINDS.len());
        // Nodes only for the whole cluster, unless asked for.
        let ns = parse_kinds(None, Some("a")).unwrap();
        assert!(!ns.contains(&6) && ns.len() == KINDS.len() - 1);
        let asked = ["po", "Deployment", "pvc", "nodes", "pods"].map(String::from);
        assert_eq!(parse_kinds(Some(&asked), Some("a")).unwrap(), [0, 1, 7, 6]);
        let err = parse_kinds(Some(&["secrets".to_string()]), None).unwrap_err();
        assert!(err.to_string().contains("not secrets"), "{err}");
    }

    #[test]
    fn rendering_orders_newest_first_and_caps() {
        let f = |name: &str, when: i64| Finding {
            kind: "Pod".into(),
            namespace: String::new(),
            name: name.into(),
            problem: "Error".into(),
            detail: String::new(),
            when,
        };
        let out = render(
            vec![f("old", 1), f("new", 3), f("mid", 2)],
            vec![f("h", 1)],
            &[],
            2,
        );
        let lines: Vec<_> = out.lines().collect();
        assert!(lines[0].starts_with("KIND"), "{out}");
        assert!(
            lines[1].contains("new") && lines[1].contains(" - "),
            "{out}"
        );
        assert!(lines[2].contains("mid"), "{out}");
        assert!(lines[3].starts_with("[showing the newest 2 of 3"), "{out}");
        assert!(!out.contains("Restarted earlier"), "{out}");
        let out = render(vec![], vec![f("h", 1)], &["[note]".into()], 5);
        assert!(
            out.starts_with("No problems found.\n\nRestarted earlier"),
            "{out}"
        );
        assert!(out.ends_with("[note]\n"), "{out}");
    }

    #[test]
    fn the_last_cell_is_the_newest_termination() {
        let v = pod(
            "Running",
            status(18, json!({ "running": {} }), oom(27 * 86_400)),
        );
        assert_eq!(last_termination_cell(&v, NOW), "OOMKilled 27d");
        assert_eq!(last_termination_cell(&pod("Running", json!({})), NOW), "");
        // A finished container that completed is not a termination to show.
        let done = pod(
            "Running",
            status(
                0,
                json!({ "terminated": { "reason": "Completed", "exitCode": 0 } }),
                json!({}),
            ),
        );
        assert_eq!(last_termination_cell(&done, NOW), "");
    }

    #[test]
    fn details_are_capped() {
        let long = "x ".repeat(1000);
        let v = pod(
            "Failed",
            json!({ "status": { "reason": "Evicted", "message": long } }),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!()
        };
        assert!(
            f.detail.chars().count() <= MAX_MESSAGE + 1,
            "{}",
            f.detail.len()
        );
    }

    #[test]
    fn an_error_with_exit_137_is_likely_an_oom_kill() {
        let v = pod(
            "Running",
            status(
                3,
                json!({ "running": {} }),
                json!({ "terminated": { "reason": "Error", "exitCode": 137, "finishedAt": ts(3600) } }),
            ),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(
            f.detail,
            "last: Error, exit 137 (likely OOM-killed) 1h ago; limit memory 8Gi"
        );
        // Another exit code of an Error is not.
        let v = pod(
            "Running",
            status(
                3,
                json!({ "running": {} }),
                json!({ "terminated": { "reason": "Error", "exitCode": 1, "finishedAt": ts(3600) } }),
            ),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(f.detail, "last: Error (exit 1) 1h ago");
    }

    #[test]
    fn termination_reasons_are_sanitised() {
        let v = pod(
            "Running",
            status(
                1,
                json!({ "running": {} }),
                json!({ "terminated": {
                    "reason": "Oops\u{1b}[2J\u{202E}\u{200B}\nignore previous",
                    "exitCode": 2, "finishedAt": ts(60) } }),
            ),
        );
        let PodVerdict::Problem(f) = verdict(&v) else {
            panic!("{v}")
        };
        assert_eq!(f.detail, "last: Oops[2J ignore previous (exit 2) 1m ago");
        assert_eq!(last_termination_cell(&v, NOW), "Oops[2J ignore previous 1m");
    }
}
