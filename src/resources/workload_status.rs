//! The Status cell of Deployments, StatefulSets and DaemonSets (#381): one
//! word that says what the controller is doing, so a broken rollout shows
//! without reading the Ready / Up-to-date / Available numbers.
//!
//! The words, worst first (the first that applies wins):
//!
//! - `Terminating`: the object is being deleted;
//! - `Failed`: the rollout is past its deadline (`Progressing` False with
//!   `ProgressDeadlineExceeded`) or a replica could not be created
//!   (`ReplicaFailure` True);
//! - `Paused`: a Deployment with `spec.paused`;
//! - `Updating`: the controller has not seen the latest spec yet
//!   (`observedGeneration < generation`), or pods of an older revision are
//!   still being replaced;
//! - `Scaling`: on the latest revision, but fewer (or more) pods than wanted
//!   are there, ready or available;
//! - `Scaled down`: zero replicas wanted and none left (`No nodes` for a
//!   DaemonSet that no node matches);
//! - `Running`: everything wanted is there and ready.
//!
//! Plain text, computed from the object when its row is made, so it rides in
//! the trimmed watch row (#397) like every other cell, and the CLI, the MCP
//! tools, the filter and a CSV export read the same word.

use serde_json::Value;

fn int(v: &Value, pointer: &str) -> Option<i64> {
    v.pointer(pointer).and_then(Value::as_i64)
}

fn count(v: &Value, pointer: &str) -> i64 {
    int(v, pointer).unwrap_or(0)
}

fn str_at<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

fn condition(v: &Value, type_: &str, status: &str, reason: Option<&str>) -> bool {
    v.pointer("/status/conditions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|c| {
            c["type"].as_str() == Some(type_)
                && c["status"].as_str() == Some(status)
                && reason.is_none_or(|r| c["reason"].as_str() == Some(r))
        })
}

fn terminating(v: &Value) -> bool {
    v.pointer("/metadata/deletionTimestamp")
        .is_some_and(|t| !t.is_null())
}

fn failed(v: &Value) -> bool {
    condition(v, "Progressing", "False", Some("ProgressDeadlineExceeded"))
        || condition(v, "ReplicaFailure", "True", None)
}

/// The controller has not acted on the latest spec yet.
fn spec_not_observed(v: &Value) -> bool {
    match (
        int(v, "/metadata/generation"),
        int(v, "/status/observedGeneration"),
    ) {
        (Some(generation), Some(observed)) => observed < generation,
        // Created a moment ago: no status at all yet.
        (Some(_), None) => v.pointer("/status").is_none_or(Value::is_null),
        _ => false,
    }
}

pub(super) fn deployment_status(v: &Value) -> String {
    if terminating(v) {
        return "Terminating".into();
    }
    if failed(v) {
        return "Failed".into();
    }
    if v.pointer("/spec/paused") == Some(&Value::Bool(true)) {
        return "Paused".into();
    }
    let desired = int(v, "/spec/replicas").unwrap_or(1);
    let replicas = count(v, "/status/replicas");
    let updated = count(v, "/status/updatedReplicas");
    let ready = count(v, "/status/readyReplicas");
    let available = count(v, "/status/availableReplicas");
    // Pods of an older revision are still there: a rollout, not a scale.
    if spec_not_observed(v) || replicas > updated {
        return "Updating".into();
    }
    if desired == 0 && replicas == 0 {
        return "Scaled down".into();
    }
    if replicas != desired || ready < desired || available < desired {
        return "Scaling".into();
    }
    "Running".into()
}

pub(super) fn statefulset_status(v: &Value) -> String {
    if terminating(v) {
        return "Terminating".into();
    }
    if failed(v) {
        return "Failed".into();
    }
    let desired = int(v, "/spec/replicas").unwrap_or(1);
    let replicas = count(v, "/status/replicas");
    let updated = count(v, "/status/updatedReplicas");
    let ready = count(v, "/status/readyReplicas");
    let rolling = str_at(v, "/spec/updateStrategy/type") != "OnDelete";
    let partition = count(v, "/spec/updateStrategy/rollingUpdate/partition").max(0);
    let (current, update) = (
        str_at(v, "/status/currentRevision"),
        str_at(v, "/status/updateRevision"),
    );
    // With a partition only the ordinals at or above it are updated, and the
    // current revision stays the old one on purpose.
    let behind = rolling
        && if partition > 0 {
            updated < (replicas.min(desired) - partition).max(0)
        } else {
            !update.is_empty() && current != update
        };
    if spec_not_observed(v) || behind {
        return "Updating".into();
    }
    if desired == 0 && replicas == 0 {
        return "Scaled down".into();
    }
    if replicas != desired || ready < desired {
        return "Scaling".into();
    }
    "Running".into()
}

pub(super) fn daemonset_status(v: &Value) -> String {
    if terminating(v) {
        return "Terminating".into();
    }
    if failed(v) {
        return "Failed".into();
    }
    let desired = count(v, "/status/desiredNumberScheduled");
    let current = count(v, "/status/currentNumberScheduled");
    let updated = count(v, "/status/updatedNumberScheduled");
    let ready = count(v, "/status/numberReady");
    let available = count(v, "/status/numberAvailable");
    let misscheduled = count(v, "/status/numberMisscheduled");
    let rolling = str_at(v, "/spec/updateStrategy/type") != "OnDelete";
    // Nodes still run a pod of an older revision.
    if spec_not_observed(v) || (rolling && updated < current) {
        return "Updating".into();
    }
    if desired == 0 && current == 0 {
        return "No nodes".into();
    }
    if current != desired || misscheduled > 0 || ready < desired || available < desired {
        return "Scaling".into();
    }
    "Running".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A Deployment at generation 2, observed, with these counts.
    fn deploy(desired: i64, replicas: i64, updated: i64, ready: i64, available: i64) -> Value {
        json!({
            "metadata": { "generation": 2 },
            "spec": { "replicas": desired },
            "status": { "observedGeneration": 2, "replicas": replicas,
                        "updatedReplicas": updated, "readyReplicas": ready,
                        "availableReplicas": available }
        })
    }

    #[test]
    fn deployment_running_scaling_updating_scaled_down() {
        assert_eq!(deployment_status(&deploy(3, 3, 3, 3, 3)), "Running");
        // Scaling up: the new pods are not ready yet.
        assert_eq!(deployment_status(&deploy(3, 3, 3, 1, 1)), "Scaling");
        assert_eq!(deployment_status(&deploy(5, 3, 3, 3, 3)), "Scaling");
        // Ready but not yet available (minReadySeconds).
        assert_eq!(deployment_status(&deploy(2, 2, 2, 2, 1)), "Scaling");
        // Scaling down: more pods than wanted, all of the latest revision.
        assert_eq!(deployment_status(&deploy(1, 3, 3, 3, 3)), "Scaling");
        // A rollout: old pods still there, or not all pods updated.
        assert_eq!(deployment_status(&deploy(3, 4, 1, 3, 3)), "Updating");
        assert_eq!(deployment_status(&deploy(3, 3, 2, 3, 3)), "Updating");
        // Old pods all gone, the new ones still coming: scaling.
        assert_eq!(deployment_status(&deploy(3, 2, 2, 2, 2)), "Scaling");
        assert_eq!(deployment_status(&deploy(0, 0, 0, 0, 0)), "Scaled down");
        assert_eq!(deployment_status(&deploy(0, 2, 2, 2, 2)), "Scaling");
    }

    #[test]
    fn deployment_spec_not_seen_yet_is_updating() {
        let mut d = deploy(3, 3, 3, 3, 3);
        d["metadata"]["generation"] = json!(3);
        assert_eq!(deployment_status(&d), "Updating");
        // Just created: no status yet.
        let new = json!({ "metadata": { "generation": 1 }, "spec": { "replicas": 1 } });
        assert_eq!(deployment_status(&new), "Updating");
        // No replicas field means one.
        let one = json!({ "metadata": { "generation": 1 }, "spec": {},
            "status": { "observedGeneration": 1, "replicas": 1, "updatedReplicas": 1,
                        "readyReplicas": 1, "availableReplicas": 1 } });
        assert_eq!(deployment_status(&one), "Running");
    }

    #[test]
    fn deployment_failed_paused_terminating() {
        let mut stuck = deploy(1, 1, 1, 0, 0);
        stuck["status"]["conditions"] = json!([
            { "type": "Available", "status": "False" },
            { "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded" }
        ]);
        assert_eq!(deployment_status(&stuck), "Failed");
        let mut quota = deploy(2, 0, 0, 0, 0);
        quota["status"]["conditions"] =
            json!([{ "type": "ReplicaFailure", "status": "True", "reason": "FailedCreate" }]);
        assert_eq!(deployment_status(&quota), "Failed");
        // Progressing False for another reason is not a failure.
        let mut other = deploy(1, 1, 1, 1, 1);
        other["status"]["conditions"] =
            json!([{ "type": "Progressing", "status": "Unknown", "reason": "DeploymentPaused" }]);
        assert_eq!(deployment_status(&other), "Running");
        let mut paused = deploy(3, 3, 1, 3, 3);
        paused["spec"]["paused"] = json!(true);
        assert_eq!(deployment_status(&paused), "Paused");
        // A deadline exceeded while paused is still a failure.
        stuck["spec"]["paused"] = json!(true);
        assert_eq!(deployment_status(&stuck), "Failed");
        let mut gone = deploy(3, 3, 3, 3, 3);
        gone["metadata"]["deletionTimestamp"] = json!("2026-11-20T10:00:00Z");
        assert_eq!(deployment_status(&gone), "Terminating");
    }

    fn sts(desired: i64, replicas: i64, updated: i64, ready: i64, cur: &str, upd: &str) -> Value {
        json!({
            "metadata": { "generation": 1 },
            "spec": { "replicas": desired },
            "status": { "observedGeneration": 1, "replicas": replicas,
                        "updatedReplicas": updated, "readyReplicas": ready,
                        "currentRevision": cur, "updateRevision": upd }
        })
    }

    #[test]
    fn statefulset_states() {
        assert_eq!(statefulset_status(&sts(3, 3, 3, 3, "a", "a")), "Running");
        assert_eq!(statefulset_status(&sts(3, 2, 2, 2, "a", "a")), "Scaling");
        assert_eq!(statefulset_status(&sts(3, 3, 3, 2, "a", "a")), "Scaling");
        assert_eq!(statefulset_status(&sts(3, 3, 1, 3, "a", "b")), "Updating");
        assert_eq!(
            statefulset_status(&sts(0, 0, 0, 0, "a", "a")),
            "Scaled down"
        );
        // A partition: the ordinals below it keep the old revision on purpose.
        let mut part = sts(3, 3, 1, 3, "a", "b");
        part["spec"]["updateStrategy"] =
            json!({ "type": "RollingUpdate", "rollingUpdate": { "partition": 2 } });
        assert_eq!(statefulset_status(&part), "Running");
        part["status"]["updatedReplicas"] = json!(0);
        assert_eq!(statefulset_status(&part), "Updating");
        // OnDelete: the revisions differ until someone deletes the pods.
        let mut on_delete = sts(3, 3, 0, 3, "a", "b");
        on_delete["spec"]["updateStrategy"] = json!({ "type": "OnDelete" });
        assert_eq!(statefulset_status(&on_delete), "Running");
        let mut gone = sts(3, 3, 3, 3, "a", "a");
        gone["metadata"]["deletionTimestamp"] = json!("2026-11-20T10:00:00Z");
        assert_eq!(statefulset_status(&gone), "Terminating");
        let mut seen = sts(3, 3, 3, 3, "a", "a");
        seen["metadata"]["generation"] = json!(2);
        assert_eq!(statefulset_status(&seen), "Updating");
    }

    fn ds(desired: i64, current: i64, updated: i64, ready: i64, available: i64) -> Value {
        json!({
            "metadata": { "generation": 1 },
            "status": { "observedGeneration": 1, "desiredNumberScheduled": desired,
                        "currentNumberScheduled": current, "updatedNumberScheduled": updated,
                        "numberReady": ready, "numberAvailable": available,
                        "numberMisscheduled": 0 }
        })
    }

    #[test]
    fn daemonset_states() {
        assert_eq!(daemonset_status(&ds(3, 3, 3, 3, 3)), "Running");
        assert_eq!(daemonset_status(&ds(3, 3, 3, 2, 2)), "Scaling");
        // A new node: its pod is not there yet.
        assert_eq!(daemonset_status(&ds(3, 2, 2, 2, 2)), "Scaling");
        assert_eq!(daemonset_status(&ds(3, 3, 1, 3, 3)), "Updating");
        assert_eq!(daemonset_status(&ds(0, 0, 0, 0, 0)), "No nodes");
        let mut mis = ds(3, 3, 3, 3, 3);
        mis["status"]["numberMisscheduled"] = json!(1);
        assert_eq!(daemonset_status(&mis), "Scaling");
        let mut on_delete = ds(3, 3, 1, 3, 3);
        on_delete["spec"] = json!({ "updateStrategy": { "type": "OnDelete" } });
        assert_eq!(daemonset_status(&on_delete), "Running");
        let mut gone = ds(3, 3, 3, 3, 3);
        gone["metadata"]["deletionTimestamp"] = json!("2026-11-20T10:00:00Z");
        assert_eq!(daemonset_status(&gone), "Terminating");
    }
}
