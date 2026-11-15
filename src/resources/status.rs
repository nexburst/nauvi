//! The status of a workload object, as the Workloads overview counts it and
//! as a table row carries it ([`super::ResourceRow::status`]), so a click on
//! "Deployments: 2 Pending" opens exactly the rows it counted.
//!
//! Pure functions of the object as JSON. Why an object is a problem is
//! [`super::row_problem`]'s job (`problems.rs`); this only buckets it.

use serde::Serialize;
use serde_json::Value;

/// How a workload object counts. Not every kind uses every status: see
/// [`statuses_of`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum WorkloadStatus {
    /// Pods: phase Running without a waiting error. Controllers: every
    /// desired replica ready. Jobs: still running. Cron jobs: a job is
    /// active.
    Running,
    /// Pods: phase Pending. Controllers: some replicas not ready yet.
    Pending,
    /// Pods: a container waits on an error (CrashLoopBackOff,
    /// ImagePullBackOff, ...).
    Error,
    /// Pods: phase Failed. Controllers: a rollout past its deadline or a
    /// replica that could not be created. Jobs: the Failed condition.
    Failed,
    /// Pods: phase Succeeded. Jobs: complete.
    Succeeded,
    /// Jobs and cron jobs with `spec.suspend`.
    Suspended,
    /// Cron jobs waiting for their next run.
    Scheduled,
    /// A pod phase this version does not know.
    Unknown,
}

impl WorkloadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "Running",
            Self::Pending => "Pending",
            Self::Error => "Error",
            Self::Failed => "Failed",
            Self::Succeeded => "Succeeded",
            Self::Suspended => "Suspended",
            Self::Scheduled => "Scheduled",
            Self::Unknown => "Unknown",
        }
    }
}

/// The workload kinds the overview counts, in sidebar order: (group, kind).
pub const WORKLOAD_KINDS: [(&str, &str); 7] = [
    ("", "Pod"),
    ("apps", "Deployment"),
    ("apps", "DaemonSet"),
    ("apps", "StatefulSet"),
    ("apps", "ReplicaSet"),
    ("batch", "Job"),
    ("batch", "CronJob"),
];

/// The statuses a kind is counted in, in the order a card shows them.
/// Empty for kinds that are not workloads.
pub fn statuses_of(group: &str, kind: &str) -> &'static [WorkloadStatus] {
    use WorkloadStatus::*;
    match (group, kind) {
        ("", "Pod") => &[Running, Pending, Error, Failed, Succeeded, Unknown],
        ("apps", "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet") => {
            &[Running, Pending, Failed]
        }
        ("batch", "Job") => &[Running, Failed, Succeeded, Suspended],
        ("batch", "CronJob") => &[Scheduled, Running, Suspended],
        _ => &[],
    }
}

/// Waiting reasons that are part of a normal start, not an error.
pub const STARTING: [&str; 2] = ["ContainerCreating", "PodInitializing"];

/// A pod's status from its phase and its containers' waiting reasons (init
/// containers first): a waiting error wins over Running and Pending, not
/// over a finished phase.
pub fn pod_status_of<'a>(
    phase: &str,
    mut waiting: impl Iterator<Item = &'a str>,
) -> WorkloadStatus {
    match phase {
        "Succeeded" => WorkloadStatus::Succeeded,
        "Failed" => WorkloadStatus::Failed,
        _ if waiting.any(|r| !STARTING.contains(&r)) => WorkloadStatus::Error,
        "Running" => WorkloadStatus::Running,
        "Pending" => WorkloadStatus::Pending,
        _ => WorkloadStatus::Unknown,
    }
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

/// Whether the condition `type_` has `status`, and (if given) `reason`.
fn has_condition(v: &Value, type_: &str, status: &str, reason: Option<&str>) -> bool {
    array(v, "/status/conditions").any(|c| {
        c["type"].as_str() == Some(type_)
            && c["status"].as_str() == Some(status)
            && reason.is_none_or(|r| c["reason"].as_str() == Some(r))
    })
}

fn suspended(v: &Value) -> bool {
    v.pointer("/spec/suspend") == Some(&Value::Bool(true))
}

fn pod(v: &Value) -> WorkloadStatus {
    let waiting = array(v, "/status/initContainerStatuses")
        .chain(array(v, "/status/containerStatuses"))
        .filter_map(|c| c.pointer("/state/waiting/reason").and_then(Value::as_str));
    let phase = v.pointer("/status/phase").and_then(Value::as_str);
    pod_status_of(phase.unwrap_or_default(), waiting)
}

/// Deployments, StatefulSets, ReplicaSets and DaemonSets: a stuck rollout
/// is Failed, otherwise ready against desired.
fn replicas(v: &Value, ready: i64, desired: i64) -> WorkloadStatus {
    let stuck = has_condition(v, "Progressing", "False", Some("ProgressDeadlineExceeded"))
        || has_condition(v, "ReplicaFailure", "True", None);
    if stuck {
        WorkloadStatus::Failed
    } else if ready >= desired {
        WorkloadStatus::Running
    } else {
        WorkloadStatus::Pending
    }
}

fn job(v: &Value) -> WorkloadStatus {
    if has_condition(v, "Failed", "True", None) || has_condition(v, "FailureTarget", "True", None) {
        WorkloadStatus::Failed
    } else if has_condition(v, "Complete", "True", None)
        || has_condition(v, "SuccessCriteriaMet", "True", None)
    {
        WorkloadStatus::Succeeded
    } else if suspended(v) {
        WorkloadStatus::Suspended
    } else {
        WorkloadStatus::Running
    }
}

fn cronjob(v: &Value) -> WorkloadStatus {
    if suspended(v) {
        WorkloadStatus::Suspended
    } else if array(v, "/status/active").next().is_some() {
        WorkloadStatus::Running
    } else {
        WorkloadStatus::Scheduled
    }
}

/// The status of an object of `group`/`kind` (as JSON), or `None` for
/// kinds that are not workloads.
pub fn classify(group: &str, kind: &str, v: &Value) -> Option<WorkloadStatus> {
    let count = |p: &str| int_at(v, p).unwrap_or(0);
    Some(match (group, kind) {
        ("", "Pod") => pod(v),
        ("apps", "Deployment" | "StatefulSet" | "ReplicaSet") => replicas(
            v,
            count("/status/readyReplicas"),
            int_at(v, "/spec/replicas").unwrap_or(1),
        ),
        ("apps", "DaemonSet") => replicas(
            v,
            count("/status/numberReady"),
            count("/status/desiredNumberScheduled"),
        ),
        ("batch", "Job") => job(v),
        ("batch", "CronJob") => cronjob(v),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use WorkloadStatus::*;

    fn status(group: &str, kind: &str, v: Value) -> WorkloadStatus {
        classify(group, kind, &v).unwrap()
    }

    #[test]
    fn pods_count_waiting_errors_apart_from_running() {
        let crash = json!({ "status": { "phase": "Running", "containerStatuses": [
            { "state": { "waiting": { "reason": "CrashLoopBackOff" } } }
        ]}});
        assert_eq!(status("", "Pod", crash), Error);
        let creating = json!({ "status": { "phase": "Pending", "containerStatuses": [
            { "state": { "waiting": { "reason": "ContainerCreating" } } }
        ]}});
        assert_eq!(status("", "Pod", creating), Pending);
        let init_error = json!({ "status": { "phase": "Pending", "initContainerStatuses": [
            { "state": { "waiting": { "reason": "ImagePullBackOff" } } }
        ]}});
        assert_eq!(status("", "Pod", init_error), Error);
        let evicted = json!({ "status": { "phase": "Failed", "reason": "Evicted" } });
        assert_eq!(status("", "Pod", evicted), Failed);
        assert_eq!(
            status("", "Pod", json!({ "status": { "phase": "Succeeded" } })),
            Succeeded
        );
        assert_eq!(
            status("", "Pod", json!({ "status": { "phase": "Running" } })),
            Running
        );
        assert_eq!(status("", "Pod", json!({})), Unknown);
    }

    #[test]
    fn controllers_compare_ready_with_desired() {
        let d = |ready: i64, replicas: i64| json!({ "spec": { "replicas": replicas }, "status": { "readyReplicas": ready } });
        assert_eq!(status("apps", "Deployment", d(3, 3)), Running);
        assert_eq!(status("apps", "Deployment", d(1, 3)), Pending);
        // Scaled to zero counts as running.
        assert_eq!(status("apps", "StatefulSet", d(0, 0)), Running);
        // No replicas field means one; no readyReplicas means none.
        assert_eq!(status("apps", "ReplicaSet", json!({})), Pending);
        let stuck = json!({ "spec": { "replicas": 2 }, "status": { "readyReplicas": 1, "conditions": [
            { "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded" }
        ]}});
        assert_eq!(status("apps", "Deployment", stuck), Failed);
        let quota = json!({ "spec": { "replicas": 2 }, "status": { "conditions": [
            { "type": "ReplicaFailure", "status": "True", "reason": "FailedCreate" }
        ]}});
        assert_eq!(status("apps", "ReplicaSet", quota), Failed);
        let ds = json!({ "status": { "desiredNumberScheduled": 3, "numberReady": 2 } });
        assert_eq!(status("apps", "DaemonSet", ds), Pending);
    }

    #[test]
    fn jobs_and_cronjobs() {
        let cond =
            |t: &str| json!({ "status": { "conditions": [{ "type": t, "status": "True" }] } });
        assert_eq!(status("batch", "Job", cond("Failed")), Failed);
        assert_eq!(status("batch", "Job", cond("Complete")), Succeeded);
        assert_eq!(
            status("batch", "Job", json!({ "status": { "active": 1 } })),
            Running
        );
        assert_eq!(
            status("batch", "Job", json!({ "spec": { "suspend": true } })),
            Suspended
        );
        assert_eq!(
            status("batch", "CronJob", json!({ "spec": { "suspend": true } })),
            Suspended
        );
        let active = json!({ "status": { "active": [{ "name": "x" }] } });
        assert_eq!(status("batch", "CronJob", active), Running);
        assert_eq!(status("batch", "CronJob", json!({})), Scheduled);
    }

    #[test]
    fn every_status_a_kind_yields_is_one_it_lists() {
        assert!(classify("", "Service", &json!({})).is_none());
        assert!(statuses_of("", "Service").is_empty());
        for (group, kind) in WORKLOAD_KINDS {
            assert!(!statuses_of(group, kind).is_empty(), "{kind}");
            let s = classify(group, kind, &json!({})).unwrap();
            assert!(statuses_of(group, kind).contains(&s), "{kind}");
        }
    }

    /// The row problem (`problems.rs`) and the status agree: what is fine
    /// has no problem, what is Pending or Failed has one.
    #[test]
    fn statuses_agree_with_row_problems() {
        use super::super::test_support::rref;
        use crate::resources::row_problem;
        let r = |group: &str, kind: &str| rref(group, kind, "x", true);
        let cases = [
            (
                "apps",
                "Deployment",
                json!({ "spec": { "replicas": 2 }, "status": { "readyReplicas": 2 } }),
            ),
            (
                "apps",
                "Deployment",
                json!({ "spec": { "replicas": 2 }, "status": { "readyReplicas": 1 } }),
            ),
            ("apps", "StatefulSet", json!({ "spec": { "replicas": 0 } })),
            ("apps", "ReplicaSet", json!({})),
            (
                "apps",
                "DaemonSet",
                json!({ "status": { "desiredNumberScheduled": 3, "numberReady": 2 } }),
            ),
            (
                "apps",
                "Deployment",
                json!({ "spec": { "replicas": 1 }, "status": { "readyReplicas": 1, "conditions": [
                { "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded" }] } }),
            ),
            (
                "batch",
                "Job",
                json!({ "status": { "conditions": [{ "type": "Failed", "status": "True" }] } }),
            ),
            ("batch", "Job", json!({ "status": { "active": 1 } })),
        ];
        for (group, kind, v) in cases {
            let s = classify(group, kind, &v).unwrap();
            let problem = row_problem(&r(group, kind), &v, 0, 0);
            let bad = matches!(s, Pending | Failed);
            assert_eq!(bad, !problem.is_empty(), "{kind} {v}: {s:?} vs {problem:?}");
        }
    }
}
