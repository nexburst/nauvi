//! The workload a pod belongs to, from its owner references: shared by the
//! image listing (`image_security::images`) and the Overview's Problem
//! groups (#605), so both name the same workload.

use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;

/// The controller owner of a pod, else its first owner.
pub fn pod_owner(pod: &Pod) -> Option<&OwnerReference> {
    let refs = pod.metadata.owner_references.iter().flatten();
    refs.clone()
        .find(|o| o.controller == Some(true))
        .or_else(|| refs.clone().next())
}

/// The workload `(kind, name)` a pod belongs to: its owner, except that a
/// ReplicaSet named after the pod's `pod-template-hash` is its Deployment's,
/// so the Deployment is named. `None` for a pod without an owner.
pub fn pod_workload(pod: &Pod) -> Option<(String, String)> {
    let o = pod_owner(pod)?;
    if o.kind == "ReplicaSet" {
        let hash = pod
            .metadata
            .labels
            .as_ref()
            .and_then(|l| l.get("pod-template-hash"));
        if let Some(deploy) = hash.and_then(|h| o.name.strip_suffix(&format!("-{h}"))) {
            if !deploy.is_empty() {
                return Some(("Deployment".into(), deploy.to_string()));
            }
        }
    }
    Some((o.kind.clone(), o.name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(v: serde_json::Value) -> Pod {
        serde_json::from_value(v).unwrap()
    }

    fn owner(kind: &str, name: &str, controller: bool) -> serde_json::Value {
        json!({ "apiVersion": "apps/v1", "kind": kind, "name": name, "uid": "u", "controller": controller })
    }

    #[test]
    fn a_replicasets_pod_belongs_to_its_deployment() {
        let p = pod(json!({ "metadata": {
            "name": "web-5d8f-abc",
            "labels": { "pod-template-hash": "5d8f" },
            "ownerReferences": [owner("ReplicaSet", "web-5d8f", true)]
        }}));
        assert_eq!(pod_workload(&p), Some(("Deployment".into(), "web".into())));
    }

    #[test]
    fn a_bare_replicaset_stays_a_replicaset() {
        // No template hash, or a name that does not end in it.
        let p = pod(json!({ "metadata": {
            "name": "web-x",
            "ownerReferences": [owner("ReplicaSet", "web", true)]
        }}));
        assert_eq!(pod_workload(&p), Some(("ReplicaSet".into(), "web".into())));
        let p = pod(json!({ "metadata": {
            "name": "web-x",
            "labels": { "pod-template-hash": "5d8f" },
            "ownerReferences": [owner("ReplicaSet", "web", true)]
        }}));
        assert_eq!(pod_workload(&p), Some(("ReplicaSet".into(), "web".into())));
    }

    #[test]
    fn the_controller_wins_over_other_owners() {
        let p = pod(json!({ "metadata": {
            "name": "db-0",
            "ownerReferences": [owner("ConfigMap", "x", false), owner("StatefulSet", "db", true)]
        }}));
        assert_eq!(pod_workload(&p), Some(("StatefulSet".into(), "db".into())));
        let p = pod(json!({ "metadata": { "name": "crashed" } }));
        assert_eq!(pod_workload(&p), None);
    }
}
