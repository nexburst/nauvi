//! The Workloads overview's parts: what it keeps per object and the pure
//! functions that turn those into per-kind status counts and the problem
//! list. The live part is in `workloads_live`.

use super::EventInfo;
use crate::resources::{
    classify, row_problem, statuses_of, ResourceRef, WorkloadStatus, WORKLOAD_KINDS,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// At most this many problem workloads are listed (all are counted).
pub const MAX_PROBLEMS: usize = 50;

/// The kinds of [`WORKLOAD_KINDS`], with their plural for notes.
pub(super) const LABELS: [&str; 7] = [
    "Pods",
    "Deployments",
    "DaemonSets",
    "StatefulSets",
    "ReplicaSets",
    "Jobs",
    "CronJobs",
];

/// How many objects of one status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct StatusCount {
    pub status: WorkloadStatus,
    pub count: usize,
}

/// The counts of one workload kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct KindCounts {
    /// API group ("" for pods) and kind, to find the kind's table.
    pub group: String,
    pub kind: String,
    pub total: usize,
    /// Every status the kind uses, in card order, zeros included (except an
    /// `Unknown` with no pods).
    pub statuses: Vec<StatusCount>,
}

/// A workload worth looking at: not all replicas ready, a failed job, a
/// suspended cron job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ProblemWorkload {
    pub group: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub status: WorkloadStatus,
    /// "1/3 ready", "BackoffLimitExceeded", "Suspended".
    pub reason: String,
    /// Unix seconds.
    pub created: i64,
}

/// The Workloads overview of the selected namespaces.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct WorkloadsOverview {
    /// In sidebar order. A kind the user may not list anywhere in the scope
    /// is left out, with a note.
    pub kinds: Vec<KindCounts>,
    /// Failed first, then the oldest; at most [`MAX_PROBLEMS`].
    pub problems: Vec<ProblemWorkload>,
    pub problems_total: usize,
    /// Warning events about workload objects, newest first.
    pub events: Vec<EventInfo>,
    /// What is missing or narrowed, and why.
    pub notes: Vec<String>,
}

/// The part of a workload object the overview keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkloadSummary {
    pub namespace: String,
    pub name: String,
    pub status: WorkloadStatus,
    /// Why it is a problem, if it is one worth listing.
    pub problem: Option<String>,
    pub created: i64,
}

/// Whether the object's controller is a Deployment: its ReplicaSets'
/// problems are the Deployment's, listed once.
fn owned_by_deployment(v: &Value) -> bool {
    v.pointer("/metadata/ownerReferences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|o| o["controller"] == Value::Bool(true) && o["kind"] == "Deployment")
}

/// The summary of an object of `WORKLOAD_KINDS[kind]` (as JSON). Why it is
/// a problem is the table rows' reason ([`row_problem`]), plus "Suspended"
/// for a suspended CronJob. Pods are counted, not listed as problems: the
/// cluster overview lists those.
pub fn workload_summary(kind: usize, v: &Value) -> WorkloadSummary {
    let (group, k) = WORKLOAD_KINDS[kind];
    let status = classify(group, k, v).expect("a workload kind");
    let listed = k != "Pod" && !(k == "ReplicaSet" && owned_by_deployment(v));
    let resource = ResourceRef {
        group: group.into(),
        version: String::new(),
        kind: k.into(),
        plural: String::new(),
        namespaced: true,
    };
    let problem = match row_problem(&resource, v, 0, 0) {
        _ if !listed => None,
        p if !p.is_empty() => Some(p),
        _ if k == "CronJob" && status == WorkloadStatus::Suspended => Some("Suspended".into()),
        _ => None,
    };
    let meta = |f: &str| {
        v.pointer(&format!("/metadata/{f}"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let created = v
        .pointer("/metadata/creationTimestamp")
        .and_then(Value::as_str)
        .and_then(|t| t.parse::<jiff::Timestamp>().ok())
        .map(|t| t.as_second())
        .unwrap_or_default();
    WorkloadSummary {
        namespace: meta("namespace"),
        name: meta("name"),
        status,
        problem,
        created,
    }
}

/// The counts of `WORKLOAD_KINDS[kind]` over `items`.
pub fn kind_counts<'a>(
    kind: usize,
    items: impl IntoIterator<Item = &'a WorkloadSummary>,
) -> KindCounts {
    let (group, k) = WORKLOAD_KINDS[kind];
    let mut by: BTreeMap<WorkloadStatus, usize> = BTreeMap::new();
    let mut total = 0;
    for w in items {
        total += 1;
        *by.entry(w.status).or_insert(0) += 1;
    }
    KindCounts {
        group: group.into(),
        kind: k.into(),
        total,
        statuses: statuses_of(group, k)
            .iter()
            .map(|&status| StatusCount {
                status,
                count: by.get(&status).copied().unwrap_or(0),
            })
            .filter(|s| s.status != WorkloadStatus::Unknown || s.count > 0)
            .collect(),
    }
}

/// The problem workloads among `items` (kind index, summary), failed first,
/// then the oldest; at most [`MAX_PROBLEMS`], with how many there are.
pub fn problems<'a>(
    items: impl IntoIterator<Item = (usize, &'a WorkloadSummary)>,
) -> (Vec<ProblemWorkload>, usize) {
    let mut all: Vec<(usize, &WorkloadSummary, &str)> = items
        .into_iter()
        .filter_map(|(k, w)| Some((k, w, w.problem.as_deref()?)))
        .collect();
    all.sort_by(|(ka, a, _), (kb, b, _)| {
        let failed = |w: &WorkloadSummary| w.status != WorkloadStatus::Failed;
        (failed(a), a.created, ka, &a.namespace, &a.name).cmp(&(
            failed(b),
            b.created,
            kb,
            &b.namespace,
            &b.name,
        ))
    });
    let total = all.len();
    let list = all
        .into_iter()
        .take(MAX_PROBLEMS)
        .map(|(k, w, reason)| {
            let (group, kind) = WORKLOAD_KINDS[k];
            ProblemWorkload {
                group: group.into(),
                kind: kind.into(),
                namespace: w.namespace.clone(),
                name: w.name.clone(),
                status: w.status,
                reason: reason.to_string(),
                created: w.created,
            }
        })
        .collect();
    (list, total)
}

/// Whether an event is about a workload object.
pub fn about_a_workload(e: &EventInfo) -> bool {
    let group = e
        .object_api_version
        .split_once('/')
        .map(|(g, _)| g)
        .unwrap_or("");
    WORKLOAD_KINDS.contains(&(group, e.object_kind.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use WorkloadStatus::*;

    const POD: usize = 0;
    const DEPLOY: usize = 1;
    const RS: usize = 4;
    const JOB: usize = 5;
    const CRON: usize = 6;

    fn deploy(name: &str, ready: i64, replicas: i64, created: &str) -> WorkloadSummary {
        workload_summary(
            DEPLOY,
            &json!({
                "metadata": { "name": name, "namespace": "demo", "creationTimestamp": created },
                "spec": { "replicas": replicas },
                "status": { "readyReplicas": ready }
            }),
        )
    }

    #[test]
    fn counts_every_status_of_the_kind() {
        let items = [
            deploy("a", 1, 1, "2024-01-01T00:00:00Z"),
            deploy("b", 0, 2, "2024-01-01T00:00:00Z"),
            deploy("c", 3, 3, "2024-01-01T00:00:00Z"),
        ];
        let c = kind_counts(DEPLOY, &items);
        assert_eq!(
            (c.group.as_str(), c.kind.as_str(), c.total),
            ("apps", "Deployment", 3)
        );
        let by: Vec<(WorkloadStatus, usize)> =
            c.statuses.iter().map(|s| (s.status, s.count)).collect();
        assert_eq!(by, vec![(Running, 2), (Pending, 1), (Failed, 0)]);

        // Pods: Unknown only when there is one.
        let pods = kind_counts(POD, &[]);
        assert_eq!(pods.total, 0);
        assert!(pods.statuses.iter().all(|s| s.status != Unknown));
        let odd = workload_summary(POD, &json!({ "status": { "phase": "Gone" } }));
        let pods = kind_counts(POD, [&odd]);
        assert_eq!(pods.statuses.last().unwrap().status, Unknown);
    }

    #[test]
    fn problems_are_listed_once_failed_first() {
        let stuck = deploy("stuck", 0, 2, "2024-01-02T00:00:00Z");
        let fine = deploy("fine", 2, 2, "2024-01-01T00:00:00Z");
        let failed_job = workload_summary(
            JOB,
            &json!({
                "metadata": { "name": "migrate", "namespace": "demo", "creationTimestamp": "2024-01-03T00:00:00Z" },
                "status": { "conditions": [{ "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded" }] }
            }),
        );
        let suspended = workload_summary(
            CRON,
            &json!({ "metadata": { "name": "nightly", "namespace": "demo" }, "spec": { "suspend": true } }),
        );
        // The Deployment's ReplicaSet: its problem is the Deployment's.
        let rs = workload_summary(
            RS,
            &json!({
                "metadata": { "name": "stuck-5d8f", "namespace": "demo",
                    "ownerReferences": [{ "kind": "Deployment", "name": "stuck", "controller": true }] },
                "spec": { "replicas": 2 }
            }),
        );
        let crashing = workload_summary(
            POD,
            &json!({ "status": { "phase": "Running", "containerStatuses": [
                { "state": { "waiting": { "reason": "CrashLoopBackOff" } } }
            ]}}),
        );
        assert_eq!(crashing.status, Error);
        assert_eq!(rs.status, Pending);
        let (list, total) = problems([
            (DEPLOY, &stuck),
            (DEPLOY, &fine),
            (JOB, &failed_job),
            (CRON, &suspended),
            (RS, &rs),
            (POD, &crashing),
        ]);
        assert_eq!(total, 3);
        let got: Vec<(&str, &str, &str)> = list
            .iter()
            .map(|p| (p.kind.as_str(), p.name.as_str(), p.reason.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Job", "migrate", "Failed (BackoffLimitExceeded)"),
                ("CronJob", "nightly", "Suspended"),
                ("Deployment", "stuck", "0 of 2 ready"),
            ]
        );
        assert_eq!(list[0].group, "batch");
        assert_eq!(list[2].created, 1_704_153_600);
    }

    #[test]
    fn workload_events_are_told_apart() {
        let e = |api: &str, kind: &str| EventInfo {
            key: "k".into(),
            kind: "Warning".into(),
            reason: String::new(),
            message: String::new(),
            object: String::new(),
            object_api_version: api.into(),
            object_kind: kind.into(),
            object_namespace: String::new(),
            object_name: String::new(),
            time: 0,
            count: 1,
            owner_kind: String::new(),
            owner_name: String::new(),
        };
        assert!(about_a_workload(&e("apps/v1", "Deployment")));
        assert!(about_a_workload(&e("v1", "Pod")));
        assert!(about_a_workload(&e("batch/v1", "CronJob")));
        assert!(!about_a_workload(&e("v1", "Node")));
        assert!(!about_a_workload(&e("v1", "Deployment")));
    }
}
