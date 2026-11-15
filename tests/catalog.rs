//! The cluster catalog (#78) against the kind cluster: a context from an
//! added kubeconfig file, with a name that clashes with the default
//! kubeconfig's, connects through that file. `#[ignore]`d like the other
//! cluster tests; the user's kubeconfig is only read (hashed before/after).
//!
//! The added files are temp copies of the test context under other names;
//! no cluster or namespace is created.

use anyhow::{Context as _, Result};
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use kube::config::Kubeconfig;
use kubeloupe::catalog::{
    check_context, default_kubeconfig_paths, load_catalog, CatalogInput, ContextState,
};
use kubeloupe::client_for_target;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn test_context() -> String {
    std::env::var("KUBELOUPE_TEST_CONTEXT").unwrap_or_else(|_| "kind-kubeloupe-test".to_string())
}

fn hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    Some(h.finish())
}

/// A kubeconfig with just context `ctx` of `kc`, renamed to `name`, and
/// its cluster's server replaced by `server` if given.
fn single_context(kc: &Kubeconfig, ctx: &str, name: &str, server: Option<&str>) -> Result<String> {
    let named = kc
        .contexts
        .iter()
        .find(|c| c.name == ctx)
        .with_context(|| format!("context {ctx} is not in the kubeconfig"))?;
    let entry = named.context.clone().context("context without entry")?;
    let mut out = Kubeconfig {
        current_context: Some(name.to_string()),
        ..Default::default()
    };
    let mut cluster = kc
        .clusters
        .iter()
        .find(|c| c.name == entry.cluster)
        .cloned()
        .context("no cluster")?;
    if let (Some(server), Some(c)) = (server, cluster.cluster.as_mut()) {
        c.server = Some(server.to_string());
    }
    out.clusters.push(cluster);
    if let Some(user) = &entry.user {
        out.auth_infos
            .extend(kc.auth_infos.iter().find(|u| &u.name == user).cloned());
    }
    let mut renamed = named.clone();
    renamed.name = name.to_string();
    out.contexts.push(renamed);
    let mut yaml = serde_yaml::to_value(&out)?;
    yaml["apiVersion"] = "v1".into();
    yaml["kind"] = "Config".into();
    Ok(serde_yaml::to_string(&yaml)?)
}

#[tokio::test]
#[ignore]
async fn catalog_contexts_connect_through_their_own_file() -> Result<()> {
    let ctx = test_context();
    let defaults: Vec<PathBuf> = default_kubeconfig_paths();
    let before: Vec<Option<u64>> = defaults.iter().map(|p| hash(p)).collect();
    let kc = Kubeconfig::read()?;

    let dir = std::env::temp_dir().join(format!("kubeloupe-catalog-kind-{}", std::process::id()));
    let folder = dir.join("clusters");
    std::fs::create_dir_all(&folder)?;
    // Same name as the default kubeconfig's context: it needs a new id.
    std::fs::write(
        folder.join("team.yaml"),
        single_context(&kc, &ctx, &ctx, None)?,
    )?;
    std::fs::write(
        folder.join("broken.yaml"),
        single_context(
            &kc,
            &ctx,
            "issue78-unreachable",
            Some("https://127.0.0.1:1"),
        )?,
    )?;

    let catalog = load_catalog(&CatalogInput {
        default_paths: defaults.clone(),
        extra: vec![folder.clone()],
        pasted_dir: None,
    });
    let id = format!("{ctx} (team.yaml)");
    let target = catalog.resolve(Some(&id))?;
    assert_eq!(target.context, ctx);
    assert_eq!(
        target.kubeconfig.as_deref(),
        Some(folder.join("team.yaml").as_path())
    );

    let client = tokio::time::timeout(Duration::from_secs(20), client_for_target(&target, false))
        .await
        .context("timed out connecting")??;
    let namespaces: Api<Namespace> = Api::all(client);
    let list = namespaces.list(&ListParams::default().limit(5)).await?;
    assert!(!list.items.is_empty());

    let ok = check_context(&target).await;
    assert_eq!(ok.state, ContextState::Connected, "{ok:?}");
    assert!(ok.version.starts_with('v'), "{ok:?}");
    let broken = check_context(&catalog.resolve(Some("issue78-unreachable"))?).await;
    assert_eq!(broken.state, ContextState::Unreachable, "{broken:?}");
    assert!(broken.message.contains("127.0.0.1:1"), "{broken:?}");

    // The default context is unchanged and still connects as before.
    let default = catalog.resolve(Some(&ctx))?;
    assert_eq!(default.kubeconfig, None);

    std::fs::remove_dir_all(&dir)?;
    let after: Vec<Option<u64>> = defaults.iter().map(|p| hash(p)).collect();
    assert_eq!(before, after, "the user's kubeconfig changed");
    Ok(())
}
