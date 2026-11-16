//! The Pods table's STATUS against a real cluster: pods in states that
//! `kubectl get pods` prints from terminated and init container states
//! (`Init:Error`, `Error`, `Completed`, `NotReady`). `#[ignore]`d like
//! `tests/cluster.rs`; run with `cargo test --test pod_status_cluster -- --ignored`.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{Api, DeleteParams, PostParams};
use kube::Client;
use kubeloupe::client_for_context;
use kubeloupe::resources::{discover, list_resources, resolve_kind};

async fn connect() -> Result<Client> {
    let ctx = std::env::var("KUBELOUPE_TEST_CONTEXT")
        .unwrap_or_else(|_| "kind-kubeloupe-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

fn pod(name: &str, restart: &str, init: &[&str], containers: &[&str]) -> Result<Pod> {
    let c = |prefix: &str, cmds: &[&str]| -> Vec<serde_json::Value> {
        cmds.iter()
            .enumerate()
            .map(|(i, cmd)| {
                serde_json::json!({
                    "name": format!("{prefix}{i}"), "image": "busybox:1.36",
                    "command": ["sh", "-c", cmd]
                })
            })
            .collect()
    };
    Ok(serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": name },
        "spec": {
            "restartPolicy": restart,
            "terminationGracePeriodSeconds": 0,
            "initContainers": c("init", init),
            "containers": c("c", containers),
        }
    }))?)
}

#[tokio::test]
#[ignore]
async fn pods_table_status_matches_kubectl_for_terminated_and_init_states() -> Result<()> {
    let client = connect().await?;
    let suffix = std::process::id() ^ chrono::Utc::now().timestamp_subsec_micros();
    let ns = format!("kl-it-podstatus-{suffix:x}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = scenario(&client, &ns).await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

async fn scenario(client: &Client, ns: &str) -> Result<()> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let cases = [
        (
            pod("init-fails", "Never", &["exit 3"], &["sleep 3600"])?,
            "Init:Error",
        ),
        (pod("fails", "Never", &[], &["exit 1"])?, "Error"),
        (pod("done", "Never", &[], &["true"])?, "Completed"),
        (
            pod("half-done", "Never", &[], &["true", "sleep 3600"])?,
            "NotReady",
        ),
    ];
    for (p, _) in &cases {
        pods.create(&PostParams::default(), p).await?;
    }
    let kinds = discover(client).await?;
    let kind = resolve_kind(&kinds, "pods")
        .context("no pods kind")?
        .clone();
    let col = kind
        .columns
        .iter()
        .position(|c| c.key == "status")
        .context("no status column")?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        let rows = list_resources(client, &kind, Some(ns)).await?;
        let mut pending = Vec::new();
        for (p, want) in &cases {
            let name = p.metadata.name.as_deref().unwrap_or_default();
            let cell = rows
                .iter()
                .find(|r| r.name == name)
                .map(|r| r.cells[col].clone())
                .unwrap_or_default();
            // The overview prints the typed pod the same way.
            let typed = kubeloupe::pod_status(&pods.get(name).await?);
            if cell != *want || typed != *want {
                pending.push(format!(
                    "{name}: table {cell:?}, overview {typed:?}, want {want}"
                ));
            }
        }
        if pending.is_empty() {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            bail!("statuses never matched: {}", pending.join("; "));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
