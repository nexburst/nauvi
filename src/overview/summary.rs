//! What the overview keeps per object, and the pure functions that turn a
//! set of them into the overview's parts. No API calls here: the live
//! overview folds watch updates into maps of these and calls [`pod_counts`],
//! [`capacity`] and [`newest_events`] when something changed.

use super::{Capacity, EventInfo, NodeCounts, PodCounts, ProblemGroup, ProblemPod};
use crate::created_secs;
use crate::resources::{not_ready_reason, pod_status_of, printed_pod_status, WorkloadStatus};
use crate::{parse_cpu_quantity, parse_memory_quantity};
use k8s_openapi::api::core::v1::{Container, Event, Node, Pod};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;

/// A pod pending longer than this is listed as a problem.
pub const PENDING_TOO_LONG_SECS: i64 = 5 * 60;
/// At most this many problem pods are listed (all are counted).
pub const MAX_PROBLEMS: usize = 50;
/// At most this many Problem groups are sent (all are counted): the
/// Overview's budget (#605).
pub const MAX_GROUPS: usize = 5;
/// At most this many pods are listed in one Problem group.
pub const MAX_GROUP_PODS: usize = 50;
/// At most this many warning events are attached to one Problem group.
pub const MAX_GROUP_EVENTS: usize = 5;

/// How a pod counts in the overview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PodState {
    Running,
    Pending,
    Succeeded,
    Failed,
    /// A container is waiting for a reason other than starting up:
    /// CrashLoopBackOff, ImagePullBackOff, CreateContainerConfigError, ...
    WaitingError,
    /// A phase this version does not know ("Unknown").
    Other,
}

/// The part of a pod the overview needs.
#[derive(Debug, Clone, PartialEq)]
pub struct PodSummary {
    pub namespace: String,
    pub name: String,
    /// As in the Pods table and `kubectl get pods`.
    pub status: String,
    pub state: PodState,
    pub ready: bool,
    pub terminating: bool,
    pub restarts: i32,
    /// Unix seconds.
    pub created: i64,
    /// Bound to a node (`spec.nodeName` set).
    pub scheduled: bool,
    pub cpu_request_millicores: u64,
    pub memory_request_bytes: u64,
    /// The limits set, summed like the requests; a container without a
    /// limit adds nothing.
    pub cpu_limit_millicores: u64,
    pub memory_limit_bytes: u64,
    /// App containers and native sidecars without a cpu / memory limit.
    pub cpu_unlimited: u64,
    pub memory_unlimited: u64,
    /// The owning workload ([`crate::owner::pod_workload`]), empty for none.
    pub owner_kind: String,
    pub owner_name: String,
}

/// The part of a node the overview needs.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeSummary {
    pub ready: bool,
    pub cpu_allocatable_millicores: u64,
    pub memory_allocatable_bytes: u64,
    pub pods_allocatable: u64,
}

/// The pod's status the way `kubectl get pods` (and the Pods table) shows
/// it, see [`printed_pod_status`].
pub fn pod_status(pod: &Pod) -> String {
    serde_json::to_value(pod)
        .map(|v| printed_pod_status(&v))
        .unwrap_or_default()
}

fn waiting_reasons(pod: &Pod) -> impl Iterator<Item = &str> {
    let status = pod.status.as_ref();
    let init = status.and_then(|s| s.init_container_statuses.as_deref());
    let main = status.and_then(|s| s.container_statuses.as_deref());
    init.unwrap_or_default()
        .iter()
        .chain(main.unwrap_or_default())
        .filter_map(|c| c.state.as_ref()?.waiting.as_ref()?.reason.as_deref())
}

pub fn pod_summary(pod: &Pod) -> PodSummary {
    let status = pod.status.as_ref();
    let phase = status.and_then(|s| s.phase.as_deref()).unwrap_or_default();
    // The same classification as the Pods table rows and the Workloads
    // overview.
    let state = match pod_status_of(phase, waiting_reasons(pod)) {
        WorkloadStatus::Succeeded => PodState::Succeeded,
        WorkloadStatus::Failed => PodState::Failed,
        WorkloadStatus::Error => PodState::WaitingError,
        WorkloadStatus::Running => PodState::Running,
        WorkloadStatus::Pending => PodState::Pending,
        _ => PodState::Other,
    };
    let ready = status
        .and_then(|s| s.conditions.as_deref())
        .unwrap_or_default()
        .iter()
        .any(|c| c.type_ == "Ready" && c.status == "True");
    let restarts = status
        .and_then(|s| s.container_statuses.as_deref())
        .unwrap_or_default()
        .iter()
        .map(|c| c.restart_count)
        .sum();
    let spec = pod.spec.as_ref();
    let (cpu, memory) = spec.map(|s| pod_resources(s, false)).unwrap_or_default();
    let (cpu_limit, memory_limit) = spec.map(|s| pod_resources(s, true)).unwrap_or_default();
    let (cpu_unlimited, memory_unlimited) = spec.map(unlimited_containers).unwrap_or_default();
    let (owner_kind, owner_name) = crate::owner::pod_workload(pod).unwrap_or_default();
    PodSummary {
        namespace: pod.metadata.namespace.clone().unwrap_or_default(),
        name: pod.metadata.name.clone().unwrap_or_default(),
        status: pod_status(pod),
        state,
        ready,
        terminating: pod.metadata.deletion_timestamp.is_some(),
        restarts,
        created: created_secs(&pod.metadata.creation_timestamp),
        scheduled: spec.and_then(|s| s.node_name.as_ref()).is_some(),
        cpu_request_millicores: cpu,
        memory_request_bytes: memory,
        cpu_limit_millicores: cpu_limit,
        memory_limit_bytes: memory_limit,
        cpu_unlimited,
        memory_unlimited,
        owner_kind,
        owner_name,
    }
}

fn quantity(map: Option<&BTreeMap<String, Quantity>>, key: &str, cpu: bool) -> u64 {
    let Some(q) = map.and_then(|m| m.get(key)) else {
        return 0;
    };
    let parsed = if cpu {
        parse_cpu_quantity(&q.0)
    } else {
        parse_memory_quantity(&q.0)
    };
    parsed.unwrap_or(0)
}

/// A container's (cpu, memory) requests, or its limits.
fn container_resources(c: &Container, limits: bool) -> (u64, u64) {
    let r = c.resources.as_ref();
    let map = if limits {
        r.and_then(|r| r.limits.as_ref())
    } else {
        r.and_then(|r| r.requests.as_ref())
    };
    (quantity(map, "cpu", true), quantity(map, "memory", false))
}

/// A native sidecar: an init container that keeps running
/// (`restartPolicy: Always`).
fn is_sidecar(c: &Container) -> bool {
    c.restart_policy.as_deref() == Some("Always")
}

/// What the scheduler reserves for a pod, or (`limits`) the limits set, the
/// way the scheduler sums them: the app containers plus the native sidecars,
/// or the largest an init container needs (with the sidecars started before
/// it), whichever is larger, plus the pod overhead (which counts towards
/// both).
fn pod_resources(spec: &k8s_openapi::api::core::v1::PodSpec, limits: bool) -> (u64, u64) {
    let add = |(a, b): (u64, u64), (c, m): (u64, u64)| (a + c, b + m);
    let max = |(a, b): (u64, u64), (c, m): (u64, u64)| (a.max(c), b.max(m));
    let mut sidecars = (0, 0);
    let mut init = (0, 0);
    for c in spec.init_containers.as_deref().unwrap_or_default() {
        let own = container_resources(c, limits);
        let needs = if is_sidecar(c) {
            sidecars = add(sidecars, own);
            sidecars
        } else {
            add(own, sidecars)
        };
        init = max(init, needs);
    }
    let app = spec
        .containers
        .iter()
        .map(|c| container_resources(c, limits))
        .fold(sidecars, add);
    let overhead = spec.overhead.as_ref();
    add(
        max(app, init),
        (
            quantity(overhead, "cpu", true),
            quantity(overhead, "memory", false),
        ),
    )
}

/// How many of the pod's long-running containers (app containers and
/// native sidecars) have no (cpu, memory) limit.
fn unlimited_containers(spec: &k8s_openapi::api::core::v1::PodSpec) -> (u64, u64) {
    let sidecars = spec.init_containers.as_deref().unwrap_or_default();
    let running = spec
        .containers
        .iter()
        .chain(sidecars.iter().filter(|c| is_sidecar(c)));
    let mut n = (0, 0);
    for c in running {
        let limits = c.resources.as_ref().and_then(|r| r.limits.as_ref());
        n.0 += u64::from(limits.is_none_or(|l| !l.contains_key("cpu")));
        n.1 += u64::from(limits.is_none_or(|l| !l.contains_key("memory")));
    }
    n
}

pub fn node_summary(node: &Node) -> NodeSummary {
    let status = node.status.as_ref();
    let ready = status
        .and_then(|s| s.conditions.as_deref())
        .unwrap_or_default()
        .iter()
        .any(|c| c.type_ == "Ready" && c.status == "True");
    let alloc = status.and_then(|s| s.allocatable.as_ref());
    let pods = alloc
        .and_then(|a| a.get("pods"))
        .and_then(|q| q.0.parse().ok())
        .unwrap_or(0);
    NodeSummary {
        ready,
        cpu_allocatable_millicores: quantity(alloc, "cpu", true),
        memory_allocatable_bytes: quantity(alloc, "memory", false),
        pods_allocatable: pods,
    }
}

/// An event as the overview lists it, with its time in unix seconds.
pub fn event_info(e: &Event) -> EventInfo {
    let time = e
        .last_timestamp
        .as_ref()
        .map(|t| t.0)
        .or_else(|| e.event_time.as_ref().map(|t| t.0))
        .or_else(|| e.first_timestamp.as_ref().map(|t| t.0))
        .or_else(|| e.metadata.creation_timestamp.as_ref().map(|t| t.0))
        .map(|t| t.as_second())
        .unwrap_or_default();
    let o = &e.involved_object;
    let kind = o.kind.clone().unwrap_or_default();
    let name = o.name.clone().unwrap_or_default();
    EventInfo {
        key: format!(
            "{}/{}",
            e.metadata.namespace.as_deref().unwrap_or_default(),
            e.metadata.name.as_deref().unwrap_or_default()
        ),
        kind: e.type_.clone().unwrap_or_default(),
        reason: e.reason.clone().unwrap_or_default(),
        message: e.message.clone().unwrap_or_default(),
        object: format!("{kind}/{name}"),
        object_api_version: o.api_version.clone().unwrap_or_default(),
        object_kind: kind,
        object_namespace: o.namespace.clone().unwrap_or_default(),
        object_name: name,
        time,
        count: e.count.unwrap_or(1),
        owner_kind: String::new(),
        owner_name: String::new(),
    }
}

/// Why `pod` is a problem, if it is one: a waiting error, failed, running
/// but not ready (with its STATUS, e.g. "Error", when that says why), or
/// pending for too long.
fn problem(pod: &PodSummary, now: i64) -> Option<String> {
    if pod.terminating {
        return None;
    }
    match pod.state {
        PodState::WaitingError | PodState::Failed => Some(pod.status.clone()),
        PodState::Running if !pod.ready => Some(not_ready_reason(&pod.status)),
        PodState::Pending if pod.created > 0 && now - pod.created > PENDING_TOO_LONG_SECS => Some(
            format!("Pending for {}", crate::human::duration(now - pod.created)),
        ),
        _ => None,
    }
}

/// Why `pod` is a problem pod of the overview, if it is one (the tables
/// mark the same pods, see `resources::problems`).
pub fn pod_problem(pod: &Pod, now: i64) -> Option<String> {
    problem(&pod_summary(pod), now)
}

/// Pod counts by state, pods per namespace and the problem pods, as of
/// `now` (unix seconds; it decides which pending pods are overdue).
pub fn pod_counts<'a>(
    namespace: Option<String>,
    pods: impl IntoIterator<Item = &'a PodSummary>,
    now: i64,
) -> PodCounts {
    let mut c = PodCounts {
        namespace,
        total: 0,
        running: 0,
        pending: 0,
        succeeded: 0,
        failed: 0,
        waiting_errors: 0,
        by_namespace: Vec::new(),
        problems: Vec::new(),
        problems_total: 0,
        groups: Vec::new(),
        groups_total: 0,
    };
    let mut by_namespace: HashMap<&str, usize> = HashMap::new();
    // Pods per owning workload, for "18 of 20 pods".
    let mut by_owner: HashMap<(&str, &str, &str), usize> = HashMap::new();
    let mut problems: Vec<(&PodSummary, String)> = Vec::new();
    for pod in pods {
        c.total += 1;
        *by_namespace.entry(&pod.namespace).or_insert(0) += 1;
        if !pod.owner_kind.is_empty() && !pod.terminating {
            *by_owner
                .entry((&pod.namespace, &pod.owner_kind, &pod.owner_name))
                .or_insert(0) += 1;
        }
        match pod.state {
            PodState::Running => c.running += 1,
            PodState::Pending => c.pending += 1,
            PodState::Succeeded => c.succeeded += 1,
            PodState::Failed => c.failed += 1,
            PodState::WaitingError => c.waiting_errors += 1,
            PodState::Other => {}
        }
        if let Some(why) = problem(pod, now) {
            problems.push((pod, why));
        }
    }
    let mut by_namespace: Vec<(String, usize)> = by_namespace
        .into_iter()
        .map(|(ns, n)| (ns.to_string(), n))
        .collect();
    by_namespace.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    c.by_namespace = by_namespace;
    // Waiting errors and failed pods first, then the most restarts, then
    // the oldest.
    problems.sort_by(|(a, _), (b, _)| {
        let err = |p: &PodSummary| !matches!(p.state, PodState::WaitingError | PodState::Failed);
        (
            err(a),
            std::cmp::Reverse(a.restarts),
            a.created,
            &a.namespace,
            &a.name,
        )
            .cmp(&(
                err(b),
                std::cmp::Reverse(b.restarts),
                b.created,
                &b.namespace,
                &b.name,
            ))
    });
    c.problems_total = problems.len();
    let (groups, groups_total) = problem_groups(&problems, &by_owner);
    c.groups = groups;
    c.groups_total = groups_total;
    c.problems = problems
        .iter()
        .take(MAX_PROBLEMS)
        .map(|(p, reason)| problem_pod(p, reason))
        .collect();
    c
}

fn problem_pod(p: &PodSummary, reason: &str) -> ProblemPod {
    ProblemPod {
        namespace: p.namespace.clone(),
        name: p.name.clone(),
        status: p.status.clone(),
        reason: reason.to_string(),
        restarts: p.restarts,
        created: p.created,
        owner_kind: p.owner_kind.clone(),
        owner_name: p.owner_name.clone(),
    }
}

/// An error (red), not pending or not ready (amber): the reason is the
/// pod's STATUS, as for a waiting error, a failed pod or a running one
/// whose container failed ("Error", #263).
fn is_error(p: &PodSummary, reason: &str) -> bool {
    reason == p.status
}

/// What the pods of one workload share to be one group: the reason, with
/// "Pending for 1h" and "Pending for 2h" alike, and a restarting pod's
/// "Error" and "CrashLoopBackOff" alike (a crash loop flips between them).
fn group_reason<'a>(p: &PodSummary, reason: &'a str) -> &'a str {
    if reason.starts_with("Pending for ") {
        "Pending"
    } else if reason == "Error" && p.restarts > 0 {
        "CrashLoopBackOff"
    } else {
        reason
    }
}

/// Pods per (namespace, owner kind, owner name).
type OwnerPods<'a> = HashMap<(&'a str, &'a str, &'a str), usize>;

/// The Problem groups of `problems` (sorted worst first), worst first: the
/// pods of one workload with one reason are one group, a pod without an
/// owner is its own. Errors come before the rest, then the groups with the
/// most pods, the most restarts. The first [`MAX_GROUPS`], and how many
/// there are.
fn problem_groups(
    problems: &[(&PodSummary, String)],
    by_owner: &OwnerPods,
) -> (Vec<ProblemGroup>, usize) {
    let mut groups: Vec<ProblemGroup> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (p, reason) in problems {
        let alone = p.owner_kind.is_empty();
        let (kind, name) = if alone {
            ("Pod", p.name.as_str())
        } else {
            (p.owner_kind.as_str(), p.owner_name.as_str())
        };
        let key = format!("{}/{kind}/{name}/{}", p.namespace, group_reason(p, reason));
        let i = *index.entry(key.clone()).or_insert_with(|| {
            let owner_pods = if alone {
                1
            } else {
                let owner = (p.namespace.as_str(), kind, name);
                by_owner.get(&owner).copied().unwrap_or(1)
            };
            groups.push(ProblemGroup {
                key,
                namespace: p.namespace.clone(),
                owner_kind: if alone { String::new() } else { kind.into() },
                owner_name: if alone { String::new() } else { name.into() },
                reason: reason.clone(),
                error: is_error(p, reason),
                count: 0,
                owner_pods,
                restarts: 0,
                pods: Vec::new(),
                events: Vec::new(),
            });
            groups.len() - 1
        });
        let g = &mut groups[i];
        g.count += 1;
        g.restarts = g.restarts.saturating_add(p.restarts);
        if g.pods.len() < MAX_GROUP_PODS {
            g.pods.push(problem_pod(p, reason));
        }
    }
    let rank = |g: &ProblemGroup| {
        (
            !g.error,
            std::cmp::Reverse(g.count),
            std::cmp::Reverse(g.restarts),
            g.key.clone(),
        )
    };
    groups.sort_by_cached_key(rank);
    let total = groups.len();
    groups.truncate(MAX_GROUPS);
    (groups, total)
}

/// Give each Problem group with an owner the newest [`MAX_GROUP_EVENTS`]
/// warning events of its pods: [`warning_events`] leaves them out.
pub fn attach_group_events<'a>(
    groups: &mut [ProblemGroup],
    events: impl IntoIterator<Item = &'a EventInfo>,
) {
    let mut of: HashMap<(&str, &str), usize> = HashMap::new();
    for (i, g) in groups.iter().enumerate() {
        if g.owner_kind.is_empty() {
            continue;
        }
        for p in &g.pods {
            of.insert((p.namespace.as_str(), p.name.as_str()), i);
        }
    }
    let mut found: Vec<Vec<&EventInfo>> = vec![Vec::new(); groups.len()];
    for e in events {
        if e.object_kind != "Pod" {
            continue;
        }
        if let Some(&i) = of.get(&(e.object_namespace.as_str(), e.object_name.as_str())) {
            found[i].push(e);
        }
    }
    for (g, events) in groups.iter_mut().zip(found) {
        g.events = newest_events(events, MAX_GROUP_EVENTS);
    }
}

/// The `n` newest warning events, newest first, without the events of pods
/// in a Problem group (they belong to that group, #605). An event about a
/// pod in `pods` (by `namespace/name`) names the pod's owning workload.
pub fn warning_events<'a, S: BuildHasher>(
    events: impl IntoIterator<Item = &'a EventInfo>,
    pods: &HashMap<String, PodSummary, S>,
    now: i64,
    n: usize,
) -> Vec<EventInfo> {
    let mut out = Vec::new();
    for e in events {
        let pod = if e.object_kind == "Pod" {
            pods.get(&format!("{}/{}", e.object_namespace, e.object_name))
        } else {
            None
        };
        match pod {
            Some(p) if !p.owner_kind.is_empty() && problem(p, now).is_some() => {}
            Some(p) => out.push(EventInfo {
                owner_kind: p.owner_kind.clone(),
                owner_name: p.owner_name.clone(),
                ..e.clone()
            }),
            None => out.push(e.clone()),
        }
    }
    newest_events(&out, n)
}

pub fn node_counts<'a>(nodes: impl IntoIterator<Item = &'a NodeSummary>) -> NodeCounts {
    let mut c = NodeCounts { total: 0, ready: 0 };
    for n in nodes {
        c.total += 1;
        c.ready += usize::from(n.ready);
    }
    c
}

/// Requests, limits and usage against what the nodes can allocate. Requests
/// and limits count the pods bound to a node that have not finished, like
/// the scheduler.
/// `usage` is the nodes' (cpu millicores, memory bytes) from the metrics
/// API, if it is available.
pub fn capacity<'a, 'b>(
    pods: impl IntoIterator<Item = &'a PodSummary>,
    nodes: impl IntoIterator<Item = &'b NodeSummary>,
    usage: Option<(u64, u64)>,
) -> Capacity {
    let mut c = Capacity {
        cpu_requests_millicores: 0,
        cpu_limits_millicores: 0,
        cpu_unlimited_containers: 0,
        cpu_allocatable_millicores: 0,
        cpu_usage_millicores: usage.map(|u| u.0).unwrap_or(0),
        memory_requests_bytes: 0,
        memory_limits_bytes: 0,
        memory_unlimited_containers: 0,
        memory_allocatable_bytes: 0,
        memory_usage_bytes: usage.map(|u| u.1).unwrap_or(0),
        metrics: usage.is_some(),
        pods: 0,
        pods_allocatable: 0,
    };
    for n in nodes {
        c.cpu_allocatable_millicores += n.cpu_allocatable_millicores;
        c.memory_allocatable_bytes += n.memory_allocatable_bytes;
        c.pods_allocatable += n.pods_allocatable;
    }
    for p in pods {
        if p.scheduled && !matches!(p.state, PodState::Succeeded | PodState::Failed) {
            c.pods += 1;
            c.cpu_requests_millicores += p.cpu_request_millicores;
            c.memory_requests_bytes += p.memory_request_bytes;
            c.cpu_limits_millicores += p.cpu_limit_millicores;
            c.memory_limits_bytes += p.memory_limit_bytes;
            c.cpu_unlimited_containers += p.cpu_unlimited;
            c.memory_unlimited_containers += p.memory_unlimited;
        }
    }
    c
}

/// The `n` newest events, newest first.
pub fn newest_events<'a>(
    events: impl IntoIterator<Item = &'a EventInfo>,
    n: usize,
) -> Vec<EventInfo> {
    let mut all: Vec<&EventInfo> = events.into_iter().collect();
    // Ties by key, the reverse of the order `trim_events` drops them in.
    all.sort_by(|a, b| (b.time, &b.key).cmp(&(a.time, &a.key)));
    all.into_iter().take(n).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;

    fn ts(secs: i64) -> String {
        jiff::Timestamp::from_second(secs).unwrap().to_string()
    }

    fn pod(name: &str, phase: &str, extra: serde_json::Value) -> Pod {
        let mut v = json!({
            "metadata": { "name": name, "namespace": "demo", "creationTimestamp": ts(NOW - 3600) },
            "spec": {
                "nodeName": "node-1",
                "containers": [{ "name": "c", "resources": { "requests": { "cpu": "100m", "memory": "64Mi" } } }]
            },
            "status": {
                "phase": phase,
                "conditions": [{ "type": "Ready", "status": if phase == "Running" { "True" } else { "False" } }]
            }
        });
        merge(&mut v, extra);
        serde_json::from_value(v).unwrap()
    }

    fn merge(a: &mut serde_json::Value, b: serde_json::Value) {
        match (a, b) {
            (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
                for (k, v) in b {
                    merge(a.entry(k).or_insert(serde_json::Value::Null), v);
                }
            }
            (a, b) => *a = b,
        }
    }

    fn crash_looping(name: &str) -> Pod {
        pod(
            name,
            "Running",
            json!({ "status": {
                "conditions": [{ "type": "Ready", "status": "False" }],
                "containerStatuses": [{
                    "name": "c", "image": "busybox", "imageID": "", "ready": false, "restartCount": 7,
                    "state": { "waiting": { "reason": "CrashLoopBackOff" } }
                }]
            }}),
        )
    }

    #[test]
    fn crash_looping_pods_are_not_running() {
        let p = pod_summary(&crash_looping("crashed"));
        assert_eq!(p.status, "CrashLoopBackOff");
        assert_eq!(p.state, PodState::WaitingError);
        assert_eq!(p.restarts, 7);
    }

    #[test]
    fn starting_containers_are_not_errors() {
        let p = pod_summary(&pod(
            "new",
            "Pending",
            json!({ "status": { "containerStatuses": [{
                "name": "c", "image": "busybox", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "waiting": { "reason": "ContainerCreating" } }
            }]}}),
        ));
        assert_eq!(p.state, PodState::Pending);
        assert_eq!(p.status, "ContainerCreating");
    }

    #[test]
    fn counts_and_problems() {
        let pods: Vec<PodSummary> = [
            pod("web-1", "Running", json!({})),
            crash_looping("crashed"),
            pod("job", "Succeeded", json!({})),
            pod("evicted", "Failed", json!({ "status": { "reason": "Evicted" } })),
            // Pending for an hour, and one just created.
            pod("stuck", "Pending", json!({ "spec": { "nodeName": null } })),
            pod(
                "fresh",
                "Pending",
                json!({ "metadata": { "creationTimestamp": ts(NOW - 30) }, "spec": { "nodeName": null } }),
            ),
            pod(
                "unready",
                "Running",
                json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } }),
            ),
            // Running, one container exited with an error (#263): the
            // problem says "Error", as STATUS in the Pods table does.
            pod(
                "half-failed",
                "Running",
                json!({ "status": {
                    "conditions": [{ "type": "Ready", "status": "False" }],
                    "containerStatuses": [{
                        "name": "c", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                        "state": { "terminated": { "exitCode": 1, "reason": "Error" } }
                    }]
                } }),
            ),
            pod(
                "going",
                "Running",
                json!({ "metadata": { "deletionTimestamp": ts(NOW) },
                         "status": { "conditions": [{ "type": "Ready", "status": "False" }] } }),
            ),
        ]
        .iter()
        .map(pod_summary)
        .collect();

        let c = pod_counts(None, &pods, NOW);
        assert_eq!(c.total, 9);
        assert_eq!(c.running, 4); // web-1, unready, half-failed, going
        assert_eq!(c.waiting_errors, 1);
        assert_eq!(c.pending, 2);
        assert_eq!(c.succeeded, 1);
        assert_eq!(c.failed, 1);
        assert_eq!(c.by_namespace, vec![("demo".to_string(), 9)]);

        let problems: Vec<(&str, &str)> = c
            .problems
            .iter()
            .map(|p| (p.name.as_str(), p.reason.as_str()))
            .collect();
        assert_eq!(
            problems,
            vec![
                ("crashed", "CrashLoopBackOff"),
                ("evicted", "Evicted"),
                ("half-failed", "Error"),
                ("stuck", "Pending for 1h"),
                ("unready", "Not ready"),
            ]
        );
        assert_eq!(c.problems_total, 5);
        assert_eq!(c.problems[0].status, "CrashLoopBackOff");
    }

    /// `p`, owned by the ReplicaSet `web-5d8f` of the Deployment `web`.
    fn of_web(mut p: Pod) -> Pod {
        merge_pod(
            &mut p,
            json!({ "metadata": {
                "labels": { "pod-template-hash": "5d8f" },
                "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-5d8f", "uid": "u", "controller": true }]
            }}),
        );
        p
    }

    fn merge_pod(p: &mut Pod, extra: serde_json::Value) {
        let mut v = serde_json::to_value(&*p).unwrap();
        merge(&mut v, extra);
        *p = serde_json::from_value(v).unwrap();
    }

    fn stuck(name: &str, ago: i64) -> Pod {
        pod(
            name,
            "Pending",
            json!({ "metadata": { "creationTimestamp": ts(NOW - ago) }, "spec": { "nodeName": null } }),
        )
    }

    #[test]
    fn problem_pods_of_one_workload_and_reason_are_one_group() {
        let pods: Vec<PodSummary> = [
            of_web(crash_looping("web-a")),
            of_web(crash_looping("web-b")),
            of_web(crash_looping("web-c")),
            // Between two back-offs a crash-looping pod reads Error: the same group.
            of_web(pod(
                "web-d",
                "Running",
                json!({ "status": {
                    "conditions": [{ "type": "Ready", "status": "False" }],
                    "containerStatuses": [{
                    "name": "c", "image": "busybox", "imageID": "", "ready": false, "restartCount": 7,
                    "state": { "terminated": { "reason": "Error", "exitCode": 1 } }
                }]}}),
            )),
            of_web(pod("web-ok", "Running", json!({}))),
            // Pending for different times: still one group.
            of_web(stuck("web-p1", 3600)),
            of_web(stuck("web-p2", 7200)),
            // A pod without an owner is a group of its own.
            crash_looping("crashed"),
            pod(
                "evicted",
                "Failed",
                json!({ "status": { "reason": "Evicted" } }),
            ),
        ]
        .iter()
        .map(pod_summary)
        .collect();
        assert_eq!(
            (pods[0].owner_kind.as_str(), pods[0].owner_name.as_str()),
            ("Deployment", "web")
        );

        let c = pod_counts(None, &pods, NOW);
        assert_eq!(c.problems_total, 8);
        assert_eq!(
            (
                c.problems[0].name.as_str(),
                c.problems[0].owner_name.as_str()
            ),
            ("crashed", "")
        );
        assert_eq!(c.problems[1].owner_name, "web");
        assert_eq!(c.groups_total, 4);
        let groups: Vec<(&str, &str, &str, usize, usize, i32)> = c
            .groups
            .iter()
            .map(|g| {
                (
                    g.owner_kind.as_str(),
                    g.owner_name.as_str(),
                    g.reason.as_str(),
                    g.count,
                    g.owner_pods,
                    g.restarts,
                )
            })
            .collect();
        // Errors first, the most pods first; then the rest.
        assert_eq!(
            groups,
            vec![
                ("Deployment", "web", "CrashLoopBackOff", 4, 7, 28),
                ("", "", "CrashLoopBackOff", 1, 1, 7),
                ("", "", "Evicted", 1, 1, 0),
                ("Deployment", "web", "Pending for 2h", 2, 7, 0),
            ]
        );
        assert!(c.groups[0].error && !c.groups[3].error);
        let names =
            |i: usize| -> Vec<&str> { c.groups[i].pods.iter().map(|p| p.name.as_str()).collect() };
        assert_eq!(names(0), vec!["web-a", "web-b", "web-c", "web-d"]);
        assert_eq!(names(1), vec!["crashed"]);
        assert_eq!(names(3), vec!["web-p2", "web-p1"]);
    }

    #[test]
    fn at_most_five_groups_are_sent() {
        let pods: Vec<PodSummary> = (0..8)
            .map(|i| pod_summary(&crash_looping(&format!("lone-{i}"))))
            .collect();
        let c = pod_counts(None, &pods, NOW);
        assert_eq!(c.groups.len(), MAX_GROUPS);
        assert_eq!(c.groups_total, 8);
    }

    #[test]
    fn events_of_pods_in_a_problem_group_are_left_out_of_warnings() {
        let pods: HashMap<String, PodSummary> = [
            of_web(crash_looping("web-a")),
            of_web(pod("web-ok", "Running", json!({}))),
            crash_looping("crashed"),
        ]
        .iter()
        .map(|p| {
            let s = pod_summary(p);
            (format!("{}/{}", s.namespace, s.name), s)
        })
        .collect();
        let event = |name: &str, kind: &str, object: &str| EventInfo {
            key: format!("demo/{name}"),
            kind: "Warning".into(),
            reason: "BackOff".into(),
            message: String::new(),
            object: format!("{kind}/{object}"),
            object_api_version: "v1".into(),
            object_kind: kind.into(),
            object_namespace: "demo".into(),
            object_name: object.into(),
            time: NOW,
            count: 1,
            owner_kind: String::new(),
            owner_name: String::new(),
        };
        let events = [
            event("1", "Pod", "web-a"),
            event("2", "Pod", "web-ok"),
            event("3", "Pod", "crashed"),
            event("4", "Pod", "gone"),
            event("5", "Deployment", "web"),
        ];
        let shown = warning_events(&events, &pods, NOW, 10);
        let keys: Vec<(&str, &str)> = shown
            .iter()
            .map(|e| (e.key.as_str(), e.owner_name.as_str()))
            .collect();
        // web-a's BackOff belongs to its group; web-ok's names its owner.
        assert_eq!(
            keys,
            vec![
                ("demo/5", ""),
                ("demo/4", ""),
                ("demo/3", ""),
                ("demo/2", "web")
            ]
        );

        // ... and shows in the group; the lone pod's group has none.
        let mut c = pod_counts(None, pods.values(), NOW);
        attach_group_events(&mut c.groups, &events);
        let of = |owner: &str| -> Vec<&str> {
            let g = c.groups.iter().find(|g| g.owner_name == owner).unwrap();
            g.events.iter().map(|e| e.key.as_str()).collect()
        };
        assert_eq!(of("web"), vec!["demo/1"]);
        assert!(of("").is_empty());
    }

    #[test]
    fn capacity_counts_requests_of_scheduled_unfinished_pods() {
        let pods: Vec<PodSummary> = [
            pod("a", "Running", json!({})),
            crash_looping("b"),
            pod("done", "Succeeded", json!({})),
            pod(
                "unscheduled",
                "Pending",
                json!({ "spec": { "nodeName": null } }),
            ),
            pod(
                "init",
                "Running",
                json!({ "spec": { "initContainers": [
                    { "name": "i", "resources": { "requests": { "cpu": "1", "memory": "32Mi" } } }
                ]}}),
            ),
        ]
        .iter()
        .map(pod_summary)
        .collect();
        let node: Node = serde_json::from_value(json!({
            "metadata": { "name": "node-1" },
            "status": {
                "allocatable": { "cpu": "4", "memory": "8Gi", "pods": "110" },
                "conditions": [{ "type": "Ready", "status": "True" }]
            }
        }))
        .unwrap();
        let nodes = [node_summary(&node), node_summary(&node)];
        let c = capacity(&pods, &nodes, Some((900, 1 << 30)));
        assert_eq!(c.pods, 3);
        // 100m + 100m + max(100m, 1 init core).
        assert_eq!(c.cpu_requests_millicores, 1200);
        assert_eq!(c.memory_requests_bytes, 3 * 64 * 1024 * 1024);
        assert_eq!(c.cpu_allocatable_millicores, 8000);
        assert_eq!(c.memory_allocatable_bytes, 16 << 30);
        assert_eq!(c.pods_allocatable, 220);
        assert!(c.metrics);
        assert_eq!(c.cpu_usage_millicores, 900);

        assert_eq!(node_counts(&nodes), NodeCounts { total: 2, ready: 2 });
        assert!(!capacity(&pods, &nodes, None).metrics);
    }

    #[test]
    fn capacity_sums_the_limits_that_are_set() {
        let limited = |name: &str, extra: serde_json::Value| {
            pod(
                name,
                "Running",
                merge_into(
                    json!({ "spec": { "containers": [
                        { "name": "a", "resources": {
                            "requests": { "cpu": "100m", "memory": "64Mi" },
                            "limits": { "cpu": "500m", "memory": "128Mi" } } },
                        // No limits: adds nothing to them.
                        { "name": "b", "resources": { "requests": { "cpu": "50m" } } }
                    ]}}),
                    extra,
                ),
            )
        };
        let pods: Vec<PodSummary> = [
            limited("plain", json!({})),
            // An init container with a larger limit wins, per resource; the
            // overhead counts towards the limits too.
            limited(
                "init",
                json!({ "spec": {
                    "initContainers": [{ "name": "i", "resources": { "limits": { "cpu": "2", "memory": "16Mi" } } }],
                    "overhead": { "cpu": "10m", "memory": "1Mi" }
                }}),
            ),
            // Finished or unscheduled pods count for neither.
            limited("done", json!({ "status": { "phase": "Succeeded" } })),
            limited("unscheduled", json!({ "spec": { "nodeName": null } })),
        ]
        .iter()
        .map(pod_summary)
        .collect();
        assert_eq!(pods[0].cpu_limit_millicores, 500);
        assert_eq!(pods[0].memory_limit_bytes, 128 << 20);
        assert_eq!(pods[1].cpu_limit_millicores, 2010);
        assert_eq!(pods[1].memory_limit_bytes, 129 << 20);

        let c = capacity(&pods, &[], None);
        assert_eq!(c.pods, 2);
        assert_eq!(c.cpu_limits_millicores, 500 + 2010);
        assert_eq!(c.memory_limits_bytes, (128 + 129) << 20);
        // Requests are unchanged: 150m each, plus the overhead.
        assert_eq!(c.cpu_requests_millicores, 150 + 160);
        assert_eq!(c.memory_requests_bytes, (64 + 65) << 20);
        assert!(!c.metrics);
        // Container b of each counted pod has no limit; the init container
        // of "init" is not counted (it does not keep running).
        assert_eq!((pods[1].cpu_unlimited, pods[1].memory_unlimited), (1, 1));
        assert_eq!(c.cpu_unlimited_containers, 2);
        assert_eq!(c.memory_unlimited_containers, 2);
    }

    #[test]
    fn native_sidecars_add_to_the_app_containers_like_the_scheduler() {
        const MI: u64 = 1 << 20;
        let app = json!({ "name": "app", "resources": {
            "requests": { "cpu": "100m", "memory": "64Mi" },
            "limits": { "cpu": "200m", "memory": "128Mi" } } });
        let p = pod_summary(&pod(
            "meshed",
            "Running",
            json!({ "spec": {
                "containers": [app.clone()],
                "initContainers": [
                    { "name": "setup", "resources": {
                        "requests": { "cpu": "1" }, "limits": { "cpu": "2" } } },
                    { "name": "proxy", "restartPolicy": "Always", "resources": {
                        "requests": { "cpu": "50m", "memory": "32Mi" },
                        "limits": { "cpu": "100m", "memory": "64Mi" } } },
                    // Runs with the proxy already started.
                    { "name": "late", "resources": {
                        "requests": { "cpu": "500m", "memory": "512Mi" } } }
                ]
            }}),
        ));
        // cpu: setup's 1 core wins over app + proxy (150m); memory: late's
        // 512Mi plus the proxy's 32Mi wins over app + proxy (96Mi).
        assert_eq!(p.cpu_request_millicores, 1000);
        assert_eq!(p.memory_request_bytes, 544 * MI);
        // Limits: setup's 2 cores; app + proxy (192Mi) for memory.
        assert_eq!(p.cpu_limit_millicores, 2000);
        assert_eq!(p.memory_limit_bytes, 192 * MI);
        assert_eq!((p.cpu_unlimited, p.memory_unlimited), (0, 0));

        // Only a sidecar: it adds to the app container, and without limits
        // it counts as a container without a limit.
        let p = pod_summary(&pod(
            "sidecar",
            "Running",
            json!({ "spec": {
                "containers": [app],
                "initContainers": [{ "name": "log", "restartPolicy": "Always", "resources": {
                    "requests": { "cpu": "50m", "memory": "32Mi" } } }]
            }}),
        ));
        assert_eq!(p.cpu_request_millicores, 150);
        assert_eq!(p.memory_request_bytes, 96 * MI);
        assert_eq!(p.cpu_limit_millicores, 200);
        assert_eq!(p.memory_limit_bytes, 128 * MI);
        assert_eq!((p.cpu_unlimited, p.memory_unlimited), (1, 1));
    }

    fn merge_into(mut a: serde_json::Value, b: serde_json::Value) -> serde_json::Value {
        merge(&mut a, b);
        a
    }

    #[test]
    fn events_link_to_their_object_and_sort_newest_first() {
        let event = |name: &str, at: i64| -> Event {
            serde_json::from_value(json!({
                "metadata": { "name": name, "namespace": "demo" },
                "involvedObject": { "apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "namespace": "demo" },
                "reason": "FailedCreate", "message": "quota", "type": "Warning",
                "lastTimestamp": ts(at), "count": 3
            }))
            .unwrap()
        };
        let infos: Vec<EventInfo> = [event("old", NOW - 600), event("new", NOW)]
            .iter()
            .map(event_info)
            .collect();
        let newest = newest_events(&infos, 1);
        assert_eq!(newest.len(), 1);
        let e = &newest[0];
        assert_eq!(e.key, "demo/new");
        assert_eq!(e.time, NOW);
        assert_eq!(
            (
                e.object.as_str(),
                e.object_api_version.as_str(),
                e.object_kind.as_str(),
                e.object_namespace.as_str(),
                e.object_name.as_str()
            ),
            ("Deployment/web", "apps/v1", "Deployment", "demo", "web")
        );
        assert_eq!(e.count, 3);
    }
}
