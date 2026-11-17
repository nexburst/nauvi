//! Exec credential plugins: a fake `nauvi-test-auth` plugin in a temp dir,
//! and a kubeconfig whose user logs in with it.
//!
//! The plugin runs before the first request, so the failure cases need no
//! cluster and run in plain `cargo test`. The `#[ignore]`d test logs in to the
//! kind cluster (`NAUVI_TEST_CONTEXT`, default `kind-nauvi-test`) with
//! a ServiceAccount token the plugin prints.
//!
//! The plugin's directory is put on the `PATH` the kubeconfig's `exec.env`
//! gives the plugin (the command is looked up there), rather than on this
//! process's `PATH`, which the tests running in parallel share.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{Context, Result};
use kube::config::Kubeconfig;
use nauvi::client_from_kubeconfig;

const PLUGIN: &str = "nauvi-test-auth";
/// Nothing listens here, so a plugin that works ends in "Cannot reach".
const NO_SERVER: &str = "https://127.0.0.1:1";

/// A fresh temp dir holding an executable `nauvi-test-auth` script.
fn plugin_dir(script: &str) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nauvi-auth-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(PLUGIN);
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(dir)
}

fn credential_script(token: &str) -> String {
    format!(
        r#"cat <<'EOF'
{{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{{"token":"{token}"}}}}
EOF"#
    )
}

/// A kubeconfig with one context `fake` whose user runs the plugin, with
/// `path` as its `PATH`.
fn kubeconfig(
    cluster: serde_json::Value,
    path: &Path,
    exec_extra: serde_json::Value,
) -> Kubeconfig {
    let mut exec = serde_json::json!({
        "apiVersion": "client.authentication.k8s.io/v1",
        "command": PLUGIN,
        "env": [{"name": "PATH", "value": format!("{}:/usr/bin:/bin", path.display())}],
    });
    if let (Some(exec), Some(extra)) = (exec.as_object_mut(), exec_extra.as_object()) {
        exec.extend(extra.clone());
    }
    serde_json::from_value(serde_json::json!({
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": "fake",
        "contexts": [{"name": "fake", "context": {"cluster": "c", "user": "u"}}],
        "clusters": [{"name": "c", "cluster": cluster}],
        "users": [{"name": "u", "user": {"exec": exec}}],
    }))
    .expect("valid kubeconfig")
}

fn no_server() -> serde_json::Value {
    serde_json::json!({"server": NO_SERVER, "insecure-skip-tls-verify": true})
}

async fn connect_error(kc: Kubeconfig) -> String {
    match client_from_kubeconfig(kc, None, false).await {
        Ok(_) => panic!("expected the connection to fail"),
        Err(e) => e.to_string(),
    }
}

#[tokio::test]
async fn plugin_on_path_is_run() -> Result<()> {
    let dir = plugin_dir(&credential_script("t0ken"))?;
    let msg = connect_error(kubeconfig(no_server(), &dir, serde_json::json!({}))).await;
    // The plugin ran and returned a token; only the server is missing.
    assert!(
        msg.starts_with("Cannot reach the cluster for `fake`"),
        "{msg}"
    );
    assert!(msg.contains(NO_SERVER), "{msg}");
    Ok(())
}

#[tokio::test]
async fn missing_plugin_is_reported() -> Result<()> {
    let empty = std::env::temp_dir().join("nauvi-auth-does-not-exist");
    let msg = connect_error(kubeconfig(no_server(), &empty, serde_json::json!({}))).await;
    assert!(msg.starts_with("Login to `fake` failed"), "{msg}");
    assert!(
        msg.contains("the `nauvi-test-auth` command it logs in with was not found"),
        "{msg}"
    );
    assert!(msg.contains(&empty.display().to_string()), "{msg}");
    assert!(msg.contains("start nauvi from a terminal"), "{msg}");
    Ok(())
}

#[tokio::test]
async fn failing_plugin_stderr_is_shown() -> Result<()> {
    let dir =
        plugin_dir("echo 'Error: the SSO session has expired. Run: aws sso login' >&2\nexit 1")?;
    let msg = connect_error(kubeconfig(no_server(), &dir, serde_json::json!({}))).await;
    assert!(msg.starts_with("Login to `fake` failed"), "{msg}");
    assert!(msg.contains("exit code 1"), "{msg}");
    assert!(msg.contains("Run: aws sso login"), "{msg}");
    Ok(())
}

#[tokio::test]
async fn interactive_plugin_is_refused() -> Result<()> {
    let dir = plugin_dir(&credential_script("t0ken"))?;
    let kc = kubeconfig(
        no_server(),
        &dir,
        serde_json::json!({"interactiveMode": "Always"}),
    );
    let msg = connect_error(kc).await;
    assert!(msg.contains("needs an interactive login"), "{msg}");
    assert!(msg.contains("Log in from a terminal first"), "{msg}");
    Ok(())
}

/// Logs in to the kind cluster with a ServiceAccount token from the plugin,
/// and gets a readable message once the token is wrong.
#[tokio::test]
#[ignore]
async fn plugin_token_lists_pods_on_kind() -> Result<()> {
    use k8s_openapi::api::authentication::v1::TokenRequest;
    use k8s_openapi::api::core::v1::{Namespace, Pod, ServiceAccount};
    use k8s_openapi::api::rbac::v1::RoleBinding;
    use kube::api::{Api, DeleteParams, ListParams, PostParams};

    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    let admin = nauvi::client_for_context(Some(&ctx)).await?;

    // The real cluster entry (server and CA) for the temp kubeconfig.
    let real = Kubeconfig::read()?;
    let cluster_name = real
        .contexts
        .iter()
        .find(|c| c.name == ctx)
        .and_then(|c| c.context.as_ref())
        .map(|c| c.cluster.clone())
        .context("test context not in kubeconfig")?;
    let cluster = real
        .clusters
        .iter()
        .find(|c| c.name == cluster_name)
        .and_then(|c| c.cluster.clone())
        .context("test cluster not in kubeconfig")?;
    let cluster = serde_json::to_value(cluster)?;

    let suffix = common::unique_suffix();
    let ns = format!("kl-auth-{suffix:x}");
    let namespaces: Api<Namespace> = Api::all(admin.clone());
    namespaces
        .create(
            &PostParams::default(),
            &serde_json::from_value(serde_json::json!({"metadata": {"name": ns}}))?,
        )
        .await?;

    let result = async {
        let pp = PostParams::default();
        let sas: Api<ServiceAccount> = Api::namespaced(admin.clone(), &ns);
        sas.create(
            &pp,
            &serde_json::from_value(serde_json::json!({"metadata": {"name": "viewer"}}))?,
        )
        .await?;
        let bindings: Api<RoleBinding> = Api::namespaced(admin.clone(), &ns);
        bindings
            .create(
                &pp,
                &serde_json::from_value(serde_json::json!({
                    "metadata": {"name": "viewer"},
                    "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view"},
                    "subjects": [{"kind": "ServiceAccount", "name": "viewer", "namespace": ns}],
                }))?,
            )
            .await?;
        let token = sas
            .create_token_request(
                "viewer",
                &pp,
                &serde_json::from_value::<TokenRequest>(
                    serde_json::json!({"spec": {"audiences": [], "expirationSeconds": 600}}),
                )?,
            )
            .await?
            .status
            .context("token request has no status")?
            .token
            .context("token request has no token")?;

        let dir = plugin_dir(&credential_script(&token))?;
        let client = client_from_kubeconfig(
            kubeconfig(cluster.clone(), &dir, serde_json::json!({})),
            None,
            false,
        )
        .await?;
        let pods: Api<Pod> = Api::namespaced(client, &ns);
        pods.list(&ListParams::default()).await?;

        // A token the cluster rejects.
        let bad = plugin_dir(&credential_script("not-a-valid-token"))?;
        let msg = connect_error(kubeconfig(cluster.clone(), &bad, serde_json::json!({}))).await;
        assert!(
            msg.contains("the cluster rejected the credentials"),
            "{msg}"
        );
        anyhow::Ok(())
    }
    .await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

/// The plugin runs once for a catalog check and a connect of the same
/// context (#201): a stand-in plugin counts its runs, and prints a token
/// that expires in 10 minutes.
#[tokio::test]
#[ignore]
async fn check_and_connect_share_one_plugin_run_on_kind() -> Result<()> {
    use k8s_openapi::api::authentication::v1::TokenRequest;
    use k8s_openapi::api::core::v1::{Namespace, ServiceAccount};
    use kube::api::{Api, DeleteParams, PostParams};
    use nauvi::catalog::{check_context, ContextState};

    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    let admin = nauvi::client_for_context(Some(&ctx)).await?;
    let real = Kubeconfig::read()?;
    let cluster_name = real
        .contexts
        .iter()
        .find(|c| c.name == ctx)
        .and_then(|c| c.context.as_ref())
        .map(|c| c.cluster.clone())
        .context("test context not in kubeconfig")?;
    let cluster = real
        .clusters
        .iter()
        .find(|c| c.name == cluster_name)
        .and_then(|c| c.cluster.clone())
        .context("test cluster not in kubeconfig")?;
    let cluster = serde_json::to_value(cluster)?;

    let suffix = common::unique_suffix();
    let ns = format!("kl-exec-{suffix:x}");
    let namespaces: Api<Namespace> = Api::all(admin.clone());
    namespaces
        .create(
            &PostParams::default(),
            &serde_json::from_value(serde_json::json!({"metadata": {"name": ns}}))?,
        )
        .await?;

    let result = async {
        let pp = PostParams::default();
        let sas: Api<ServiceAccount> = Api::namespaced(admin.clone(), &ns);
        sas.create(
            &pp,
            &serde_json::from_value(serde_json::json!({"metadata": {"name": "counted"}}))?,
        )
        .await?;
        let token = sas
            .create_token_request(
                "counted",
                &pp,
                &serde_json::from_value::<TokenRequest>(
                    serde_json::json!({"spec": {"audiences": [], "expirationSeconds": 900}}),
                )?,
            )
            .await?
            .status
            .context("token request has no status")?
            .token
            .context("token request has no token")?;

        let expires = (jiff::Timestamp::now() + jiff::SignedDuration::from_mins(10)).to_string();
        let dir = plugin_dir("")?;
        let runs = dir.join("runs");
        std::fs::write(
            dir.join(PLUGIN),
            format!(
                "#!/bin/sh\necho run >> '{}'\ncat <<'EOF'\n{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"{token}\",\"expirationTimestamp\":\"{expires}\"}}}}\nEOF\n",
                runs.display()
            ),
        )?;
        let file = dir.join("kubeconfig.yaml");
        let kc = kubeconfig(cluster.clone(), &dir, serde_json::json!({}));
        std::fs::write(&file, serde_yaml::to_string(&kc)?)?;
        let target = nauvi::ContextTarget {
            id: "fake".into(),
            context: "fake".into(),
            kubeconfig: Some(file),
        };
        let count = || {
            std::fs::read_to_string(&runs)
                .map(|s| s.lines().count())
                .unwrap_or(0)
        };

        let check = check_context(&target).await;
        assert_eq!(check.state, ContextState::Connected, "{}", check.message);
        let client = nauvi::client_for_target(&target, false).await?;
        client.apiserver_version().await?;
        let again = check_context(&target).await;
        assert_eq!(again.state, ContextState::Connected, "{}", again.message);
        assert_eq!(count(), 1, "the plugin ran {} times", count());
        anyhow::Ok(())
    }
    .await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}
