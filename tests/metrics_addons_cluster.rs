//! One-click metrics (#225) against the kind cluster: who may install the
//! add-ons (RBAC, via SelfSubjectAccessReviews). Nothing is installed: the
//! shared cluster's metrics-server and Prometheus are never touched (the
//! real installs run in the QA workflow, on its own staging cluster).
//!
//! `#[ignore]`d like the other cluster tests; run with
//! `cargo test --test metrics_addons_cluster -- --ignored`.

use std::time::Duration;

use anyhow::{ensure, Context, Result};
use kube::Client;
use kubeloupe::client_for_context;
use kubeloupe::helm::{metrics_addon_access, MetricsAddonId};

async fn connect() -> Result<Client> {
    let ctx = std::env::var("KUBELOUPE_TEST_CONTEXT")
        .unwrap_or_else(|_| "kind-kubeloupe-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// The namespace-scoped user of `limited-user.sh`, or `None` (skip).
async fn connect_limited() -> Result<Option<Client>> {
    let Ok(path) = std::env::var("KUBELOUPE_LIMITED_KUBECONFIG") else {
        eprintln!("KUBELOUPE_LIMITED_KUBECONFIG not set; skipping");
        return Ok(None);
    };
    let kubeconfig = kube::config::Kubeconfig::read_from(&path)
        .with_context(|| format!("cannot read {path}"))?;
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    config.proxy_url = None;
    Ok(Some(Client::try_from(config)?))
}

#[tokio::test]
#[ignore]
async fn the_cluster_admin_may_install_the_metrics_addons() -> Result<()> {
    let client = connect().await?;
    for (addon, ns) in [
        (MetricsAddonId::MetricsServer, "kube-system"),
        (MetricsAddonId::Prometheus, "monitoring"),
    ] {
        let access = metrics_addon_access(&client, addon, ns).await?;
        ensure!(access.allowed && access.reason.is_empty(), "{access:?}");
        ensure!(access.id == addon.as_str());
    }
    ensure!(
        metrics_addon_access(&client, MetricsAddonId::Prometheus, " ")
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
#[ignore]
async fn limited_user_may_not_install_the_metrics_addons() -> Result<()> {
    let Some(client) = connect_limited().await? else {
        return Ok(());
    };
    // Even into the namespace where the user may edit everything: the
    // charts create cluster-scoped RBAC.
    for addon in [MetricsAddonId::MetricsServer, MetricsAddonId::Prometheus] {
        let access = metrics_addon_access(&client, addon, "team-a").await?;
        ensure!(!access.allowed, "{access:?}");
        ensure!(
            access.reason == "Not allowed: you can't create clusterroles.rbac.authorization.k8s.io",
            "{access:?}"
        );
    }
    Ok(())
}
