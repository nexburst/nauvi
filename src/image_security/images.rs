//! The images the pods run: one per distinct image, keyed by digest (from
//! `status.containerStatuses[].imageID`), by reference when there is none.

use super::config_audit::{owners_of, Owners};
use super::Workload;
use crate::owner::{pod_owner, pod_workload};
use crate::registry_tags::ImageRef;
use crate::text::single_line;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::Pod;
use kube::Client;
use std::collections::BTreeMap;

/// One container of a pod, with the owner Trivy Operator names in its
/// report labels (the ReplicaSet of a Deployment's pod) and the workload
/// shown to people (the Deployment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerUse {
    pub owner_kind: String,
    pub owner_name: String,
    pub workload: Workload,
}

/// One distinct image of the running pods.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningImage {
    /// The digest, else the normalized reference ([`normalize`]).
    pub key: String,
    /// As the first pod names it (`nginx:1.27`).
    pub reference: String,
    /// `sha256:...`, empty when the runtime reported none.
    pub digest: String,
    pub uses: Vec<ContainerUse>,
}

/// The repository digest in an `imageID` (`docker.io/library/nginx@sha256:ab`,
/// `docker-pullable://nginx@sha256:ab`), empty when it has none. A bare
/// `sha256:...` is the local image ID, not a digest a registry or a report
/// knows, so it does not count.
pub fn image_digest(image_id: &str) -> String {
    match image_id.rsplit_once('@') {
        Some((_, d)) if d.starts_with("sha256:") && d.len() > 7 => d.to_string(),
        _ => String::new(),
    }
}

/// `nginx`, `docker.io/nginx:latest` and `index.docker.io/library/nginx`
/// all name `docker.io/library/nginx:latest`. A digest in the reference is
/// dropped (images are matched by digest separately).
pub fn normalize(reference: &str) -> String {
    let r = reference.trim();
    let r = r.split_once('@').map_or(r, |(name, _)| name);
    // The shared parser (#547); a name it refuses is compared as written.
    match ImageRef::parse(r) {
        Ok(i) => format!("{}/{}:{}", i.registry, i.repository, i.tag),
        Err(_) => r.to_string(),
    }
}

/// [`normalize`]d, without the `docker.io/library/` or `docker.io/` that
/// people leave out.
pub fn short_reference(reference: &str) -> String {
    let n = normalize(reference);
    n.strip_prefix("docker.io/library/")
        .or_else(|| n.strip_prefix("docker.io/"))
        .map_or(n.clone(), str::to_string)
}

/// The CronJobs of the Jobs whose pods are in `pods` (#559), from each
/// Job's controller owner reference: one metadata list of the Jobs of
/// `namespace` (`None`: all), and only when a pod belongs to a Job. A list
/// that is not allowed or fails leaves them out: the Jobs then stand on
/// their own, and the listing does not fail.
pub async fn job_owners(client: &Client, namespace: Option<&str>, pods: &[Pod]) -> Owners {
    let mut owners = Owners::new();
    if pods
        .iter()
        .any(|p| pod_owner(p).is_some_and(|o| o.kind == "Job"))
    {
        owners_of::<Job>(client, namespace, "Job", "CronJob", &mut owners).await;
    }
    owners
}

/// The workload a pod belongs to ([`crate::owner::pod_workload`]): a
/// ReplicaSet with the pod's `pod-template-hash` is its Deployment's, so the
/// Deployment is shown. Returns (owner kind, owner name, workload kind,
/// workload name); a pod without an owner is its own.
fn owner_of(pod: &Pod) -> (String, String, String, String) {
    let name = pod.metadata.name.clone().unwrap_or_default();
    let (Some(o), Some((kind, workload))) = (pod_owner(pod), pod_workload(pod)) else {
        return ("Pod".into(), name.clone(), "Pod".into(), name);
    };
    (o.kind.clone(), o.name.clone(), kind, workload)
}

/// The distinct images of `pods`, in the order first seen: the same image
/// in N pods is one entry with every workload container that uses it
/// (once each). Init containers count; ephemeral (debug) containers do not.
/// A Job's workload names its CronJob when `jobs` ([`job_owners`]) has it.
pub fn pod_images(pods: &[Pod], jobs: &Owners) -> Vec<RunningImage> {
    let mut out: Vec<RunningImage> = Vec::new();
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    for pod in pods {
        let namespace = pod.metadata.namespace.clone().unwrap_or_default();
        let (owner_kind, owner_name, kind, name) = owner_of(pod);
        let [owner_kind, owner_name, kind, name] =
            [owner_kind, owner_name, kind, name].map(|s| single_line(&s));
        let cron_job = match jobs.get(&(namespace.clone(), kind.clone(), name.clone())) {
            Some((owner, cron)) if kind == "Job" && owner == "CronJob" => cron.clone(),
            _ => String::new(),
        };
        let Some(spec) = &pod.spec else { continue };
        let status = pod.status.as_ref();
        let statuses = status
            .and_then(|s| s.container_statuses.as_ref())
            .into_iter()
            .flatten()
            .chain(
                status
                    .and_then(|s| s.init_container_statuses.as_ref())
                    .into_iter()
                    .flatten(),
            );
        let ids: BTreeMap<&str, &str> = statuses
            .map(|s| (s.name.as_str(), s.image_id.as_str()))
            .collect();
        let containers = spec
            .init_containers
            .iter()
            .flatten()
            .chain(spec.containers.iter());
        for c in containers {
            // Cluster text: clean before it is stored, shown or compared.
            let reference = single_line(c.image.as_deref().unwrap_or(""));
            if reference.is_empty() {
                continue;
            }
            let digest = ids
                .get(c.name.as_str())
                .map_or(String::new(), |id| single_line(&image_digest(id)));
            let key = if digest.is_empty() {
                normalize(&reference)
            } else {
                digest.clone()
            };
            let i = *index.entry(key.clone()).or_insert_with(|| {
                out.push(RunningImage {
                    key,
                    reference: reference.clone(),
                    digest: digest.clone(),
                    uses: Vec::new(),
                });
                out.len() - 1
            });
            let usage = ContainerUse {
                owner_kind: owner_kind.clone(),
                owner_name: owner_name.clone(),
                workload: Workload {
                    kind: kind.clone(),
                    namespace: namespace.clone(),
                    name: name.clone(),
                    container: single_line(&c.name),
                    cron_job: cron_job.clone(),
                },
            };
            if !out[i].uses.contains(&usage) {
                out[i].uses.push(usage);
            }
        }
    }
    merge_pending(out)
}

/// A pod that has not started yet has no digest. Its use joins the one
/// entry with a digest and the same reference, if there is exactly one and
/// it already runs in the pod's namespace (a rollout in progress); a tag
/// elsewhere in the cluster may name another build, so it stays apart.
fn merge_pending(mut images: Vec<RunningImage>) -> Vec<RunningImage> {
    let mut by_ref: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, img) in images.iter().enumerate() {
        if !img.digest.is_empty() {
            by_ref.entry(normalize(&img.reference)).or_default().push(i);
        }
    }
    let namespaces: Vec<Vec<String>> = images
        .iter()
        .map(|img| {
            img.uses
                .iter()
                .map(|u| u.workload.namespace.clone())
                .collect()
        })
        .collect();
    for i in 0..images.len() {
        if !images[i].digest.is_empty() {
            continue;
        }
        let Some(&[target]) = by_ref.get(&images[i].key).map(Vec::as_slice) else {
            continue;
        };
        let uses = std::mem::take(&mut images[i].uses);
        let (moved, kept): (Vec<_>, Vec<_>) = uses
            .into_iter()
            .partition(|u| namespaces[target].contains(&u.workload.namespace));
        images[i].uses = kept;
        for u in moved {
            if !images[target].uses.contains(&u) {
                images[target].uses.push(u);
            }
        }
    }
    images.retain(|img| !img.uses.is_empty());
    images
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pods() -> Vec<Pod> {
        let text = include_str!("testdata/pods.json");
        let v: serde_json::Value = serde_json::from_str(text).unwrap();
        serde_json::from_value(v["items"].clone()).unwrap()
    }

    #[test]
    fn a_pending_pod_joins_its_image_only_in_its_own_namespace() {
        let mut list = pods();
        // A pending nginx pod in another namespace: no digest yet.
        let mut other = list[2].clone();
        other.metadata.namespace = Some("elsewhere".into());
        other.metadata.owner_references = None;
        other.metadata.name = Some("lonely".into());
        list.push(other);
        let images = pod_images(&list, &Owners::new());
        let nginx: Vec<_> = images
            .iter()
            .filter(|i| i.reference == "nginx:1.27")
            .collect();
        assert_eq!(nginx.len(), 2, "{images:?}");
        // The pending pod of the Deployment (shop) joined the digest row.
        assert_eq!(nginx[0].digest, "sha256:1111");
        assert!(nginx[0].uses.iter().all(|u| u.workload.namespace == "shop"));
        assert_eq!(nginx[1].digest, "");
        assert_eq!(nginx[1].uses[0].workload.name, "lonely");
    }

    fn job_pod(name: &str, job: &str) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": {
                "name": name, "namespace": "demo",
                "ownerReferences": [{ "apiVersion": "batch/v1", "kind": "Job", "name": job, "uid": "j", "controller": true }]
            },
            "spec": { "containers": [{ "name": "main", "image": "alpine:3.20" }] }
        }))
        .unwrap()
    }

    /// A Job names its CronJob only when the Job's controller says so
    /// (#559): a standalone Job named like a scheduled one does not.
    #[test]
    fn a_jobs_cron_job_comes_from_its_owner_not_its_name() {
        let pods = [
            job_pod("nightly-29384100-x", "nightly-29384100"),
            job_pod("nightly-1732700000-y", "nightly-1732700000"),
        ];
        let mut jobs = Owners::new();
        jobs.insert(
            ("demo".into(), "Job".into(), "nightly-29384100".into()),
            ("CronJob".into(), "nightly".into()),
        );
        let images = pod_images(&pods, &jobs);
        let uses: Vec<_> = images[0]
            .uses
            .iter()
            .map(|u| (u.workload.name.as_str(), u.workload.cron_job.as_str()))
            .collect();
        assert_eq!(
            uses,
            [("nightly-29384100", "nightly"), ("nightly-1732700000", "")]
        );
        assert!(images[0].uses.iter().all(|u| u.workload.kind == "Job"));
        // Without the Jobs (not allowed to list them) no Job has one.
        let images = pod_images(&pods, &Owners::new());
        assert!(images[0]
            .uses
            .iter()
            .all(|u| u.workload.cron_job.is_empty()));
    }

    #[test]
    fn digests_come_from_repository_image_ids_only() {
        assert_eq!(
            image_digest("docker.io/library/nginx@sha256:abc"),
            "sha256:abc"
        );
        assert_eq!(
            image_digest("docker-pullable://nginx@sha256:abc"),
            "sha256:abc"
        );
        assert_eq!(image_digest("sha256:abc"), "");
        assert_eq!(image_digest(""), "");
        assert_eq!(image_digest("nginx@sha256:"), "");
    }

    #[test]
    fn references_normalize_like_docker() {
        for r in [
            "nginx",
            "nginx:latest",
            "docker.io/nginx",
            "index.docker.io/library/nginx:latest",
            "nginx@sha256:abc",
        ] {
            assert_eq!(normalize(r), "docker.io/library/nginx:latest", "{r}");
        }
        assert_eq!(normalize("bitnami/redis:7"), "docker.io/bitnami/redis:7");
        assert_eq!(
            normalize("localhost:5000/team/app:v2"),
            "localhost:5000/team/app:v2"
        );
        assert_eq!(
            normalize("registry.k8s.io/pause:3.9"),
            "registry.k8s.io/pause:3.9"
        );
        assert_eq!(normalize("ghcr.io/org/tool"), "ghcr.io/org/tool:latest");
        assert_eq!(
            short_reference("docker.io/library/nginx:1.27"),
            "nginx:1.27"
        );
        assert_eq!(short_reference("bitnami/redis:7"), "bitnami/redis:7");
        assert_eq!(short_reference("quay.io/a/b:1"), "quay.io/a/b:1");
    }

    #[test]
    fn the_same_image_in_many_pods_is_one_entry() {
        let images = pod_images(&pods(), &Owners::new());
        let refs: Vec<_> = images.iter().map(|i| i.reference.as_str()).collect();
        assert_eq!(refs, ["nginx:1.27", "busybox:1.36", "redis:7"]);

        // Two pods of one Deployment plus a bare pod, by digest.
        let nginx = &images[0];
        assert_eq!(nginx.key, "sha256:1111");
        assert_eq!(nginx.digest, "sha256:1111");
        let uses: Vec<_> = nginx
            .uses
            .iter()
            .map(|u| {
                format!(
                    "{}/{} {}/{}/{}",
                    u.owner_kind,
                    u.owner_name,
                    u.workload.kind,
                    u.workload.name,
                    u.workload.container
                )
            })
            .collect();
        assert_eq!(
            uses,
            [
                "ReplicaSet/web-5f6b7c Deployment/web/nginx",
                "Pod/static Pod/static/nginx"
            ]
        );

        // An init container's image counts; without a digest it is keyed
        // by its reference.
        let busybox = &images[1];
        assert_eq!(busybox.key, "docker.io/library/busybox:1.36");
        assert_eq!(busybox.digest, "");
        assert_eq!(busybox.uses[0].workload.container, "init");

        // A StatefulSet keeps its own kind.
        assert_eq!(images[2].uses[0].workload.kind, "StatefulSet");
        assert_eq!(images[2].uses[0].workload.name, "cache");
    }
}
