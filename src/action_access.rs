//! Which of an object's actions the current user may run (#218).
//!
//! The detail panel greys out the actions RBAC would refuse, with a tooltip
//! that says what is missing. Each action maps to the API requests it makes
//! ([`permissions_for`], pure, so it is unit tested); [`check_actions`] asks
//! the API server about each one with a SelfSubjectAccessReview. A check that
//! cannot be made counts as allowed: the API server still has the last word
//! when the action runs.
//!
//! Answers are kept in an [`AccessCache`] per cluster session, keyed by the
//! request (verb, kind, subresource, namespace), for [`CACHE_TTL`]; the
//! desktop app clears it on a context switch. Checks that could not be made
//! are not kept. Each clear starts a new generation, and an answer asked
//! before it (a check still in flight across the switch) is dropped instead
//! of being kept in the new one (#349).
//!
//! Actions are named by their [`ActionId`](crate::actions::ActionId) in
//! camelCase (`"scale"`, `"nodeShell"`), plus the panel's own entries:
//! `"logs"`, `"shell"` (a pod's terminal) and `"edit"` (the YAML editor).

use crate::node_shell::NODE_SHELL_NAMESPACE;
use crate::resources::{can_i_answer, ResourceRef};
use futures::StreamExt;
use kube::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an answer is reused. Short, so a RoleBinding added or removed
/// meanwhile shows within a minute (on reopening the panel or the menu).
pub const CACHE_TTL: Duration = Duration::from_secs(60);

/// Answers of earlier SelfSubjectAccessReviews, by request.
#[derive(Debug, Default)]
pub struct AccessCache {
    inner: Mutex<Answers>,
}

#[derive(Debug, Default)]
struct Answers {
    by_request: HashMap<Permission, (bool, Instant)>,
    /// Bumped by every [`AccessCache::clear`].
    generation: u64,
}

impl AccessCache {
    /// Forget every answer (a context switch, a disconnect), and drop the
    /// answers of checks still in flight.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.by_request.clear();
        inner.generation += 1;
    }

    /// The current generation: pass it to [`Self::put_in`] with an answer
    /// asked now.
    pub fn generation(&self) -> u64 {
        self.inner.lock().unwrap().generation
    }

    fn get_at(&self, p: &Permission, now: Instant) -> Option<bool> {
        let inner = self.inner.lock().unwrap();
        let (ok, at) = inner.by_request.get(p)?;
        (now.saturating_duration_since(*at) < CACHE_TTL).then_some(*ok)
    }

    fn put_at(&self, generation: u64, p: Permission, ok: bool, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return false;
        }
        inner
            .by_request
            .retain(|_, (_, at)| now.saturating_duration_since(*at) < CACHE_TTL);
        inner.by_request.insert(p, (ok, now));
        true
    }

    /// Keep the answer to `p`, as of now, if the cache was not cleared
    /// since `generation` (when it was asked). Whether it was kept.
    pub fn put_in(&self, generation: u64, p: Permission, ok: bool) -> bool {
        self.put_at(generation, p, ok, Instant::now())
    }

    /// Keep the answer to `p`, as of now.
    pub fn put(&self, p: Permission, ok: bool) {
        self.put_in(self.generation(), p, ok);
    }

    /// How many answers are kept.
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().by_request.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

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
        "evict" => vec![pods("create", "eviction")],
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
/// distinct request is asked once, and not at all while `cache` holds a
/// fresh answer for it.
pub async fn check_actions(
    client: &Client,
    cache: &AccessCache,
    r: &ResourceRef,
    namespace: &str,
    ids: &[String],
) -> Vec<ActionAccess> {
    let needed: Vec<(String, Vec<Permission>)> = ids
        .iter()
        .map(|id| (id.clone(), permissions_for(r, namespace, id)))
        .collect();
    let now = Instant::now();
    // Taken before asking: a clear meanwhile drops these answers.
    let generation = cache.generation();
    let mut answers: Vec<(Permission, bool)> = Vec::new();
    let mut ask: Vec<Permission> = Vec::new();
    for p in needed.iter().flat_map(|(_, ps)| ps) {
        if answers.iter().any(|(q, _)| q == p) || ask.contains(p) {
            continue;
        }
        match cache.get_at(p, now) {
            Some(ok) => answers.push((p.clone(), ok)),
            None => ask.push(p.clone()),
        }
    }
    let asked: Vec<(Permission, Option<bool>)> = futures::stream::iter(ask)
        .map(|p| async move {
            let ok = can_i_answer(
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
    for (p, ok) in asked {
        // A check that cannot be made counts as allowed, but is not kept.
        if let Some(ok) = ok {
            cache.put_in(generation, p.clone(), ok);
        }
        answers.push((p, ok.unwrap_or(true)));
    }
    decide(needed, &answers)
}

/// Each action's verdict from the answers to its requests.
fn decide(
    needed: Vec<(String, Vec<Permission>)>,
    answers: &[(Permission, bool)],
) -> Vec<ActionAccess> {
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
            described(&pod, "demo", "evict"),
            ["create pods/eviction in namespace demo"]
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

    #[test]
    fn the_cache_keeps_answers_per_verb_kind_and_namespace() {
        let cache = AccessCache::default();
        let p = perm("delete", "apps", "deployments", "", Some("team-a"));
        let t0 = Instant::now();
        assert_eq!(cache.get_at(&p, t0), None);
        cache.put_at(0, p.clone(), false, t0);
        assert_eq!(cache.get_at(&p, t0 + Duration::from_secs(5)), Some(false));
        // Another namespace, verb or kind is another request.
        for q in [
            perm("delete", "apps", "deployments", "", Some("demo")),
            perm("patch", "apps", "deployments", "", Some("team-a")),
            perm("delete", "apps", "statefulsets", "", Some("team-a")),
            perm("delete", "apps", "deployments", "", None),
        ] {
            assert_eq!(cache.get_at(&q, t0), None, "{}", q.describe());
        }
        assert_eq!(
            cache.get_at(&p, t0 + CACHE_TTL),
            None,
            "stale after the TTL"
        );
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn stale_answers_are_dropped_on_insert() {
        let cache = AccessCache::default();
        let t0 = Instant::now();
        cache.put_at(0, perm("get", "", "pods", "log", Some("a")), true, t0);
        cache.put_at(
            0,
            perm("get", "", "pods", "log", Some("b")),
            true,
            t0 + CACHE_TTL,
        );
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn answers_asked_before_a_clear_are_dropped() {
        let cache = AccessCache::default();
        let p = perm("delete", "apps", "deployments", "", Some("team-a"));
        // A check starts in the old context...
        let asked_in = cache.generation();
        // ...the context switches before it answers...
        cache.clear();
        // ...and its answer is not kept for the new one.
        assert!(!cache.put_in(asked_in, p.clone(), false));
        assert!(cache.is_empty());
        assert_eq!(cache.get_at(&p, Instant::now()), None);
        // A check asked after the switch is kept.
        assert!(cache.put_in(cache.generation(), p.clone(), true));
        assert_eq!(cache.get_at(&p, Instant::now()), Some(true));
    }

    #[test]
    fn an_action_is_denied_by_its_first_refused_request() {
        let node = r("", "Node", "nodes", false);
        let needed = vec![
            ("drain".to_string(), permissions_for(&node, "", "drain")),
            ("cordon".to_string(), permissions_for(&node, "", "cordon")),
        ];
        let answers = vec![
            (perm("patch", "", "nodes", "", None), true),
            (perm("create", "", "pods", "eviction", None), false),
        ];
        let out = decide(needed, &answers);
        assert!(!out[0].allowed);
        assert_eq!(out[0].reason, "Not allowed: you can't create pods/eviction");
        assert!(out[1].allowed);
        assert_eq!(out[1].reason, "");
    }
}
