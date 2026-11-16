//! Helm releases against the kind cluster (`scripts/test-cluster/setup.sh`),
//! with the local chart in `scripts/test-cluster/charts/demo-chart`. All
//! `#[ignore]`d; run with `cargo test --test helm_cluster -- --ignored`.
//!
//! They need the `helm` binary (on `PATH`, or `KUBELOUPE_HELM`) and skip
//! without it, except in CI, where a missing helm fails them. Each test
//! installs its release in its own temporary namespace and deletes it.

use std::future::Future;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use futures::StreamExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, DeleteParams, PostParams};
use kube::Client;
use kubeloupe::applications::{AppHealth, AppSource, ApplicationsList};
use kubeloupe::client_for_context;
use kubeloupe::helm::{
    get_helm_release, helm_rollback, helm_uninstall, helm_upgrade, helm_version,
    list_helm_releases, release_charts, HelmDeployRequest, HelmRevisionKey, HelmStorage,
    HelmTarget,
};
use kubeloupe::liveness::Prober;
use kubeloupe::resources::REDACTED;
use kubeloupe::{watch_applications, ApplicationsUpdate};

fn context() -> String {
    std::env::var("KUBELOUPE_TEST_CONTEXT").unwrap_or_else(|_| "kind-kubeloupe-test".to_string())
}

fn helm_bin() -> String {
    std::env::var("KUBELOUPE_HELM")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "helm".into())
}

const CHART: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/scripts/test-cluster/charts/demo-chart"
);

/// Whether helm is there; in CI its absence is an error.
async fn have_helm() -> Result<bool> {
    match helm_version().await {
        Ok(_) => Ok(true),
        Err(e) if std::env::var_os("CI").is_some() => bail!("helm is required in CI: {e:#}"),
        Err(e) => {
            eprintln!("skipping: {e:#}");
            Ok(false)
        }
    }
}

/// Run helm against the test context, failing with its stderr.
fn helm(args: &[&str]) -> Result<()> {
    helm_with_driver("secret", args)
}

/// [`helm`] with releases kept in `driver` (`HELM_DRIVER`).
fn helm_with_driver(driver: &str, args: &[&str]) -> Result<()> {
    let out = Command::new(helm_bin())
        .env("HELM_DRIVER", driver)
        .args(args)
        .args(["--kube-context", &context()])
        .output()
        .context("cannot run helm")?;
    ensure!(
        out.status.success(),
        "helm {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}

fn kubeloupe(args: &[&str]) -> Result<(String, String)> {
    let out = Command::new(env!("CARGO_BIN_EXE_kubeloupe"))
        .args(args)
        .args(["--context", &context()])
        .output()?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    ensure!(out.status.success(), "kubeloupe {args:?}: {stderr}");
    Ok((stdout, stderr))
}

async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = tokio::time::timeout(
        Duration::from_secs(20),
        client_for_context(Some(&context())),
    )
    .await
    .context("timed out building client")??;
    let suffix = std::process::id() ^ jiff::Timestamp::now().subsec_microsecond() as u32;
    let ns = format!("{prefix}-{suffix:x}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = tokio::time::timeout(Duration::from_secs(240), body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

#[tokio::test]
#[ignore]
async fn helm_releases_list_decode_roll_back_and_uninstall() -> Result<()> {
    if !have_helm().await? {
        return Ok(());
    }
    in_temp_ns("kl-it-helm", |client, ns| async move {
        let rel = "kl-demo";
        helm(&["install", rel, CHART, "-n", &ns])?;
        helm(&["upgrade", rel, CHART, "-n", &ns, "--set", "greeting=bye"])?;

        // The list comes from labels: two revisions, the newest current.
        let list = list_helm_releases(&client, std::slice::from_ref(&ns)).await?;
        ensure!(list.warnings.is_empty(), "{:?}", list.warnings);
        ensure!(list.releases.len() == 1, "{:?}", list.releases);
        let row = &list.releases[0];
        ensure!(
            row.name == rel && row.namespace == ns && row.revision == 2,
            "{row:?}"
        );
        ensure!(row.status == "deployed" && row.updated > 0, "{row:?}");
        let history: Vec<(u32, &str)> = row
            .history
            .iter()
            .map(|h| (h.revision, h.status.as_str()))
            .collect();
        ensure!(
            history == [(2, "deployed"), (1, "superseded")],
            "{history:?}"
        );

        // The chart columns, from the payload.
        let charts = release_charts(
            &client,
            &[HelmRevisionKey {
                namespace: ns.clone(),
                name: rel.into(),
                revision: 2,
                storage: row.storage,
            }],
        )
        .await;
        let c = &charts[0];
        ensure!(c.error.is_empty(), "{c:?}");
        ensure!(
            (
                c.chart.as_str(),
                c.chart_version.as_str(),
                c.app_version.as_str()
            ) == ("demo-chart", "0.1.0", "1.36"),
            "{c:?}"
        );

        // The newest revision, decoded, with the Secret hidden.
        let r = get_helm_release(&client, &ns, rel, None, false).await?;
        ensure!(r.revision == 2 && r.status == "deployed", "{r:?}");
        ensure!(r.values == "greeting: bye\n", "{}", r.values);
        ensure!(
            r.computed_values.contains("replicas: 1"),
            "{}",
            r.computed_values
        );
        ensure!(
            r.computed_values.contains("greeting: bye"),
            "{}",
            r.computed_values
        );
        ensure!(r.notes.trim() == format!("{rel} says bye."), "{}", r.notes);
        ensure!(r.description == "Upgrade complete", "{}", r.description);
        ensure!(r.secrets_hidden, "secrets not hidden");
        ensure!(!r.manifest.contains("not-a-real-secret"), "{}", r.manifest);
        ensure!(r.manifest.contains(REDACTED), "{}", r.manifest);
        ensure!(r.manifest.contains("greeting: \"bye\""), "{}", r.manifest);
        let kinds: Vec<String> = r
            .resources
            .iter()
            .map(|o| format!("{}/{}", o.kind, o.name))
            .collect();
        for want in [
            format!("Secret/{rel}-secret"),
            format!("ConfigMap/{rel}-config"),
            format!("Deployment/{rel}-app"),
        ] {
            ensure!(kinds.contains(&want), "{want} not in {kinds:?}");
        }

        // An older revision, revealed.
        let r1 = get_helm_release(&client, &ns, rel, Some(1), true).await?;
        ensure!(r1.revision == 1 && r1.status == "superseded", "{r1:?}");
        ensure!(r1.values.is_empty(), "{}", r1.values);
        ensure!(!r1.secrets_hidden && r1.manifest.contains("not-a-real-secret"));
        ensure!(
            r1.notes.trim() == format!("{rel} says hello."),
            "{}",
            r1.notes
        );
        let e = get_helm_release(&client, &ns, rel, Some(9), false)
            .await
            .unwrap_err();
        ensure!(e.to_string().contains("no revision 9"), "{e}");
        let e = get_helm_release(&client, &ns, "missing", None, false)
            .await
            .unwrap_err();
        ensure!(
            e.to_string().contains("No Helm release named missing"),
            "{e}"
        );

        // The CLI.
        let (out, _) = kubeloupe(&["helm", "list", "-n", &ns])?;
        ensure!(
            out.starts_with("NAME") && out.contains("demo-chart-0.1.0"),
            "{out}"
        );
        let (out, _) = kubeloupe(&["helm", "get", rel, "values", "-n", &ns])?;
        ensure!(out == "greeting: bye\n", "{out}");
        let (out, err) = kubeloupe(&["helm", "get", rel, "manifest", "-n", &ns])?;
        ensure!(
            !out.contains("not-a-real-secret") && err.contains("--reveal"),
            "{out}"
        );
        let (out, _) = kubeloupe(&["helm", "get", rel, "notes", "-n", &ns, "--revision", "1"])?;
        ensure!(out.trim() == format!("{rel} says hello."), "{out}");
        let (out, _) = kubeloupe(&["helm", "get", rel, "-n", &ns])?;
        ensure!(
            out.contains("STATUS: deployed") && out.contains("HISTORY:"),
            "{out}"
        );

        // Phase 2, through the helm CLI.
        let target = HelmTarget {
            kubeconfig: None,
            context: Some(context()),
        };
        let msg = helm_rollback(&target, &ns, rel, 1, row.storage).await?;
        ensure!(msg.contains("revision 1"), "{msg}");
        let r = get_helm_release(&client, &ns, rel, None, false).await?;
        ensure!(r.revision == 3 && r.status == "deployed", "{r:?}");
        ensure!(r.values.is_empty(), "rollback kept values: {}", r.values);
        ensure!(
            r.notes.trim() == format!("{rel} says hello."),
            "{}",
            r.notes
        );

        let e = helm_rollback(&target, &ns, rel, 42, row.storage)
            .await
            .unwrap_err();
        ensure!(
            e.to_string().starts_with("Rollback of kl-demo failed:"),
            "{e}"
        );

        helm_uninstall(&target, &ns, rel, row.storage).await?;
        let list = list_helm_releases(&client, std::slice::from_ref(&ns)).await?;
        ensure!(list.releases.is_empty(), "{:?}", list.releases);
        Ok(())
    })
    .await
}

/// A release stored in ConfigMaps (`HELM_DRIVER=configmap`) is upgraded,
/// rolled back and uninstalled where it is stored (#122); asking for it in
/// Secrets says plainly where helm looked.
#[tokio::test]
#[ignore]
async fn helm_release_in_configmaps_upgrades_rolls_back_and_uninstalls() -> Result<()> {
    if !have_helm().await? {
        return Ok(());
    }
    in_temp_ns("kl-it-helm-cm", |client, ns| async move {
        let rel = "kl-cm";
        helm_with_driver(
            "configmap",
            &["install", rel, CHART, "-n", &ns, "--set", "replicas=0"],
        )?;

        let list = list_helm_releases(&client, std::slice::from_ref(&ns)).await?;
        ensure!(list.releases.len() == 1, "{:?}", list.releases);
        let storage = list.releases[0].storage;
        ensure!(storage == HelmStorage::ConfigMap, "{storage:?}");

        let target = HelmTarget {
            kubeconfig: None,
            context: Some(context()),
        };
        let up = helm_upgrade(
            &target,
            &HelmDeployRequest {
                name: rel.into(),
                namespace: ns.clone(),
                chart: CHART.into(),
                values: "replicas: 0\ngreeting: bye\n".into(),
                storage,
                ..Default::default()
            },
        )
        .await?;
        ensure!(up.revision == 2, "{up:?}");

        let msg = helm_rollback(&target, &ns, rel, 1, storage).await?;
        ensure!(msg.contains("revision 1"), "{msg}");
        let r = get_helm_release(&client, &ns, rel, None, false).await?;
        ensure!(r.revision == 3 && r.storage == storage, "{r:?}");

        // Where it is not: helm's words, made plain.
        let e = helm_uninstall(&target, &ns, rel, HelmStorage::Secret)
            .await
            .unwrap_err()
            .to_string();
        ensure!(
            e == format!(
                "Uninstall of {rel} failed: release {rel} was not found in namespace {ns} (helm looked in its Secrets)"
            ),
            "{e}"
        );

        helm_uninstall(&target, &ns, rel, storage).await?;
        let list = list_helm_releases(&client, std::slice::from_ref(&ns)).await?;
        ensure!(list.releases.is_empty(), "{:?}", list.releases);
        Ok(())
    })
    .await
}

/// The limited user (`limited-user.sh`) may read Secrets in team-a only:
/// other scopes become warnings, not errors.
#[tokio::test]
#[ignore]
async fn limited_user_helm_listing_degrades_per_namespace() -> Result<()> {
    let Ok(path) = std::env::var("KUBELOUPE_LIMITED_KUBECONFIG") else {
        eprintln!("KUBELOUPE_LIMITED_KUBECONFIG not set; skipping");
        return Ok(());
    };
    let kubeconfig = kube::config::Kubeconfig::read_from(&path)?;
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    config.proxy_url = None;
    let client = Client::try_from(config)?;

    let all = list_helm_releases(&client, &[]).await?;
    ensure!(
        all.warnings.len() == 1 && all.warnings[0].contains("across all namespaces"),
        "{:?}",
        all.warnings
    );
    let some =
        list_helm_releases(&client, &["team-a".to_string(), "kube-system".to_string()]).await?;
    ensure!(
        some.warnings.len() == 1 && some.warnings[0].contains("namespace kube-system"),
        "{:?}",
        some.warnings
    );
    let e = get_helm_release(&client, "kube-system", "anything", None, false)
        .await
        .unwrap_err();
    ensure!(
        e.to_string().starts_with("Not allowed to list Secrets"),
        "{e}"
    );
    Ok(())
}

/// A Deployment of one replica of `image` with `labels` on the object.
fn labelled_deployment(name: &str, labels: serde_json::Value, image: &str) -> Result<Deployment> {
    Ok(serde_json::from_value(serde_json::json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": { "name": name, "labels": labels },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "kl-app-test": name } },
            "template": {
                "metadata": { "labels": { "kl-app-test": name } },
                "spec": {
                    "terminationGracePeriodSeconds": 0,
                    "containers": [{ "name": "c", "image": image, "command": ["sleep", "3600"] }]
                }
            }
        }
    }))?)
}

/// The first list from `updates` that `done` accepts, within 120 s.
async fn applications_until(
    updates: &mut futures::stream::BoxStream<'static, ApplicationsUpdate>,
    what: &str,
    done: impl Fn(&ApplicationsList) -> bool,
) -> Result<ApplicationsList> {
    let mut last = None;
    let wait = async {
        while let Some(u) = updates.next().await {
            if let ApplicationsUpdate::List(list) = u {
                if done(&list) {
                    return Some(*list);
                }
                last = Some(list);
            }
        }
        None
    };
    match tokio::time::timeout(Duration::from_secs(120), wait).await {
        Ok(Some(list)) => Ok(list),
        _ => bail!("{what}: timed out; last list: {last:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn applications_group_labelled_workloads_and_helm_releases() -> Result<()> {
    if !have_helm().await? {
        return Ok(());
    }
    in_temp_ns("kl-it-apps", |client, ns| async move {
        let deployments: Api<Deployment> = Api::namespaced(client.clone(), &ns);
        let labels = |name: &str| {
            serde_json::json!({
                "app.kubernetes.io/instance": "shop",
                "app.kubernetes.io/name": name,
                "app.kubernetes.io/version": "1.0",
            })
        };
        let pp = PostParams::default();
        deployments
            .create(
                &pp,
                &labelled_deployment("shop-web", labels("web"), "busybox:1.36")?,
            )
            .await?;
        // Never ready: the application is still progressing.
        deployments
            .create(
                &pp,
                &labelled_deployment("shop-api", labels("api"), "kubeloupe.invalid/nope:1")?,
            )
            .await?;
        deployments
            .create(
                &pp,
                &labelled_deployment(
                    "cache",
                    serde_json::json!({ "app.kubernetes.io/name": "redis" }),
                    "busybox:1.36",
                )?,
            )
            .await?;
        // Not part of an application.
        deployments
            .create(
                &pp,
                &labelled_deployment("loner", serde_json::json!({}), "busybox:1.36")?,
            )
            .await?;
        helm(&["install", "kl-app", CHART, "-n", &ns])?;

        let prober = Prober::new(client.clone());
        let mut updates = watch_applications(&client, &prober, std::slice::from_ref(&ns));
        let list = applications_until(&mut updates, "every application", |l| {
            l.applications.len() == 3
                && l.applications
                    .iter()
                    .find(|a| a.name == "shop")
                    .is_some_and(|a| a.workloads.len() == 2 && a.health == AppHealth::Progressing)
        })
        .await?;
        ensure!(list.notes.is_empty(), "{:?}", list.notes);
        let names: Vec<&str> = list.applications.iter().map(|a| a.name.as_str()).collect();
        ensure!(names == ["kl-app", "redis", "shop"], "{names:?}");
        let helm_app = &list.applications[0];
        ensure!(
            helm_app.source == AppSource::Helm
                && helm_app.managed_by == ["Helm"]
                && helm_app.workloads.len() == 1
                && helm_app.workloads[0].name == "kl-app-app",
            "{helm_app:?}"
        );
        ensure!(list.applications[1].source == AppSource::Name, "{list:?}");
        let shop = &list.applications[2];
        ensure!(
            shop.source == AppSource::Instance
                && shop.components == ["api", "web"]
                && shop.versions == ["1.0"]
                && shop.workloads[0].name == "shop-api"
                && shop.reason.starts_with("Deployment shop-api:"),
            "{shop:?}"
        );

        // Live: without the broken workload, the application is healthy.
        deployments
            .delete("shop-api", &DeleteParams::background())
            .await?;
        applications_until(&mut updates, "shop healthy", |l| {
            l.applications
                .iter()
                .find(|a| a.name == "shop")
                .is_some_and(|a| a.workloads.len() == 1 && a.health == AppHealth::Healthy)
        })
        .await?;
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn limited_user_applications_are_narrowed_with_notes() -> Result<()> {
    let Ok(path) = std::env::var("KUBELOUPE_LIMITED_KUBECONFIG") else {
        eprintln!("KUBELOUPE_LIMITED_KUBECONFIG not set; skipping");
        return Ok(());
    };
    let kubeconfig = kube::config::Kubeconfig::read_from(&path)?;
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    config.proxy_url = None;
    let client = Client::try_from(config)?;
    let prober = Prober::new(client.clone());

    // All namespaces: narrowed to team-a, every application in it.
    let mut all = watch_applications(&client, &prober, &[]);
    let list = applications_until(&mut all, "narrowed list", |_| true).await?;
    ensure!(
        list.notes.len() == 5 && list.notes[0].contains("showing namespace team-a only"),
        "{:?}",
        list.notes
    );
    ensure!(
        list.applications.iter().all(|a| a.namespace == "team-a"),
        "{list:?}"
    );
    // A namespace it may not see: left out, with a note.
    let mut some = watch_applications(
        &client,
        &prober,
        &["team-a".to_string(), "kube-system".to_string()],
    );
    let list = applications_until(&mut some, "picked list", |_| true).await?;
    ensure!(
        list.notes.len() == 5
            && list
                .notes
                .iter()
                .all(|n| n.ends_with("namespace kube-system")),
        "{:?}",
        list.notes
    );
    Ok(())
}
