//! Integration tests of server-side bounded lists (#311) against the kind
//! cluster. `#[ignore]`d like `cluster.rs`; run with
//! `cargo test --test bounded_list_cluster -- --ignored`.
//!
//! Each test creates Events in a temporary namespace, which it deletes
//! afterwards.

mod common;

use std::future::Future;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use k8s_openapi::api::core::v1::{Event, Namespace};
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use kube::Client;
use kubeloupe::bounded_list::list_bounded;
use kubeloupe::client_for_context;

async fn connect() -> Result<Client> {
    let ctx = std::env::var("KUBELOUPE_TEST_CONTEXT")
        .unwrap_or_else(|_| "kind-kubeloupe-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// Run `body` in a fresh namespace, deleting it afterwards even on error.
async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    let suffix = common::unique_suffix();
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

/// `n` events in `ns`, every third a Warning.
async fn make_events(client: &Client, ns: &str, n: usize) -> Result<()> {
    let api: Api<Event> = Api::namespaced(client.clone(), ns);
    for i in 0..n {
        let ev: Event = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "Event",
            "metadata": { "name": format!("ev-{i:03}") },
            "involvedObject": { "kind": "ConfigMap", "name": "x", "namespace": ns },
            "reason": "Test",
            "message": format!("event {i}"),
            "type": if i % 3 == 0 { "Warning" } else { "Normal" },
        }))?;
        api.create(&PostParams::default(), &ev).await?;
    }
    Ok(())
}

#[tokio::test]
#[ignore]
async fn bounded_list_stops_at_the_cap_and_follows_continue() -> Result<()> {
    in_temp_ns("kl-bounded", |client, ns| async move {
        make_events(&client, &ns, 14).await?;
        let api: Api<Event> = Api::namespaced(client.clone(), &ns);

        let capped = list_bounded(&api, &ListParams::default(), 5).await?;
        ensure!(capped.items.len() == 5, "{} events", capped.items.len());
        ensure!(capped.more, "more events exist");

        let all = list_bounded(&api, &ListParams::default(), 100).await?;
        ensure!(all.items.len() == 14, "{} events", all.items.len());
        ensure!(!all.more, "all events read");

        // A field selector with several pages (the page size is the cap
        // left, so cap 3 of 5 warnings needs a continue).
        let warnings = ListParams::default().fields("type=Warning");
        let three = list_bounded(&api, &warnings, 3).await?;
        ensure!(three.items.len() == 3 && three.more, "{three:?}");
        let every = list_bounded(&api, &warnings, 50).await?;
        ensure!(
            every.items.len() == 5 && !every.more,
            "{} warnings",
            every.items.len()
        );
        ensure!(every
            .items
            .iter()
            .all(|e| e.type_.as_deref() == Some("Warning")));
        Ok(())
    })
    .await
}
