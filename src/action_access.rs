//! Which of an object's actions the current user may run (#218).
//!
//! The detail panel greys out the actions RBAC would refuse, with a tooltip
//! that says what is missing. Each action maps to the API requests it makes
//! ([`permissions_for`], pure, so it is unit tested); [`check_actions`] asks
//! the API server about each one with a SelfSubjectAccessReview. A check that
//! cannot be made counts as allowed: the API server still has the last word
//! when the action runs.
//!
//! Actions are named by their [`ActionId`](crate::actions::ActionId) in
//! camelCase (`"scale"`, `"nodeShell"`), plus the panel's own entries:
//! `"logs"`, `"shell"` (a pod's terminal) and `"edit"` (the YAML editor).

use crate::node_shell::NODE_SHELL_NAMESPACE;
use crate::resources::{can_i, ResourceRef};
use futures::StreamExt;
use kube::Client;
use serde::Serialize;

/// One API request an action makes.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Permission {
    pub verb: &'static str,
    /// API group; empty for the core group.
    pub group: String,
    /// The plural resource name, e.g. `pods`.
    pub resource: String,
    /// Empty for none, e.g. `exec`.
    pub subresource: &'static str,
    /// `None`: across all namespaces, or a cluster-scoped resource.
    pub namespace: Option<String>,
}

impl Permission {
    /// "create pods/exec in namespace demo", for the tooltip.
    pub fn describe(&self) -> String {
        let mut what = self.resource.clone();
        if !self.subresource.is_empty() {
            what = format!("{what}/{}", self.subresource);
        }
        if !self.group.is_empty() {
            what = format!("{what}.{}", self.group);
        }
        match &self.namespace {
            Some(ns) => format!("{} {what} in namespace {ns}", self.verb),
            None => format!("{} {what}", self.verb),
        }
    }
}

/// Whether one action is allowed. `reason` is empty when it is, otherwise a
/// sentence naming the first request RBAC refuses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ActionAccess {
    pub id: String,
    pub allowed: bool,
    pub reason: String,
}

const WORKLOADS: &[&str] = &[
    "Deployment",
    "StatefulSet",
    "DaemonSet",
    "ReplicaSet",
    "Job",
];

fn perm(
    verb: &'static str,
    group: &str,
    resource: &str,
    subresource: &'static str,
    ns: Option<&str>,
) -> Permission {
    Permission {
        verb,
        group: group.to_string(),
        resource: resource.to_string(),
        subresource,
        namespace: ns.map(str::to_string),
    }
}

/// The requests action `id` makes on the object `r` in `namespace` (empty
/// for cluster-scoped kinds). Unknown ids need nothing (and so are allowed).
pub fn permissions_for(r: &ResourceRef, namespace: &str, id: &str) -> Vec<Permission> {
    let ns = (r.namespaced && !namespace.is_empty()).then_some(namespace);
    let own = |verb, sub| perm(verb, &r.group, &r.plural, sub, ns);
    let pods = |verb, sub| perm(verb, "", "pods", sub, ns);
    let is_pod = r.group.is_empty() && r.kind == "Pod";
    match id {
        "logs" if is_pod => vec![pods("get", "log")],
        // Merged workload logs list the pods, then follow each one's log.
        "logs" if WORKLOADS.contains(&r.kind.as_str()) => {
            vec![pods("list", ""), pods("get", "log")]
        }
        "shell" => vec![pods("create", "exec")],
        "attach" => vec![pods("create", "attach")],
        "debug" => vec![pods("patch", "ephemeralcontainers")],
        "portForward" => vec![pods("create", "portforward")],
        "edit" | "restart" | "cordon" | "uncordon" | "suspend" | "resume" => vec![own("patch", "")],
        "scale" => vec![own("patch", "scale")],
        "delete" | "forceDelete" => vec![own("delete", "")],
        "trigger" => vec![perm("create", "batch", "jobs", "", ns)],
        "drain" => vec![
            perm("patch", "", "nodes", "", None),
            perm("create", "", "pods", "eviction", None),
        ],
        "nodeShell" => {
            let ns = Some(NODE_SHELL_NAMESPACE);
            vec![
                perm("create", "", "pods", "", ns),
                perm("create", "", "pods", "exec", ns),
            ]
        }
        _ => Vec::new(),
    }
}

/// The plain-words reason for a refused request.
pub fn denied_reason(p: &Permission) -> String {
    format!("Not allowed: you can't {}", p.describe())
}

/// Check every action of `ids` on the object `r` in `namespace`. Each
/// distinct request is asked once.
pub async fn check_actions(
    client: &Client,
    r: &ResourceRef,
    namespace: &str,
    ids: &[String],
) -> Vec<ActionAccess> {
    let needed: Vec<(String, Vec<Permission>)> = ids
        .iter()
        .map(|id| (id.clone(), permissions_for(r, namespace, id)))
        .collect();
    let mut distinct: Vec<Permission> = Vec::new();
    for p in needed.iter().flat_map(|(_, ps)| ps) {
        if !distinct.contains(p) {
            distinct.push(p.clone());
        }
    }
    let answers: Vec<(Permission, bool)> = futures::stream::iter(distinct)
        .map(|p| async move {
            let ok = can_i(
                client,
                p.verb,
                &p.group,
                &p.resource,
                p.subresource,
                p.namespace.as_deref(),
            )
            .await;
            (p, ok)
        })
        .buffer_unordered(8)
        .collect()
        .await;
    needed
        .into_iter()
        .map(|(id, ps)| {
            let denied = ps
                .iter()
                .find(|p| answers.iter().any(|(q, ok)| q == *p && !ok));
            ActionAccess {
                id,
                allowed: denied.is_none(),
                reason: denied.map(denied_reason).unwrap_or_default(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(group: &str, kind: &str, plural: &str, namespaced: bool) -> ResourceRef {
        ResourceRef {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced,
        }
    }

    fn described(r: &ResourceRef, ns: &str, id: &str) -> Vec<String> {
        permissions_for(r, ns, id)
            .iter()
            .map(Permission::describe)
            .collect()
    }

    #[test]
    fn pod_actions_name_their_subresources() {
        let pod = r("", "Pod", "pods", true);
        assert_eq!(
            described(&pod, "demo", "logs"),
            ["get pods/log in namespace demo"]
        );
        assert_eq!(
            described(&pod, "demo", "shell"),
            ["create pods/exec in namespace demo"]
        );
        assert_eq!(
            described(&pod, "demo", "attach"),
            ["create pods/attach in namespace demo"]
        );
        assert_eq!(
            described(&pod, "demo", "debug"),
            ["patch pods/ephemeralcontainers in namespace demo"]
        );
        assert_eq!(
            described(&pod, "demo", "edit"),
            ["patch pods in namespace demo"]
        );
        assert_eq!(
            described(&pod, "demo", "forceDelete"),
            ["delete pods in namespace demo"]
        );
    }

    #[test]
    fn workload_actions_use_its_group() {
        let dep = r("apps", "Deployment", "deployments", true);
        assert_eq!(
            described(&dep, "team-a", "scale"),
            ["patch deployments/scale.apps in namespace team-a"]
        );
        assert_eq!(
            described(&dep, "team-a", "restart"),
            ["patch deployments.apps in namespace team-a"]
        );
        assert_eq!(
            described(&dep, "team-a", "logs"),
            [
                "list pods in namespace team-a",
                "get pods/log in namespace team-a"
            ]
        );
        let cj = r("batch", "CronJob", "cronjobs", true);
        assert_eq!(
            described(&cj, "x", "trigger"),
            ["create jobs.batch in namespace x"]
        );
    }

    #[test]
    fn node_actions_are_cluster_wide_except_the_shell_pod() {
        let node = r("", "Node", "nodes", false);
        assert_eq!(described(&node, "", "cordon"), ["patch nodes"]);
        assert_eq!(
            described(&node, "", "drain"),
            ["patch nodes", "create pods/eviction"]
        );
        assert_eq!(
            described(&node, "", "nodeShell"),
            [
                "create pods in namespace kube-system",
                "create pods/exec in namespace kube-system"
            ]
        );
    }

    #[test]
    fn unknown_ids_need_nothing() {
        let svc = r("", "Service", "services", true);
        assert!(permissions_for(&svc, "demo", "logs").is_empty());
        assert!(permissions_for(&svc, "demo", "nope").is_empty());
    }

    #[test]
    fn the_reason_names_the_request() {
        let p = perm("create", "", "pods", "exec", Some("demo"));
        assert_eq!(
            denied_reason(&p),
            "Not allowed: you can't create pods/exec in namespace demo"
        );
    }
}
