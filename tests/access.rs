//! Integration tests of the Access Control kinds, PodDisruptionBudgets and
//! CRD definitions against the kind cluster: their columns, detail sections
//! and the CLI's `get` / `describe`. `#[ignore]`d like `cluster.rs`; run with
//! `cargo test --test access -- --ignored`.
//!
//! Namespaced objects go in a temporary namespace. The cluster-scoped ones
//! (a ClusterRole, a ClusterRoleBinding, a CRD) have unique names and are
//! deleted afterwards whatever happens.

mod common;

use std::future::Future;
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject, Patch, PatchParams, PostParams};
use kube::Client;
use nauvi::client_for_context;
use nauvi::resources::{self, Category, Related, RelatedGroup, ResourceKind, ResourceRow};
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(120);

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

/// A name no other test run uses.
fn unique(prefix: &str) -> String {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let suffix = common::unique_suffix();
    format!("{prefix}-{suffix:x}-{seq}")
}

/// Run `body` in a fresh namespace, deleting it afterwards even on error.
async fn in_temp_ns<F, Fut>(prefix: &str, body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    let ns = unique(prefix);
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let obj: Namespace = serde_json::from_value(json!({
        "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": ns }
    }))?;
    namespaces.create(&PostParams::default(), &obj).await?;
    let result = tokio::time::timeout(Duration::from_secs(300), body(client.clone(), ns.clone()))
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("test timed out")));
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

async fn eventually<T, Fut: Future<Output = Result<Option<T>>>>(
    what: &str,
    mut f: impl FnMut() -> Fut,
) -> Result<T> {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if let Some(v) = f().await? {
            return Ok(v);
        }
        if tokio::time::Instant::now() > deadline {
            bail!("timed out after {TIMEOUT:?} waiting for: {what}");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn kinds(client: &Client) -> Result<Vec<ResourceKind>> {
    resources::discover(client).await
}

fn kind_named(kinds: &[ResourceKind], name: &str) -> Result<ResourceKind> {
    resources::resolve_kind(kinds, name)
        .cloned()
        .with_context(|| format!("discovery has no kind {name}"))
}

/// Create (server-side apply) `obj`, an object of `kind`.
async fn apply(client: &Client, kind: &ResourceKind, ns: &str, obj: Value) -> Result<()> {
    let name = obj["metadata"]["name"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let api = resources::dyn_api(client, &kind.resource, Some(ns));
    let obj: DynamicObject = serde_json::from_value(obj)?;
    api.patch(
        &name,
        &PatchParams::apply("nauvi-it").force(),
        &Patch::Apply(&obj),
    )
    .await
    .with_context(|| format!("creating {} {name}", kind.resource.kind))?;
    Ok(())
}

async fn delete(client: &Client, kind: &ResourceKind, name: &str) {
    let api = resources::dyn_api(client, &kind.resource, None);
    let _ = api.delete(name, &DeleteParams::default()).await;
}

fn group<'a>(r: &'a Related, title: &str) -> Result<&'a RelatedGroup> {
    r.groups
        .iter()
        .find(|g| g.title == title)
        .with_context(|| format!("no related group {title:?} in {r:?}"))
}

fn names(g: &RelatedGroup) -> Vec<String> {
    g.items.iter().map(|i| i.name.clone()).collect()
}

/// The cell of `row` under the column labelled `label`.
fn cell(kind: &ResourceKind, row: &ResourceRow, label: &str) -> Result<String> {
    let i = kind
        .columns
        .iter()
        .position(|c| c.label == label)
        .with_context(|| format!("{} has no column {label}", kind.resource.kind))?;
    Ok(row.cells[i].clone())
}

async fn row(
    client: &Client,
    kind: &ResourceKind,
    ns: Option<&str>,
    name: &str,
) -> Result<ResourceRow> {
    resources::list_resources(client, kind, ns)
        .await?
        .into_iter()
        .find(|r| r.name == name)
        .with_context(|| format!("no {} {name} in the list", kind.resource.kind))
}

fn nauvi(args: &[&str]) -> Result<String> {
    let ctx = context();
    let out = Command::new(env!("CARGO_BIN_EXE_nauvi"))
        .args(["--context", &ctx])
        .args(args)
        .output()?;
    ensure!(
        out.status.success(),
        "{args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(String::from_utf8(out.stdout)?)
}

#[tokio::test]
#[ignore]
async fn access_kinds_sit_in_their_sidebar_groups() -> Result<()> {
    let client = connect().await?;
    let kinds = kinds(&client).await?;
    for (name, label, category) in [
        ("serviceaccounts", "Service Accounts", Category::Access),
        ("roles", "Roles", Category::Access),
        ("clusterroles", "Cluster Roles", Category::Access),
        ("rolebindings", "Role Bindings", Category::Access),
        (
            "clusterrolebindings",
            "Cluster Role Bindings",
            Category::Access,
        ),
        (
            "poddisruptionbudgets",
            "Pod Disruption Budgets",
            Category::Config,
        ),
        ("priorityclasses", "Priority Classes", Category::Config),
        ("runtimeclasses", "Runtime Classes", Category::Config),
        ("leases", "Leases", Category::Config),
        (
            "mutatingwebhookconfigurations",
            "Mutating Webhook Configs",
            Category::Config,
        ),
        (
            "validatingwebhookconfigurations",
            "Validating Webhook Configs",
            Category::Config,
        ),
        (
            "validatingadmissionpolicies",
            "Validating Admission Policies",
            Category::Config,
        ),
        (
            "validatingadmissionpolicybindings",
            "Validating Admission Policy Bindings",
            Category::Config,
        ),
        ("ingressclasses", "Ingress Classes", Category::Network),
        ("customresourcedefinitions", "Definitions", Category::Custom),
    ] {
        let k = kind_named(&kinds, name)?;
        ensure!(k.label == label, "{name}: {}", k.label);
        ensure!(k.category == category, "{name}: {:?}", k.category);
        ensure!(!k.crd, "{name} is built in");
    }
    // Dynamic Resource Allocation (resource.k8s.io, GA in 1.34) has its own
    // group, on the clusters that serve it.
    for (name, label) in [
        ("deviceclasses", "Device Classes"),
        ("resourceclaims", "Resource Claims"),
        ("resourceclaimtemplates", "Resource Claim Templates"),
        ("resourceslices", "Resource Slices"),
    ] {
        let Ok(k) = kind_named(&kinds, name) else {
            eprintln!("{name} not served: skipping");
            continue;
        };
        ensure!(k.label == label, "{name}: {}", k.label);
        ensure!(k.category == Category::Devices, "{name}: {:?}", k.category);
    }
    // The control plane's leases have holders.
    let leases = kind_named(&kinds, "leases")?;
    let rows = resources::list_resources(&client, &leases, Some("kube-node-lease")).await?;
    let lease = rows.first().context("no node leases")?;
    ensure!(!cell(&leases, lease, "Holder")?.is_empty(), "{lease:?}");
    // The built-in system ClusterRoles list their rules.
    let cr = kind_named(&kinds, "clusterroles")?;
    let view = row(&client, &cr, None, "view").await?;
    ensure!(cell(&cr, &view, "Rules")?.parse::<u32>()? > 0, "{view:?}");
    Ok(())
}

#[tokio::test]
#[ignore]
async fn role_binding_and_service_account_link_each_other() -> Result<()> {
    in_temp_ns("kl-rbac", |client, ns| async move {
        let kinds = kinds(&client).await?;
        let sa = kind_named(&kinds, "serviceaccounts")?;
        let role = kind_named(&kinds, "roles")?;
        let rb = kind_named(&kinds, "rolebindings")?;
        let cr = kind_named(&kinds, "clusterroles")?;
        let crb = kind_named(&kinds, "clusterrolebindings")?;
        let cluster_role = unique("kl-it-reader");

        apply(&client, &sa, &ns, json!({
            "apiVersion": "v1", "kind": "ServiceAccount",
            "metadata": { "name": "app", "namespace": ns },
            "imagePullSecrets": [{ "name": "registry" }]
        })).await?;
        apply(&client, &role, &ns, json!({
            "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
            "metadata": { "name": "pod-reader", "namespace": ns },
            "rules": [
                { "apiGroups": [""], "resources": ["pods", "pods/log"], "verbs": ["get", "list"] },
                { "apiGroups": ["apps"], "resources": ["deployments"], "resourceNames": ["web"], "verbs": ["patch"] }
            ]
        })).await?;
        apply(&client, &rb, &ns, json!({
            "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
            "metadata": { "name": "app-reads-pods", "namespace": ns },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "pod-reader" },
            "subjects": [
                { "kind": "ServiceAccount", "name": "app" },
                { "kind": "User", "name": "alice", "apiGroup": "rbac.authorization.k8s.io" }
            ]
        })).await?;
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        pods.create(&PostParams::default(), &serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "runs-as-app" },
            "spec": {
                "serviceAccountName": "app",
                "terminationGracePeriodSeconds": 0,
                "containers": [{ "name": "c", "image": "registry.k8s.io/pause:3.10" }]
            }
        }))?).await?;

        // Cluster-scoped: a ClusterRole granted by a ClusterRoleBinding and
        // by a RoleBinding in the namespace. Deleted whatever happens.
        let result = async {
            apply(&client, &cr, "", json!({
                "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
                "metadata": { "name": cluster_role },
                "rules": [{ "nonResourceURLs": ["/healthz"], "verbs": ["get"] }]
            })).await?;
            apply(&client, &crb, "", json!({
                "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
                "metadata": { "name": cluster_role },
                "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": cluster_role },
                "subjects": [{ "kind": "ServiceAccount", "name": "app", "namespace": ns }]
            })).await?;
            apply(&client, &rb, &ns, json!({
                "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
                "metadata": { "name": "app-healthz", "namespace": ns },
                "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": cluster_role },
                "subjects": [{ "kind": "Group", "name": "devs", "apiGroup": "rbac.authorization.k8s.io" }]
            })).await?;

            // Columns.
            let r = row(&client, &role, Some(&ns), "pod-reader").await?;
            ensure!(cell(&role, &r, "Rules")? == "2", "{r:?}");
            let b = row(&client, &rb, Some(&ns), "app-reads-pods").await?;
            ensure!(cell(&rb, &b, "Role")? == "Role/pod-reader", "{b:?}");
            ensure!(
                cell(&rb, &b, "Subjects")? == format!("ServiceAccount:{ns}/app,User:alice"),
                "{b:?}"
            );
            let c = row(&client, &crb, None, &cluster_role).await?;
            ensure!(cell(&crb, &c, "Role")? == format!("ClusterRole/{cluster_role}"), "{c:?}");

            // Role: its rules and the binding that grants it.
            let rel = resources::get_related(&client, &role.resource, &ns, "pod-reader").await?;
            ensure!(rel.summary == ["2 rules"], "{:?}", rel.summary);
            let rules = group(&rel, "Rules")?;
            ensure!(
                rules.items[0].cells == ["core", "pods, pods/log", "all", "get, list"],
                "{rules:?}"
            );
            ensure!(rules.items[1].cells[2] == "web", "{rules:?}");
            ensure!(names(group(&rel, "Role bindings")?) == ["app-reads-pods"]);

            // RoleBinding: a link to the Role, the account as a link, the user.
            let rel = resources::get_related(&client, &rb.resource, &ns, "app-reads-pods").await?;
            let r = group(&rel, "Role")?;
            ensure!(
                (r.kind.as_str(), r.items[0].name.as_str(), r.items[0].namespace.as_str())
                    == ("Role", "pod-reader", ns.as_str()),
                "{r:?}"
            );
            let accounts = group(&rel, "Service accounts")?;
            ensure!(accounts.kind == "ServiceAccount" && names(accounts) == ["app"]);
            ensure!(accounts.items[0].namespace == ns);
            ensure!(group(&rel, "Users and groups")?.items[0].cells == ["User", "alice"]);

            // ServiceAccount: the bindings that reference it and its pods.
            let rel = eventually("the account's pod", || async {
                let r = resources::get_related(&client, &sa.resource, &ns, "app").await?;
                Ok(group(&r, "Pods").is_ok_and(|g| !g.items.is_empty()).then_some(r))
            })
            .await?;
            ensure!(names(group(&rel, "Pods")?) == ["runs-as-app"]);
            ensure!(names(group(&rel, "Role bindings")?) == ["app-reads-pods"]);
            ensure!(names(group(&rel, "Cluster role bindings")?) == std::slice::from_ref(&cluster_role));
            ensure!(group(&rel, "Secrets")?.items[0].cells == ["registry", "image pull"]);

            // ClusterRole: granted cluster-wide and in the namespace.
            let rel = resources::get_related(&client, &cr.resource, "", &cluster_role).await?;
            ensure!(group(&rel, "Rules")?.columns[3] == "Non-resource URLs");
            ensure!(names(group(&rel, "Cluster role bindings")?) == std::slice::from_ref(&cluster_role));
            let rbs = group(&rel, "Role bindings")?;
            ensure!(names(rbs) == ["app-healthz"], "{rbs:?}");
            ensure!(rbs.items[0].cells[1] == ns, "{rbs:?}");

            // The CLI gets both from the registry.
            let out = nauvi(&["get", "roles", "-n", &ns])?;
            let header = out.lines().next().unwrap_or_default();
            ensure!(header.contains("RULES"), "{out}");
            ensure!(out.contains("pod-reader"), "{out}");
            let out = nauvi(&["describe", &format!("clusterrole/{cluster_role}")])?;
            for want in ["Rules:", "/healthz", "Cluster role bindings:", "app-healthz"] {
                ensure!(out.contains(want), "no {want:?} in:\n{out}");
            }
            Ok(())
        }
        .await;
        delete(&client, &crb, &cluster_role).await;
        delete(&client, &cr, &cluster_role).await;
        result
    })
    .await
}

#[tokio::test]
#[ignore]
async fn pod_disruption_budget_shows_its_pods_and_status() -> Result<()> {
    in_temp_ns("kl-pdb", |client, ns| async move {
        let kinds = kinds(&client).await?;
        let pdb = kind_named(&kinds, "pdb")?;
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        for name in ["guarded-1", "guarded-2"] {
            pods.create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "apiVersion": "v1", "kind": "Pod",
                    "metadata": { "name": name, "labels": { "app": "guarded" } },
                    "spec": {
                        "terminationGracePeriodSeconds": 0,
                        "containers": [{ "name": "c", "image": "registry.k8s.io/pause:3.10" }]
                    }
                }))?,
            )
            .await?;
        }
        apply(
            &client,
            &pdb,
            &ns,
            json!({
                "apiVersion": "policy/v1", "kind": "PodDisruptionBudget",
                "metadata": { "name": "guard", "namespace": ns },
                "spec": { "minAvailable": 1, "selector": { "matchLabels": { "app": "guarded" } } }
            }),
        )
        .await?;

        // The disruption controller fills in the status once both run.
        let r = eventually("the PDB to allow one disruption", || async {
            let r = row(&client, &pdb, Some(&ns), "guard").await?;
            Ok((cell(&pdb, &r, "Allowed Disruptions")? == "1").then_some(r))
        })
        .await?;
        ensure!(cell(&pdb, &r, "Min Available")? == "1", "{r:?}");
        ensure!(cell(&pdb, &r, "Max Unavailable")? == "N/A", "{r:?}");
        ensure!(cell(&pdb, &r, "Current Healthy")? == "2", "{r:?}");
        ensure!(cell(&pdb, &r, "Desired Healthy")? == "1", "{r:?}");

        let rel = resources::get_related(&client, &pdb.resource, &ns, "guard").await?;
        ensure!(
            rel.summary == ["1 disruption allowed", "2/1 healthy"],
            "{:?}",
            rel.summary
        );
        ensure!(names(group(&rel, "Pods")?) == ["guarded-1", "guarded-2"]);
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn crd_definitions_list_versions_and_printer_columns() -> Result<()> {
    let client = connect().await?;
    let group_name = format!("{}.example.com", unique("kl77"));
    let name = format!("gizmos.{group_name}");
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd: CustomResourceDefinition = serde_json::from_value(json!({
        "apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
        "metadata": { "name": name },
        "spec": {
            "group": group_name, "scope": "Cluster",
            "names": { "plural": "gizmos", "singular": "gizmo", "kind": "Gizmo" },
            "versions": [{
                "name": "v1", "served": true, "storage": true,
                "schema": { "openAPIV3Schema": { "type": "object", "x-kubernetes-preserve-unknown-fields": true } },
                "additionalPrinterColumns": [{ "name": "Size", "type": "integer", "jsonPath": ".spec.size" }]
            }]
        }
    }))?;
    crds.create(&PostParams::default(), &crd).await?;
    let result = async {
        let kinds = kinds(&client).await?;
        let defs = kind_named(&kinds, "crds")?;
        let r = row(&client, &defs, None, &name).await?;
        ensure!(cell(&defs, &r, "Kind")? == "Gizmo", "{r:?}");
        ensure!(cell(&defs, &r, "Group")? == group_name, "{r:?}");
        ensure!(cell(&defs, &r, "Version")? == "v1", "{r:?}");
        ensure!(cell(&defs, &r, "Scope")? == "Cluster", "{r:?}");

        let rel = resources::get_related(&client, &defs.resource, "", &name).await?;
        ensure!(
            rel.summary == ["Gizmo", "Cluster", "1 version"],
            "{:?}",
            rel.summary
        );
        ensure!(group(&rel, "Versions")?.items[0].cells == ["v1", "yes", "yes", "no"]);
        ensure!(
            group(&rel, "Printer columns")?.items[0].cells
                == ["v1", "Size", "integer", ".spec.size", "0"]
        );
        Ok(())
    }
    .await;
    let _ = crds.delete(&name, &DeleteParams::default()).await;
    result
}
