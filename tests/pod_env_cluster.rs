//! A container's env with values (#447) against the kind cluster: a
//! literal, a `configMapKeyRef`, a `secretKeyRef`, an `envFrom` ConfigMap
//! and Secret; Secret values never in the result; a reader without access
//! to Secrets gets a plain line. `#[ignore]`d like the other cluster tests;
//! each test uses its own temporary namespace.

mod common;

use std::future::Future;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, DeleteParams, DynamicObject, PostParams};
use kube::config::KubeConfigOptions;
use kube::Client;
use nauvi::client_for_context;
use nauvi::resources::{get_pod_env, reveal_pod_env_value, EnvSourceKind};

fn context() -> String {
    std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string())
}

async fn connect() -> Result<Client> {
    let ctx = context();
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

/// The admin's context, impersonating `user`.
async fn connect_as(user: &str) -> Result<Client> {
    let opts = KubeConfigOptions {
        context: Some(context()),
        ..Default::default()
    };
    let mut config = kube::Config::from_kubeconfig(&opts).await?;
    config.auth_info.impersonate = Some(user.to_string());
    Ok(Client::try_from(config)?)
}

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
    let result = tokio::time::timeout(Duration::from_secs(90), body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

/// Create the objects of `yaml` (several documents) in `ns`.
async fn create_all(client: &Client, ns: &str, docs: &[serde_json::Value]) -> Result<()> {
    for doc in docs {
        let obj: DynamicObject = serde_json::from_value(doc.clone())?;
        let gvk = kube::api::GroupVersionKind::try_from(obj.types.as_ref().context("no types")?)?;
        let (ar, _) = kube::discovery::pinned_kind(client, &gvk).await?;
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), ns, &ar);
        api.create(&PostParams::default(), &obj).await?;
    }
    Ok(())
}

fn objects() -> Vec<serde_json::Value> {
    use serde_json::json;
    vec![
        json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "cfg" },
                "data": { "level": "debug", "mode": "fast" } }),
        json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "creds" },
                // "hunter2-it" and "admin-it"
                "data": { "password": "aHVudGVyMi1pdA==", "user": "YWRtaW4taXQ=" } }),
        json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "app" },
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{
                        "name": "main", "image": "busybox:1.36", "command": ["sleep", "3600"],
                        "envFrom": [
                            { "configMapRef": { "name": "cfg" }, "prefix": "CFG_" },
                            { "secretRef": { "name": "creds" }, "prefix": "S_" }
                        ],
                        "env": [
                            { "name": "PLAIN", "value": "hello" },
                            { "name": "API_TOKEN", "value": "tok-literal-it" },
                            { "name": "LEVEL", "valueFrom": { "configMapKeyRef": { "name": "cfg", "key": "level" } } },
                            { "name": "PASSWORD", "valueFrom": { "secretKeyRef": { "name": "creds", "key": "password" } } },
                            { "name": "OPT", "valueFrom": { "configMapKeyRef": { "name": "nope", "key": "k", "optional": true } } },
                            { "name": "POD", "valueFrom": { "fieldRef": { "fieldPath": "metadata.name" } } }
                        ]
                    }]
                } }),
    ]
}

#[tokio::test]
#[ignore]
async fn pod_env_resolves_values_without_secret_values() -> Result<()> {
    in_temp_ns("kl-podenv", |client, ns| async move {
        create_all(&client, &ns, &objects()).await?;
        let env = get_pod_env(&client, &ns, "app", "main").await?;
        let by = |n: &str| {
            env.env
                .iter()
                .find(|r| r.name == n)
                .cloned()
                .with_context(|| format!("{n} missing: {env:?}"))
        };
        ensure!(by("PLAIN")?.value == "hello");
        let token = by("API_TOKEN")?;
        ensure!(token.hidden && token.value.is_empty(), "{token:?}");
        ensure!(by("LEVEL")?.value == "debug");
        let pw = by("PASSWORD")?;
        ensure!(
            pw.hidden && pw.value.is_empty() && pw.error.is_empty(),
            "{pw:?}"
        );
        ensure!(by("OPT")?.error == "ConfigMap nope not found (optional: not set)");
        ensure!(by("POD")?.value == "app");

        let cfg = &env.from[0];
        let rows: Vec<(&str, &str)> = cfg
            .rows
            .iter()
            .map(|r| (r.name.as_str(), r.value.as_str()))
            .collect();
        ensure!(
            rows == [("CFG_level", "debug"), ("CFG_mode", "fast")],
            "{rows:?}"
        );
        let secret = &env.from[1];
        ensure!(secret.kind == EnvSourceKind::Secret);
        let names: Vec<&str> = secret.rows.iter().map(|r| r.name.as_str()).collect();
        ensure!(names == ["S_password", "S_user"], "{names:?}");

        let text = serde_json::to_string(&env)?;
        for v in ["hunter2-it", "admin-it", "tok-literal-it"] {
            ensure!(!text.contains(v), "{v} reached the env list: {text}");
        }
        // The hidden literal, on request.
        ensure!(
            reveal_pod_env_value(&client, &ns, "app", "main", -1, 1, "API_TOKEN").await?
                == "tok-literal-it"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn pod_env_says_when_a_secret_may_not_be_read() -> Result<()> {
    in_temp_ns("kl-podenv-rbac", |client, ns| async move {
        use serde_json::json;
        let mut docs = objects();
        docs.extend([
            json!({ "apiVersion": "v1", "kind": "ServiceAccount", "metadata": { "name": "reader" } }),
            json!({ "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
                    "metadata": { "name": "no-secrets" },
                    "rules": [{ "apiGroups": [""], "resources": ["pods", "configmaps"], "verbs": ["get"] }] }),
            json!({ "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
                    "metadata": { "name": "reader" },
                    "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "no-secrets" },
                    "subjects": [{ "kind": "ServiceAccount", "name": "reader", "namespace": ns }] }),
        ]);
        create_all(&client, &ns, &docs).await?;
        let reader = connect_as(&format!("system:serviceaccount:{ns}:reader")).await?;
        let env = get_pod_env(&reader, &ns, "app", "main").await?;
        let line = format!("not allowed to read Secret creds in {ns}");
        ensure!(env.from[1].error == line, "{:?}", env.from[1]);
        let pw = env.env.iter().find(|r| r.name == "PASSWORD").context("PASSWORD")?;
        ensure!(pw.error == line && !pw.hidden, "{pw:?}");
        // ConfigMaps still resolve.
        ensure!(env.from[0].rows.len() == 2, "{:?}", env.from[0]);
        Ok(())
    })
    .await
}

/// The limited user (`edit` in team-a) may not read a pod elsewhere.
#[tokio::test]
#[ignore]
async fn limited_user_pod_env_elsewhere_is_forbidden() -> Result<()> {
    let Ok(path) = std::env::var("NAUVI_LIMITED_KUBECONFIG") else {
        eprintln!("NAUVI_LIMITED_KUBECONFIG not set; skipping");
        return Ok(());
    };
    let kubeconfig = kube::config::Kubeconfig::read_from(&path)?;
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    config.proxy_url = None;
    let client = Client::try_from(config)?;
    let err = get_pod_env(&client, "demo", "web", "web")
        .await
        .err()
        .context("reading a pod in demo should be forbidden")?;
    let text = nauvi::actions::describe_error(&err);
    ensure!(text.starts_with("Not allowed"), "{text}");
    Ok(())
}
