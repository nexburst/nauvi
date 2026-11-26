//! Which table rows are problems: a crash-looping or failed pod, a workload
//! with fewer ready replicas than it wants, a failed Job, a node that is not
//! ready, a lost volume claim.
//!
//! Computed from the object each time its row is built, so the tables and
//! the sidebar badges need no extra requests: they count the rows of the
//! watches that already run. Pods are classified like the overview's problem
//! pods ([`crate::overview::pod_problem`]); a test keeps the two in step.

use super::jsonpath::array_at;
use super::pod_printer::printed_pod_status;
use super::ResourceRef;
use crate::overview::PENDING_TOO_LONG_SECS;
use serde_json::Value;

use super::status::STARTING;

/// Why the object is a problem, in a few words; empty if it is fine or its
/// kind has no notion of a problem. `created` and `now` are unix seconds
/// (they decide whether a pending pod is overdue).
pub fn row_problem(r: &ResourceRef, v: &Value, created: i64, now: i64) -> String {
    match (r.group.as_str(), r.kind.as_str()) {
        ("", "Pod") => pod_problem(v, created, now),
        ("apps", "Deployment" | "StatefulSet" | "ReplicaSet") => replicas_problem(v),
        ("apps", "DaemonSet") => daemonset_problem(v),
        ("batch", "Job") => job_problem(v),
        ("", "Node") => node_problem(v),
        ("", "PersistentVolumeClaim") => match str_at(v, "/status/phase") {
            "Lost" => "Lost".to_string(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

fn str_at<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

fn int_at(v: &Value, pointer: &str) -> Option<i64> {
    v.pointer(pointer).and_then(Value::as_i64)
}

/// The condition `type_`'s status (`True`, `False`, `Unknown`), and its reason.
fn condition<'a>(v: &'a Value, type_: &str) -> Option<(&'a str, &'a str)> {
    array_at(v, "/status/conditions")
        .find(|c| c.get("type").and_then(Value::as_str) == Some(type_))
        .map(|c| (str_at(c, "/status"), str_at(c, "/reason")))
}

/// A waiting error (CrashLoopBackOff, ImagePullBackOff, ...), a failed pod,
/// running but not ready, or pending for more than five minutes.
fn pod_problem(v: &Value, created: i64, now: i64) -> String {
    if v.pointer("/metadata/deletionTimestamp").is_some() {
        return String::new();
    }
    let phase = str_at(v, "/status/phase");
    match phase {
        "Succeeded" => return String::new(),
        "Failed" => {
            let reason = str_at(v, "/status/reason");
            return if reason.is_empty() { "Failed" } else { reason }.to_string();
        }
        _ => {}
    }
    let waiting = array_at(v, "/status/initContainerStatuses")
        .chain(array_at(v, "/status/containerStatuses"))
        .filter_map(|c| c.pointer("/state/waiting/reason").and_then(Value::as_str))
        .find(|r| !STARTING.contains(r));
    if let Some(reason) = waiting {
        return reason.to_string();
    }
    let ready = condition(v, "Ready").is_some_and(|(s, _)| s == "True");
    match phase {
        "Running" if !ready => not_ready_reason(&printed_pod_status(v)),
        "Pending" if created > 0 && now - created > PENDING_TOO_LONG_SECS => {
            format!("Pending for {}", crate::human::duration(now - created))
        }
        _ => String::new(),
    }
}

/// Why a running pod that is not ready is a problem: its STATUS as the Pods
/// table prints it when that says more than "Running" (Error,
/// CrashLoopBackOff, NotReady, ...), else "Not ready". The overview uses the
/// same text, so a pod reads the same in both.
pub fn not_ready_reason(status: &str) -> String {
    match status {
        "" | "Running" => "Not ready".to_string(),
        s => s.to_string(),
    }
}

/// Deployments, StatefulSets and ReplicaSets: a stalled rollout, or fewer
/// ready replicas than wanted.
fn replicas_problem(v: &Value) -> String {
    if let Some(("False", "ProgressDeadlineExceeded")) = condition(v, "Progressing") {
        return "Rollout stalled (ProgressDeadlineExceeded)".to_string();
    }
    if let Some(("True", reason)) = condition(v, "ReplicaFailure") {
        return format!("Replica failure ({reason})");
    }
    let desired = int_at(v, "/spec/replicas").unwrap_or(1);
    let ready = int_at(v, "/status/readyReplicas").unwrap_or(0);
    if desired > 0 && ready < desired {
        format!("{ready} of {desired} ready")
    } else {
        String::new()
    }
}

fn daemonset_problem(v: &Value) -> String {
    let desired = int_at(v, "/status/desiredNumberScheduled").unwrap_or(0);
    let ready = int_at(v, "/status/numberReady").unwrap_or(0);
    if desired > 0 && ready < desired {
        format!("{ready} of {desired} ready")
    } else {
        String::new()
    }
}

fn job_problem(v: &Value) -> String {
    match condition(v, "Failed") {
        Some(("True", "")) => "Failed".to_string(),
        Some(("True", reason)) => format!("Failed ({reason})"),
        _ => String::new(),
    }
}

fn node_problem(v: &Value) -> String {
    match condition(v, "Ready") {
        Some(("True", _)) => String::new(),
        Some(("Unknown", _)) => "Not ready (unknown)".to_string(),
        _ => "Not ready".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::rref;
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000;

    fn pod(phase: &str, extra: Value) -> Value {
        let mut v = json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "p", "namespace": "n" },
            "spec": { "containers": [{ "name": "app", "image": "x" }] },
            "status": { "phase": phase }
        });
        merge(&mut v, extra);
        v
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

    fn ready(status: &str) -> Value {
        json!({ "status": { "conditions": [{ "type": "Ready", "status": status }] } })
    }

    fn waiting(reason: &str) -> Value {
        json!({ "status": { "containerStatuses": [{
            "name": "app", "image": "x", "imageID": "", "ready": false, "restartCount": 4,
            "state": { "waiting": { "reason": reason } }
        }] } })
    }

    /// Running, not ready, its container exited with `reason`.
    fn exited(reason: &str) -> Value {
        json!({ "status": {
            "conditions": [{ "type": "Ready", "status": "False" }],
            "containerStatuses": [{
                "name": "app", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "terminated": { "exitCode": 1, "reason": reason } }
            }]
        } })
    }

    fn pod_row(v: &Value, created: i64) -> String {
        row_problem(&rref("", "Pod", "pods", true), v, created, NOW)
    }

    #[test]
    fn pods() {
        let old = NOW - 600;
        assert_eq!(pod_row(&pod("Running", ready("True")), old), "");
        assert_eq!(pod_row(&pod("Running", ready("False")), old), "Not ready");
        // Not ready with a STATUS that says why: that STATUS (#263).
        assert_eq!(pod_row(&pod("Running", exited("Error")), old), "Error");
        assert_eq!(
            pod_row(&pod("Running", waiting("CrashLoopBackOff")), old),
            "CrashLoopBackOff"
        );
        // Starting up is not an error, nor is a fresh pending pod.
        assert_eq!(
            pod_row(&pod("Pending", waiting("ContainerCreating")), NOW - 10),
            ""
        );
        assert_eq!(
            pod_row(&pod("Pending", waiting("ContainerCreating")), old),
            "Pending for 10m"
        );
        assert_eq!(pod_row(&pod("Succeeded", json!({})), old), "");
        assert_eq!(pod_row(&pod("Failed", json!({})), old), "Failed");
        assert_eq!(
            pod_row(
                &pod("Failed", json!({ "status": { "reason": "Evicted" } })),
                old
            ),
            "Evicted"
        );
        let terminating = pod(
            "Running",
            json!({ "metadata": { "deletionTimestamp": "2020-01-01T00:00:00Z" } }),
        );
        assert_eq!(pod_row(&terminating, old), "");
    }

    /// The overview counts the same pods as problems as the Pods table marks.
    #[test]
    fn pods_agree_with_the_overview() {
        let created = NOW - 600;
        let ts = jiff::Timestamp::from_second(created).unwrap().to_string();
        let cases = [
            pod("Running", ready("True")),
            pod("Running", ready("False")),
            pod("Running", waiting("CrashLoopBackOff")),
            pod("Running", exited("Error")),
            pod("Pending", waiting("ImagePullBackOff")),
            pod("Pending", waiting("ContainerCreating")),
            pod("Pending", json!({})),
            pod("Succeeded", json!({})),
            pod("Failed", json!({ "status": { "reason": "Evicted" } })),
        ];
        for mut v in cases {
            merge(&mut v, json!({ "metadata": { "creationTimestamp": ts } }));
            let typed: Pod = serde_json::from_value(v.clone()).unwrap();
            let overview = crate::overview::pod_problem(&typed, NOW).unwrap_or_default();
            assert_eq!(pod_row(&v, created), overview, "{v}");
        }
    }

    #[test]
    fn workloads() {
        let deploy = rref("apps", "Deployment", "deployments", true);
        let p = |v: Value| row_problem(&deploy, &v, 0, NOW);
        assert_eq!(
            p(json!({ "spec": { "replicas": 3 }, "status": { "readyReplicas": 3 } })),
            ""
        );
        assert_eq!(
            p(json!({ "spec": { "replicas": 3 }, "status": { "readyReplicas": 1 } })),
            "1 of 3 ready"
        );
        // Scaled to zero is not a problem; replicas defaults to 1.
        assert_eq!(p(json!({ "spec": { "replicas": 0 }, "status": {} })), "");
        assert_eq!(p(json!({ "spec": {}, "status": {} })), "0 of 1 ready");
        assert_eq!(
            p(
                json!({ "spec": { "replicas": 1 }, "status": { "readyReplicas": 1, "conditions": [
                { "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded" }
            ] } })
            ),
            "Rollout stalled (ProgressDeadlineExceeded)"
        );
        let ds = rref("apps", "DaemonSet", "daemonsets", true);
        assert_eq!(
            row_problem(
                &ds,
                &json!({ "status": { "desiredNumberScheduled": 2, "numberReady": 1 } }),
                0,
                NOW
            ),
            "1 of 2 ready"
        );
        let job = rref("batch", "Job", "jobs", true);
        let failed = json!({ "status": { "conditions": [
            { "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded" }
        ] } });
        assert_eq!(
            row_problem(&job, &failed, 0, NOW),
            "Failed (BackoffLimitExceeded)"
        );
        assert_eq!(row_problem(&job, &json!({ "status": {} }), 0, NOW), "");
    }

    #[test]
    fn nodes_claims_and_other_kinds() {
        let node = rref("", "Node", "nodes", false);
        assert_eq!(row_problem(&node, &ready("True"), 0, NOW), "");
        assert_eq!(row_problem(&node, &ready("False"), 0, NOW), "Not ready");
        assert_eq!(
            row_problem(&node, &ready("Unknown"), 0, NOW),
            "Not ready (unknown)"
        );
        let pvc = rref("", "PersistentVolumeClaim", "persistentvolumeclaims", true);
        let phase = |p: &str| json!({ "status": { "phase": p } });
        assert_eq!(row_problem(&pvc, &phase("Lost"), 0, NOW), "Lost");
        // WaitForFirstConsumer claims stay Pending until a pod uses them.
        assert_eq!(row_problem(&pvc, &phase("Pending"), 0, NOW), "");
        let cm = rref("", "ConfigMap", "configmaps", true);
        assert_eq!(row_problem(&cm, &phase("Failed"), 0, NOW), "");
    }
}
