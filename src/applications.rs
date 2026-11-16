//! Applications (#226): workloads grouped by the recommended labels
//! (`app.kubernetes.io/instance`, `name`, `version`, `managed-by`) and by
//! Helm release, with a status rolled up from their workloads.
//!
//! Pure functions of the objects as JSON, so the CLI can group a list as
//! well as the live view (`watch_applications`) its watches.
//!
//! What makes an application, first match wins:
//! 1. a Helm release: the `meta.helm.sh/release-name` (and
//!    `-namespace`) annotations Helm 3 puts on everything it installs, or
//!    `managed-by: Helm` with an `instance` label;
//! 2. the `app.kubernetes.io/instance` label;
//! 3. the `app.kubernetes.io/name` label.
//!
//! Objects without any of these are not part of an application. Only
//! top-level workloads count: a Job created by a CronJob is the CronJob's.
//! Applications are per namespace: the same instance label in two
//! namespaces is two applications.

use crate::resources::{classify, row_problem, ResourceRef, WorkloadStatus};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const INSTANCE_LABEL: &str = "app.kubernetes.io/instance";
pub const NAME_LABEL: &str = "app.kubernetes.io/name";
pub const VERSION_LABEL: &str = "app.kubernetes.io/version";
pub const MANAGED_BY_LABEL: &str = "app.kubernetes.io/managed-by";
pub const HELM_RELEASE_ANNOTATION: &str = "meta.helm.sh/release-name";
pub const HELM_NAMESPACE_ANNOTATION: &str = "meta.helm.sh/release-namespace";

/// The workload kinds grouped into applications: (group, kind).
pub const APP_KINDS: [(&str, &str); 5] = [
    ("apps", "Deployment"),
    ("apps", "StatefulSet"),
    ("apps", "DaemonSet"),
    ("batch", "CronJob"),
    ("batch", "Job"),
];

/// Where an application's grouping comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum AppSource {
    /// A Helm release (its name is the release's).
    Helm,
    /// The `app.kubernetes.io/instance` label.
    Instance,
    /// The `app.kubernetes.io/name` label.
    Name,
}

/// The rolled-up status of an application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum AppHealth {
    /// A workload failed or has a failing replica.
    Degraded,
    /// A workload is not fully ready yet.
    Progressing,
    /// Every workload is fine.
    Healthy,
    /// Every workload is suspended.
    Suspended,
}

impl AppHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Degraded => "Degraded",
            Self::Progressing => "Progressing",
            Self::Healthy => "Healthy",
            Self::Suspended => "Suspended",
        }
    }
}

/// Which application an object belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AppId {
    pub namespace: String,
    pub name: String,
    pub source: AppSource,
}

/// A workload of an application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AppWorkload {
    /// API group and kind, to open its table.
    pub group: String,
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub status: WorkloadStatus,
    /// Why it is not fine ("0 of 2 ready"), or "".
    pub problem: String,
}

/// The part of a workload object kept per object: its application and
/// what the application shows of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppObject {
    pub app: AppId,
    pub workload: AppWorkload,
    /// `app.kubernetes.io/name`, `version` and `managed-by`, "" when unset.
    pub app_name: String,
    pub version: String,
    pub managed_by: String,
    /// Unix seconds.
    pub created: i64,
}

/// One application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Application {
    /// `namespace/name`, unique in a list.
    pub key: String,
    pub namespace: String,
    pub name: String,
    pub source: AppSource,
    /// The distinct `app.kubernetes.io/name` labels of its workloads, sorted.
    pub components: Vec<String>,
    /// The distinct `app.kubernetes.io/version` labels, sorted.
    pub versions: Vec<String>,
    /// The distinct `app.kubernetes.io/managed-by` labels, sorted.
    pub managed_by: Vec<String>,
    pub health: AppHealth,
    /// The first problem ("Deployment web: 0 of 2 ready"), or "".
    pub reason: String,
    /// Problem workloads first, then by kind and name.
    pub workloads: Vec<AppWorkload>,
    /// The oldest workload's creation (unix seconds).
    pub created: i64,
}

/// The applications of the selected namespaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ApplicationsList {
    /// Sorted by namespace and name.
    pub applications: Vec<Application>,
    /// What is missing or narrowed, and why (RBAC).
    pub notes: Vec<String>,
}

fn string_at<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A label or annotation (`what` is "labels" or "annotations").
fn meta<'a>(v: &'a Value, what: &str, key: &str) -> &'a str {
    v.pointer(&format!("/metadata/{what}"))
        .and_then(|m| m.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Whether a CronJob created the object: it then belongs to the CronJob.
fn created_by_cronjob(v: &Value) -> bool {
    v.pointer("/metadata/ownerReferences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|o| o["controller"] == Value::Bool(true) && o["kind"] == "CronJob")
}

/// The application of an object in `namespace`, from its labels and
/// annotations (see the module docs), or `None`.
pub fn app_id(v: &Value, namespace: &str) -> Option<AppId> {
    let label = |k| meta(v, "labels", k).trim();
    let release = meta(v, "annotations", HELM_RELEASE_ANNOTATION).trim();
    let id = |name: &str, ns: &str, source| AppId {
        namespace: ns.to_string(),
        name: name.to_string(),
        source,
    };
    if !release.is_empty() {
        let ns = meta(v, "annotations", HELM_NAMESPACE_ANNOTATION).trim();
        return Some(id(
            release,
            if ns.is_empty() { namespace } else { ns },
            AppSource::Helm,
        ));
    }
    let instance = label(INSTANCE_LABEL);
    if !instance.is_empty() {
        let source = if label(MANAGED_BY_LABEL).eq_ignore_ascii_case("helm") {
            AppSource::Helm
        } else {
            AppSource::Instance
        };
        return Some(id(instance, namespace, source));
    }
    let name = label(NAME_LABEL);
    (!name.is_empty()).then(|| id(name, namespace, AppSource::Name))
}

/// The application part of a workload object of `APP_KINDS` (as JSON), or
/// `None` if it is not part of an application (no labels, or a Job of a
/// CronJob).
pub fn app_object(group: &str, kind: &str, v: &Value) -> Option<AppObject> {
    if kind == "Job" && created_by_cronjob(v) {
        return None;
    }
    let namespace = string_at(v, "/metadata/namespace");
    let app = app_id(v, namespace)?;
    let status = classify(group, kind, v)?;
    let resource = ResourceRef {
        group: group.into(),
        version: String::new(),
        kind: kind.into(),
        plural: String::new(),
        namespaced: true,
    };
    let mut problem = row_problem(&resource, v, 0, 0);
    if problem.is_empty() && status == WorkloadStatus::Suspended {
        problem = "Suspended".into();
    }
    let created = string_at(v, "/metadata/creationTimestamp")
        .parse::<chrono::DateTime<chrono::Utc>>()
        .map(|t| t.timestamp())
        .unwrap_or_default();
    let label = |k| meta(v, "labels", k).trim().to_string();
    Some(AppObject {
        workload: AppWorkload {
            group: group.into(),
            kind: kind.into(),
            namespace: namespace.into(),
            name: string_at(v, "/metadata/name").into(),
            status,
            problem,
        },
        app,
        app_name: label(NAME_LABEL),
        version: label(VERSION_LABEL),
        managed_by: label(MANAGED_BY_LABEL),
        created,
    })
}

/// How a workload counts towards its application's health.
fn health_of(w: &AppWorkload) -> AppHealth {
    use WorkloadStatus::*;
    match w.status {
        Failed | Error => AppHealth::Degraded,
        Pending => AppHealth::Progressing,
        Suspended => AppHealth::Suspended,
        Running | Succeeded | Scheduled | Unknown => AppHealth::Healthy,
    }
}

/// The rolled-up health: the worst workload's, except that suspended
/// workloads only count when every workload is suspended.
pub fn roll_up(workloads: &[AppWorkload]) -> AppHealth {
    let all: Vec<AppHealth> = workloads.iter().map(health_of).collect();
    if !all.is_empty() && all.iter().all(|h| *h == AppHealth::Suspended) {
        return AppHealth::Suspended;
    }
    all.into_iter()
        .filter(|h| *h != AppHealth::Suspended)
        .min()
        .unwrap_or(AppHealth::Healthy)
}

fn distinct<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = values
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The kind's place in [`APP_KINDS`], for ordering.
fn kind_rank(w: &AppWorkload) -> usize {
    APP_KINDS
        .iter()
        .position(|&(g, k)| g == w.group && k == w.kind)
        .unwrap_or(APP_KINDS.len())
}

/// Group objects into applications, sorted by namespace and name. An
/// application found both as a Helm release and by its labels is one
/// application (the Helm release).
pub fn group_applications<'a>(
    objects: impl IntoIterator<Item = &'a AppObject>,
) -> Vec<Application> {
    let mut by: BTreeMap<(String, String), Vec<&AppObject>> = BTreeMap::new();
    for o in objects {
        by.entry((o.app.namespace.clone(), o.app.name.clone()))
            .or_default()
            .push(o);
    }
    by.into_iter()
        .map(|((namespace, name), objects)| {
            let source = objects
                .iter()
                .map(|o| o.app.source)
                .min()
                .unwrap_or(AppSource::Name);
            let mut workloads: Vec<AppWorkload> =
                objects.iter().map(|o| o.workload.clone()).collect();
            workloads.sort_by(|a, b| {
                (health_of(a), kind_rank(a), &a.namespace, &a.name).cmp(&(
                    health_of(b),
                    kind_rank(b),
                    &b.namespace,
                    &b.name,
                ))
            });
            let health = roll_up(&workloads);
            let reason = workloads
                .iter()
                .find(|w| !w.problem.is_empty() && health_of(w) == health)
                .map(|w| format!("{} {}: {}", w.kind, w.name, w.problem))
                .unwrap_or_default();
            Application {
                key: format!("{namespace}/{name}"),
                components: distinct(objects.iter().map(|o| o.app_name.as_str())),
                versions: distinct(objects.iter().map(|o| o.version.as_str())),
                managed_by: distinct(objects.iter().map(|o| o.managed_by.as_str())),
                created: objects.iter().map(|o| o.created).min().unwrap_or_default(),
                namespace,
                name,
                source,
                health,
                reason,
                workloads,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deploy(name: &str, labels: Value, annotations: Value, ready: i64, replicas: i64) -> Value {
        json!({
            "metadata": {
                "name": name, "namespace": "shop", "labels": labels, "annotations": annotations,
                "creationTimestamp": "2024-01-01T00:00:00Z"
            },
            "spec": { "replicas": replicas },
            "status": { "readyReplicas": ready, "replicas": replicas }
        })
    }

    fn obj(v: &Value) -> AppObject {
        app_object("apps", "Deployment", v).expect("an application object")
    }

    #[test]
    fn identity_prefers_helm_then_instance_then_name() {
        let helm = json!({ "metadata": {
            "labels": { INSTANCE_LABEL: "other", MANAGED_BY_LABEL: "Helm" },
            "annotations": { HELM_RELEASE_ANNOTATION: "shop", HELM_NAMESPACE_ANNOTATION: "prod" }
        }});
        assert_eq!(
            app_id(&helm, "x"),
            Some(AppId {
                namespace: "prod".into(),
                name: "shop".into(),
                source: AppSource::Helm
            })
        );
        let managed =
            json!({ "metadata": { "labels": { INSTANCE_LABEL: "db", MANAGED_BY_LABEL: "Helm" } } });
        assert_eq!(app_id(&managed, "x").unwrap().source, AppSource::Helm);
        let instance =
            json!({ "metadata": { "labels": { INSTANCE_LABEL: "db", NAME_LABEL: "postgres" } } });
        let id = app_id(&instance, "x").unwrap();
        assert_eq!((id.name.as_str(), id.source), ("db", AppSource::Instance));
        let name = json!({ "metadata": { "labels": { NAME_LABEL: "redis" } } });
        assert_eq!(app_id(&name, "x").unwrap().source, AppSource::Name);
        assert_eq!(
            app_id(&json!({ "metadata": { "labels": { "app": "web" } } }), "x"),
            None
        );
        assert_eq!(
            app_id(
                &json!({ "metadata": { "labels": { INSTANCE_LABEL: " " } } }),
                "x"
            ),
            None
        );
    }

    #[test]
    fn jobs_of_cron_jobs_are_left_out() {
        let job = json!({ "metadata": {
            "name": "nightly-1", "namespace": "shop", "labels": { INSTANCE_LABEL: "shop" },
            "ownerReferences": [{ "kind": "CronJob", "name": "nightly", "controller": true }]
        }});
        assert_eq!(app_object("batch", "Job", &job), None);
        let own = json!({ "metadata": { "name": "migrate", "namespace": "shop", "labels": { INSTANCE_LABEL: "shop" } } });
        assert!(app_object("batch", "Job", &own).is_some());
    }

    #[test]
    fn workloads_are_grouped_with_their_status_rolled_up() {
        let labels = |name: &str, version: &str| json!({ INSTANCE_LABEL: "shop", NAME_LABEL: name, VERSION_LABEL: version, MANAGED_BY_LABEL: "kustomize" });
        let web = obj(&deploy("web", labels("web", "1.2"), json!({}), 2, 2));
        let api = obj(&deploy("api", labels("api", "1.2"), json!({}), 0, 3));
        let other = obj(&deploy(
            "cache",
            json!({ NAME_LABEL: "redis" }),
            json!({}),
            1,
            1,
        ));
        let apps = group_applications([&web, &api, &other]);
        let keys: Vec<&str> = apps.iter().map(|a| a.key.as_str()).collect();
        assert_eq!(keys, vec!["shop/redis", "shop/shop"]);
        let shop = &apps[1];
        assert_eq!(shop.source, AppSource::Instance);
        assert_eq!(shop.components, vec!["api", "web"]);
        assert_eq!(shop.versions, vec!["1.2"]);
        assert_eq!(shop.managed_by, vec!["kustomize"]);
        assert_eq!(shop.health, AppHealth::Progressing);
        assert_eq!(shop.reason, "Deployment api: 0 of 3 ready");
        let names: Vec<&str> = shop.workloads.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, vec!["api", "web"], "problems first");
        assert_eq!(shop.created, 1_704_067_200);
        assert_eq!(apps[0].health, AppHealth::Healthy);
        assert_eq!(apps[0].reason, "");
    }

    #[test]
    fn a_helm_release_and_its_labels_are_one_application() {
        let helm = obj(&deploy(
            "shop-app",
            json!({ MANAGED_BY_LABEL: "Helm" }),
            json!({ HELM_RELEASE_ANNOTATION: "shop", HELM_NAMESPACE_ANNOTATION: "shop" }),
            1,
            1,
        ));
        let labelled = obj(&deploy(
            "extra",
            json!({ INSTANCE_LABEL: "shop" }),
            json!({}),
            1,
            1,
        ));
        let apps = group_applications([&labelled, &helm]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].source, AppSource::Helm);
        assert_eq!(apps[0].workloads.len(), 2);
    }

    #[test]
    fn health_is_the_worst_and_suspended_only_when_all_are() {
        let w = |status| AppWorkload {
            group: "apps".into(),
            kind: "Deployment".into(),
            namespace: "n".into(),
            name: "w".into(),
            status,
            problem: String::new(),
        };
        use WorkloadStatus::*;
        assert_eq!(
            roll_up(&[w(Running), w(Failed), w(Pending)]),
            AppHealth::Degraded
        );
        assert_eq!(roll_up(&[w(Running), w(Error)]), AppHealth::Degraded);
        assert_eq!(roll_up(&[w(Succeeded), w(Pending)]), AppHealth::Progressing);
        assert_eq!(roll_up(&[w(Scheduled), w(Suspended)]), AppHealth::Healthy);
        assert_eq!(roll_up(&[w(Suspended), w(Suspended)]), AppHealth::Suspended);
        assert_eq!(roll_up(&[]), AppHealth::Healthy);
    }
}
