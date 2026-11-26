//! The YAML editor's save when the object changed on the server since it
//! was loaded (#495), against the kind cluster: a status-only change (a
//! rollout running) is applied without asking, a change to other fields
//! comes back as the edit re-applied on the latest version, and only a
//! field changed on both sides is a conflict. `#[ignore]`d like the other
//! cluster tests; each test uses its own temporary namespace.

mod common;

use std::future::Future;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, DeleteParams, Patch, PatchParams, PostParams};
use kube::Client;
use nauvi::client_for_context;
use nauvi::resources::{
    apply_resource_yaml, apply_resource_yaml_with, get_resource_yaml, ApplyOptions, ApplyOutcome,
    ResourceRef,
};
use serde_json::json;

async fn connect() -> Result<Client> {
    let ctx = std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string());
    tokio::time::timeout(Duration::from_secs(20), client_for_context(Some(&ctx)))
        .await
        .context("timed out building client")?
        .with_context(|| format!("cannot connect to context {ctx}"))
}

async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    let ns = format!("{prefix}-{:x}", common::unique_suffix());
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = tokio::time::timeout(Duration::from_secs(90), body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

fn deployments() -> ResourceRef {
    ResourceRef {
        group: "apps".into(),
        version: "v1".into(),
        kind: "Deployment".into(),
        plural: "deployments".into(),
        namespaced: true,
    }
}

/// A Deployment with no pods (replicas 0), so nothing needs to run.
fn deployment_yaml(ns: &str) -> String {
    format!(
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: {ns}\n  labels:\n    app: it\n\
         spec:\n  replicas: 0\n  selector:\n    matchLabels:\n      app: it\n  template:\n    metadata:\n      labels:\n        app: it\n\
         \x20   spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n"
    )
}

/// Create the Deployment and wait until its controller is done with it
/// (revision annotation set, status caught up), so the YAML the test loads
/// stays current until the test itself changes something.
async fn settled(client: &Client, ns: &str) -> Result<Api<Deployment>> {
    apply_resource_yaml(client, &deployments(), ns, "web", &deployment_yaml(ns)).await?;
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    for _ in 0..100 {
        let d = api.get("web").await?;
        let revised = d
            .metadata
            .annotations
            .as_ref()
            .is_some_and(|a| a.contains_key("deployment.kubernetes.io/revision"));
        let observed = d.status.as_ref().and_then(|s| s.observed_generation);
        if revised && observed == d.metadata.generation {
            return Ok(api);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("the Deployment did not settle")
}

/// What the editor sends: the edited text, and the version and YAML it
/// loaded.
fn opts(dry_run: bool, loaded: &str) -> ApplyOptions {
    let rv = loaded
        .lines()
        .find_map(|l| l.trim().strip_prefix("resourceVersion:"))
        .map(|v| v.trim().trim_matches(['\'', '"']).to_string());
    ApplyOptions {
        dry_run,
        resource_version: rv,
        base: Some(loaded.to_string()),
    }
}

fn add_label(yaml: &str) -> String {
    yaml.replacen("    app: it\n", "    app: it\n    edited: \"yes\"\n", 1)
}

#[tokio::test]
#[ignore]
async fn a_status_change_while_editing_is_no_conflict() -> Result<()> {
    in_temp_ns("it-rebase-status", |client, ns| async move {
        let api = settled(&client, &ns).await?;
        let r = &deployments();
        let loaded = get_resource_yaml(&client, r, &ns, "web", false).await?;
        let edited = add_label(&loaded);

        // A rollout updates the status while the user types.
        let status = json!({ "status": { "conditions": [{
            "type": "Progressing", "status": "True", "reason": "ReplicaSetUpdated",
            "message": "test", "lastUpdateTime": "2026-11-26T10:00:00Z",
            "lastTransitionTime": "2026-11-26T10:00:00Z"
        }] } });
        api.patch_status("web", &PatchParams::default(), &Patch::Merge(&status))
            .await?;
        let now = get_resource_yaml(&client, r, &ns, "web", false).await?;
        ensure!(now != loaded, "the status patch did not change the object");

        for dry_run in [true, false] {
            let out =
                apply_resource_yaml_with(&client, r, &ns, "web", &edited, &opts(dry_run, &loaded))
                    .await?;
            ensure!(
                matches!(out, ApplyOutcome::Applied { .. }),
                "dry run {dry_run}: {out:?}"
            );
        }
        let d = api.get("web").await?;
        ensure!(
            d.metadata.labels.unwrap_or_default().get("edited") == Some(&"yes".to_string()),
            "the edit was not saved"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn an_edit_is_reapplied_on_a_restart_and_a_shared_field_conflicts() -> Result<()> {
    in_temp_ns("it-rebase-restart", |client, ns| async move {
        let api = settled(&client, &ns).await?;
        let r = &deployments();
        let loaded = get_resource_yaml(&client, r, &ns, "web", false).await?;
        let edited = add_label(&loaded);

        // A restart while the user types: another field than the edit.
        let restart = json!({ "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": "2026-11-26T10:00:00Z"
        } } } } });
        api.patch("web", &PatchParams::default(), &Patch::Merge(&restart))
            .await?;

        let out = apply_resource_yaml_with(&client, r, &ns, "web", &edited, &opts(false, &loaded))
            .await?;
        let ApplyOutcome::Rebased {
            yaml,
            latest,
            changed,
            ..
        } = out
        else {
            bail!("expected the edit re-applied, got {out:?}");
        };
        ensure!(
            changed
                .iter()
                .any(|c| c.contains("kubectl.kubernetes.io/restartedAt")),
            "{changed:?}"
        );
        ensure!(yaml.contains("    edited: yes\n"), "{yaml}");
        ensure!(yaml.contains("restartedAt"), "{yaml}");
        // Nothing was saved yet.
        let d = api.get("web").await?;
        ensure!(!d.metadata.labels.unwrap_or_default().contains_key("edited"));

        // Saved from the re-applied YAML (what the editor does after the
        // review), it keeps both changes.
        let out =
            apply_resource_yaml_with(&client, r, &ns, "web", &yaml, &opts(false, &latest)).await?;
        ensure!(matches!(out, ApplyOutcome::Applied { .. }), "{out:?}");
        let d = api.get("web").await?;
        ensure!(d
            .metadata
            .labels
            .as_ref()
            .is_some_and(|l| l.contains_key("edited")));
        let restarted = serde_json::to_value(&d)?
            .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
            .is_some();
        ensure!(restarted, "the restart was lost");

        // Someone else sets the same label: a conflict that names it, and
        // nothing is overwritten.
        let loaded = get_resource_yaml(&client, r, &ns, "web", false).await?;
        let mine = loaded.replace("edited: yes", "edited: mine");
        ensure!(mine != loaded, "{loaded}");
        let theirs = json!({ "metadata": { "labels": { "edited": "theirs" } } });
        api.patch("web", &PatchParams::default(), &Patch::Merge(&theirs))
            .await?;
        let out =
            apply_resource_yaml_with(&client, r, &ns, "web", &mine, &opts(false, &loaded)).await?;
        let ApplyOutcome::Conflict { fields, reason, .. } = out else {
            bail!("expected a conflict, got {out:?}");
        };
        ensure!(
            fields == vec![".metadata.labels.edited".to_string()],
            "{fields:?}"
        );
        let d = api.get("web").await?;
        ensure!(d.metadata.labels.unwrap_or_default().get("edited") == Some(&"theirs".to_string()));
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn a_scale_from_nauvi_is_not_a_takeover() -> Result<()> {
    in_temp_ns("it-rebase-scale", |client, ns| async move {
        settled(&client, &ns).await?;
        let r = &deployments();
        // The row menu's Scale: an update by the field manager "nauvi".
        nauvi::actions::scale(&client, r, &ns, "web", 1).await?;
        let loaded = get_resource_yaml(&client, r, &ns, "web", false).await?;
        let edited = add_label(&loaded);
        let out =
            apply_resource_yaml_with(&client, r, &ns, "web", &edited, &opts(true, &loaded)).await?;
        let ApplyOutcome::Applied { takeovers } = out else {
            bail!("expected a dry run, got {out:?}");
        };
        ensure!(takeovers.is_empty(), "{takeovers:?}");
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn a_recreated_or_terminating_object_is_a_conflict() -> Result<()> {
    in_temp_ns("it-rebase-gone", |client, ns| async move {
        let api = settled(&client, &ns).await?;
        let r = &deployments();
        let loaded = get_resource_yaml(&client, r, &ns, "web", false).await?;
        let edited = add_label(&loaded);

        // Deleted and created again under the same name.
        api.delete("web", &DeleteParams::foreground()).await?;
        for _ in 0..100 {
            if api.get_opt("web").await?.is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        settled(&client, &ns).await?;
        let out = apply_resource_yaml_with(&client, r, &ns, "web", &edited, &opts(false, &loaded))
            .await?;
        let ApplyOutcome::Conflict { reason, .. } = out else {
            bail!("expected a conflict, got {out:?}");
        };
        ensure!(reason.contains("deleted and created again"), "{reason}");
        let d = api.get("web").await?;
        ensure!(!d.metadata.labels.unwrap_or_default().contains_key("edited"));

        // Being deleted (a finalizer holds it).
        let hold = json!({ "metadata": { "finalizers": ["nauvi.dev/it-hold"] } });
        api.patch("web", &PatchParams::default(), &Patch::Merge(&hold))
            .await?;
        let loaded = get_resource_yaml(&client, r, &ns, "web", false).await?;
        let edited = add_label(&loaded);
        api.delete("web", &DeleteParams::background()).await?;
        let out = apply_resource_yaml_with(&client, r, &ns, "web", &edited, &opts(false, &loaded))
            .await?;
        let release = json!({ "metadata": { "finalizers": null } });
        api.patch("web", &PatchParams::default(), &Patch::Merge(&release))
            .await?;
        let ApplyOutcome::Conflict { reason, .. } = out else {
            bail!("expected a conflict, got {out:?}");
        };
        ensure!(reason.contains("being deleted"), "{reason}");
        Ok(())
    })
    .await
}
