//! Integration tests of the Evict action (#300) against the kind cluster.
//! `#[ignore]`d like `cluster.rs`; run with
//! `cargo test --test evict_cluster -- --ignored`.
//!
//! Each test makes a one-replica Deployment and a PodDisruptionBudget in a
//! temporary namespace, which it deletes afterwards.

use std::future::Future;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::{Api, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::Client;
use kubeloupe::actions::{describe_error, evict_pod, run_action, ActionId};
use kubeloupe::{client_for_context, pod_ref};

const TIMEOUT: Duration = Duration::from_secs(90);

async fn connect() -> Result<Client> {
    let ctx = std::env::var("KUBELOUPE_TEST_CONTEXT")
        .unwrap_or_else(|_| "kind-kubeloupe-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// Poll `f` until it returns `Some`, or fail after `d`.
async fn eventually<T, Fut: Future<Output = Result<Option<T>>>>(
    what: &str,
    d: Duration,
    mut f: impl FnMut() -> Fut,
) -> Result<T> {
    let deadline = tokio::time::Instant::now() + d;
    loop {
        if let Some(v) = f().await? {
            return Ok(v);
        }
        if tokio::time::Instant::now() > deadline {
            bail!("timed out after {d:?} waiting for: {what}");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Run `body` in a fresh namespace, deleting it afterwards even on error.
async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    let suffix = std::process::id() ^ jiff::Timestamp::now().subsec_microsecond() as u32;
    let ns = format!("{prefix}-{suffix:x}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = body(client.clone(), ns.clone()).await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

/// A one-replica Deployment `guarded` behind a PDB with `minAvailable: 1`,
/// once the disruption controller has counted its pod. Returns the pod.
async fn guarded_pod(client: &Client, ns: &str) -> Result<String> {
    let deployments: Api<Deployment> = Api::namespaced(client.clone(), ns);
    let dep: Deployment = serde_json::from_value(serde_json::json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": { "name": "guarded" },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": "guarded" } },
            "template": {
                "metadata": { "labels": { "app": "guarded" } },
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{
                        "name": "c", "image": "busybox:1.36",
                        "command": ["sh", "-c", "sleep 3600"]
                    }]
                }
            }
        }
    }))?;
    deployments.create(&PostParams::default(), &dep).await?;
    let pdbs: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), ns);
    let pdb: PodDisruptionBudget = serde_json::from_value(serde_json::json!({
        "apiVersion": "policy/v1", "kind": "PodDisruptionBudget",
        "metadata": { "name": "guarded" },
        "spec": { "minAvailable": 1, "selector": { "matchLabels": { "app": "guarded" } } }
    }))?;
    pdbs.create(&PostParams::default(), &pdb).await?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let name = eventually("the guarded pod running", TIMEOUT, || async {
        let list = pods
            .list(&ListParams::default().labels("app=guarded"))
            .await?;
        Ok(list
            .items
            .iter()
            .find(|p| {
                p.metadata.deletion_timestamp.is_none()
                    && p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
            })
            .and_then(|p| p.metadata.name.clone()))
    })
    .await?;
    eventually("the PDB counts the pod", TIMEOUT, || async {
        let p = pdbs.get("guarded").await?;
        let gen = p.metadata.generation;
        Ok(p.status
            .filter(|s| s.observed_generation == gen && s.current_healthy == 1)
            .map(|_| ()))
    })
    .await?;
    Ok(name)
}

#[tokio::test]
#[ignore]
async fn evict_is_blocked_by_a_pdb_with_the_servers_message() -> Result<()> {
    in_temp_ns("kl-it-evict-pdb", |client, ns| async move {
        let pod = guarded_pod(&client, &ns).await?;
        let err = evict_pod(&client, &ns, &pod).await.unwrap_err();
        let text = describe_error(&err);
        ensure!(
            text.starts_with("Blocked by a PodDisruptionBudget"),
            "{text}"
        );
        // The server's own message, naming the budget.
        ensure!(text.contains("disruption budget guarded"), "{text}");
        // The pod is still there and not terminating.
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        ensure!(pods.get(&pod).await?.metadata.deletion_timestamp.is_none());

        // The dispatcher (what the app and the CLI call) says the same.
        let err = run_action(&client, &pod_ref(), &ns, &pod, ActionId::Evict, None)
            .await
            .unwrap_err();
        ensure!(describe_error(&err).contains("disruption budget guarded"));
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn evict_succeeds_when_the_pdb_allows_it() -> Result<()> {
    in_temp_ns("kl-it-evict-ok", |client, ns| async move {
        let pod = guarded_pod(&client, &ns).await?;
        // Let the budget allow one disruption.
        let pdbs: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), &ns);
        pdbs.patch(
            "guarded",
            &PatchParams::default(),
            &Patch::Merge(serde_json::json!({ "spec": { "minAvailable": 0 } })),
        )
        .await?;
        // Until the disruption controller sees the change the server still
        // answers 429, so retry that only.
        let msg = eventually("the eviction allowed", TIMEOUT, || async {
            match run_action(&client, &pod_ref(), &ns, &pod, ActionId::Evict, None).await {
                Ok(msg) => Ok(Some(msg)),
                Err(e) if describe_error(&e).starts_with("Blocked by a PodDisruptionBudget") => {
                    Ok(None)
                }
                Err(e) => Err(e),
            }
        })
        .await?;
        ensure!(msg == format!("Evicted Pod/{ns}/{pod}"), "{msg}");
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        eventually("the evicted pod gone or terminating", TIMEOUT, || async {
            Ok(pods
                .get_opt(&pod)
                .await?
                .is_none_or(|p| p.metadata.deletion_timestamp.is_some())
                .then_some(()))
        })
        .await?;
        // Evicting what is already gone is a plain-words 404.
        eventually("the evicted pod gone", TIMEOUT, || async {
            Ok(pods.get_opt(&pod).await?.is_none().then_some(()))
        })
        .await?;
        let err = evict_pod(&client, &ns, &pod).await.unwrap_err();
        ensure!(describe_error(&err).starts_with("Already gone"), "{err:#}");
        Ok(())
    })
    .await
}
