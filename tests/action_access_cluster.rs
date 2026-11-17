//! Which actions RBAC allows (#218, #340), against the kind cluster: the
//! SelfSubjectAccessReviews behind the greyed actions, and their cache.
//! Nothing is changed in the cluster.
//!
//! `#[ignore]`d like the other cluster tests; run with
//! `cargo test --test action_access_cluster -- --ignored`. The limited-user
//! test skips unless `NAUVI_LIMITED_KUBECONFIG` names the kubeconfig of
//! `scripts/test-cluster/limited-user.sh` (`edit` in team-a only).

use std::time::Duration;

use anyhow::{ensure, Context, Result};
use kube::Client;
use nauvi::action_access::{check_actions, AccessCache, ActionAccess};
use nauvi::client_for_context;
use nauvi::resources::ResourceRef;

async fn connect() -> Result<Client> {
    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// The namespace-scoped user of `limited-user.sh`, or `None` (skip).
async fn connect_limited() -> Result<Option<Client>> {
    let Ok(path) = std::env::var("NAUVI_LIMITED_KUBECONFIG") else {
        eprintln!("NAUVI_LIMITED_KUBECONFIG not set; skipping");
        return Ok(None);
    };
    let kubeconfig = kube::config::Kubeconfig::read_from(&path)
        .with_context(|| format!("cannot read {path}"))?;
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    config.proxy_url = None;
    Ok(Some(Client::try_from(config)?))
}

fn kind(group: &str, kind: &str, plural: &str, namespaced: bool) -> ResourceRef {
    ResourceRef {
        group: group.into(),
        version: "v1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced,
    }
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

async fn check(
    client: &Client,
    cache: &AccessCache,
    r: &ResourceRef,
    ns: &str,
    list: &[&str],
) -> Result<Vec<ActionAccess>> {
    tokio::time::timeout(
        Duration::from_secs(30),
        check_actions(client, cache, r, ns, &ids(list)),
    )
    .await
    .context("timed out checking actions")
}

fn verdict<'a>(out: &'a [ActionAccess], id: &str) -> &'a ActionAccess {
    out.iter()
        .find(|a| a.id == id)
        .expect("every id is answered")
}

#[tokio::test]
#[ignore]
async fn the_admin_may_run_every_action() -> Result<()> {
    let client = connect().await?;
    let cache = AccessCache::default();
    let pod = kind("", "Pod", "pods", true);
    let out = check(
        &client,
        &cache,
        &pod,
        "demo",
        &["logs", "shell", "edit", "delete", "evict"],
    )
    .await?;
    ensure!(
        out.iter().all(|a| a.allowed && a.reason.is_empty()),
        "{out:?}"
    );
    let node = kind("", "Node", "nodes", false);
    let out = check(&client, &cache, &node, "", &["cordon", "drain", "delete"]).await?;
    ensure!(out.iter().all(|a| a.allowed), "{out:?}");
    Ok(())
}

#[tokio::test]
#[ignore]
async fn limited_user_actions_follow_rbac_per_namespace() -> Result<()> {
    let Some(client) = connect_limited().await? else {
        return Ok(());
    };
    let cache = AccessCache::default();
    let dep = kind("apps", "Deployment", "deployments", true);
    let actions = ["logs", "scale", "restart", "edit", "delete"];

    // `edit` in team-a: everything.
    let own = check(&client, &cache, &dep, "team-a", &actions).await?;
    ensure!(own.iter().all(|a| a.allowed), "{own:?}");
    let kept = cache.len();
    ensure!(kept >= 4, "the answers are kept: {kept}");

    // Elsewhere: nothing, each with the request it lacks.
    let other = check(&client, &cache, &dep, "demo", &actions).await?;
    ensure!(other.iter().all(|a| !a.allowed), "{other:?}");
    ensure!(
        verdict(&other, "delete").reason
            == "Not allowed: you can't delete deployments.apps in namespace demo",
        "{other:?}"
    );
    ensure!(
        verdict(&other, "scale").reason
            == "Not allowed: you can't patch deployments/scale.apps in namespace demo",
        "{other:?}"
    );

    // Asked again: the same answers, from the cache (no new entries).
    let before = cache.len();
    let again = check(&client, &cache, &dep, "demo", &actions).await?;
    ensure!(again == other, "{again:?}");
    ensure!(cache.len() == before, "no new reviews");

    let pod = kind("", "Pod", "pods", true);
    let pods = check(
        &client,
        &cache,
        &pod,
        "team-a",
        &["shell", "portForward", "delete"],
    )
    .await?;
    ensure!(pods.iter().all(|a| a.allowed), "{pods:?}");

    // Nodes are cluster-scoped: no namespace helps.
    let node = kind("", "Node", "nodes", false);
    let out = check(
        &client,
        &cache,
        &node,
        "",
        &["cordon", "drain", "nodeShell"],
    )
    .await?;
    ensure!(
        verdict(&out, "cordon").reason == "Not allowed: you can't patch nodes",
        "{out:?}"
    );
    ensure!(!verdict(&out, "drain").allowed, "{out:?}");
    ensure!(
        verdict(&out, "nodeShell").reason
            == "Not allowed: you can't create pods in namespace kube-system",
        "{out:?}"
    );
    Ok(())
}
