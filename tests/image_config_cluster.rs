//! Misconfigurations and Kubescape (#538) against the kind cluster: the
//! Trivy Operator's ConfigAuditReport CRD (vendored in
//! `scripts/test-cluster/`, which `setup.sh` applies; applied here too when
//! missing), stand-ins for Kubescape's VulnerabilityManifestSummary and
//! VulnerabilityManifest (`kubescape-storage-crds.yaml`; Kubescape serves
//! them from an aggregated API, not CRDs), and fixture objects in a
//! temporary namespace. No operator runs and no image is pulled.
//!
//! `#[ignore]`d; run with `cargo test --test image_config_cluster --
//! --ignored`. The CRDs stay installed (other runs share them). Nothing
//! here asserts which CRDs the cluster has.

mod common;

use std::future::Future;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject, ListParams, PostParams};
use kube::discovery::ApiResource;
use kube::Client;
use nauvi::image_security::config_audit::{config_detail, workload_configs};
use nauvi::image_security::{
    image_detail_of, image_vulns_from, ScanSource, Severity, VulnsArgs, VulnsState,
};
use serde::Deserialize;
use serde_json::json;

const TIMEOUT: Duration = Duration::from_secs(90);
const CONFIG_CRD: &str = include_str!("../scripts/test-cluster/trivy-configauditreports-crd.yaml");
const KUBESCAPE_CRDS: &str = include_str!("../scripts/test-cluster/kubescape-storage-crds.yaml");

fn context() -> String {
    std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string())
}

async fn connect() -> Result<Client> {
    let ctx = context();
    tokio::time::timeout(
        Duration::from_secs(20),
        nauvi::client_for_context(Some(&ctx)),
    )
    .await
    .context("timed out building client")?
    .with_context(|| format!("cannot connect to context {ctx}"))
}

async fn within<T>(what: &str, f: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(TIMEOUT, f)
        .await
        .with_context(|| format!("{what} timed out"))?
}

/// Install each CRD of `yaml` the cluster lacks; wait until `served`.
async fn ensure_crds<F, Fut>(client: &Client, yaml: &str, served: F) -> Result<()>
where
    F: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    for doc in serde_yaml::Deserializer::from_str(yaml) {
        let value = serde_yaml::Value::deserialize(doc)?;
        if value.is_null() {
            continue;
        }
        let crd: CustomResourceDefinition = serde_yaml::from_value(value)?;
        let name = crd.metadata.name.clone().unwrap_or_default();
        if crds.get_opt(&name).await?.is_none() {
            match crds.create(&PostParams::default(), &crd).await {
                Ok(_) => {}
                Err(kube::Error::Api(e)) if e.code == 409 => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    for _ in 0..60 {
        if served().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!("the CRDs are not served after 60 s")
}

async fn in_temp_ns<F, Fut>(body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    let c = client.clone();
    within(
        "installing the ConfigAuditReport CRD",
        ensure_crds(&client, CONFIG_CRD, || {
            let c = c.clone();
            async move {
                nauvi::image_security::config_audit::served(&c)
                    .await
                    .unwrap_or(false)
            }
        }),
    )
    .await?;
    let c = client.clone();
    within(
        "installing the Kubescape CRDs",
        ensure_crds(&client, KUBESCAPE_CRDS, || {
            let c = c.clone();
            async move {
                nauvi::image_security::kubescape::served(&c)
                    .await
                    .unwrap_or(false)
            }
        }),
    )
    .await?;
    let ns = format!("kl-it-config-{:x}", common::unique_suffix());
    let namespaces: Api<Namespace> = Api::all(client.clone());
    namespaces
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({ "metadata": { "name": ns } }))?,
        )
        .await?;
    let result = body(client.clone(), ns.clone()).await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    result
}

fn api(
    client: &Client,
    ns: &str,
    group: &str,
    version: &str,
    kind: &str,
    plural: &str,
) -> Api<DynamicObject> {
    let ar = ApiResource::from_gvk_with_plural(
        &kube::api::GroupVersionKind::gvk(group, version, kind),
        plural,
    );
    Api::namespaced_with(client.clone(), ns, &ar)
}

fn check(id: &str, severity: &str, success: bool) -> serde_json::Value {
    json!({
        "checkID": id, "title": format!("{id} title"), "severity": severity,
        "category": "Kubernetes Security Check", "description": format!("{id} description"),
        "remediation": format!("Change what {id} says."), "success": success,
        "messages": [format!("Container 'app' should change {id}")],
        "scope": { "type": "Container", "value": "app" }
    })
}

/// A report as the operator writes it for `kind/name`.
fn config_report(
    ns: &str,
    kind: &str,
    name: &str,
    checks: Vec<serde_json::Value>,
) -> Result<DynamicObject> {
    let mut summary =
        json!({ "criticalCount": 0, "highCount": 0, "mediumCount": 0, "lowCount": 0 });
    for c in checks.iter().filter(|c| c["success"] == false) {
        let key = format!(
            "{}Count",
            c["severity"].as_str().unwrap_or("LOW").to_lowercase()
        );
        summary[&key] = json!(summary[&key].as_u64().unwrap_or(0) + 1);
    }
    Ok(serde_json::from_value(json!({
        "apiVersion": "aquasecurity.github.io/v1alpha1",
        "kind": "ConfigAuditReport",
        "metadata": {
            "name": format!("{}-{name}", kind.to_lowercase()),
            "namespace": ns,
            "labels": {
                "trivy-operator.resource.kind": kind,
                "trivy-operator.resource.name": name,
                "trivy-operator.resource.namespace": ns,
            }
        },
        "report": {
            "scanner": { "name": "Trivy", "vendor": "Aqua Security", "version": "0.69.3" },
            "summary": summary,
            "updateTimestamp": jiff::Timestamp::now().to_string(),
            "checks": checks,
        }
    }))?)
}

#[tokio::test]
#[ignore]
async fn config_audit_reports_list_one_row_per_workload() -> Result<()> {
    in_temp_ns(|client, ns| async move {
        // Nothing yet.
        let s = within("workload_configs", workload_configs(&client, Some(&ns))).await?;
        ensure!(s.state == VulnsState::NoReports, "{s:?}");

        // A Deployment whose pods never schedule: its ReplicaSet is what
        // the operator audits.
        let deploys: Api<Deployment> = Api::namespaced(client.clone(), &ns);
        deploys
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "metadata": { "name": "web" },
                    "spec": {
                        "replicas": 1,
                        "selector": { "matchLabels": { "app": "web" } },
                        "template": {
                            "metadata": { "labels": { "app": "web" } },
                            "spec": {
                                "nodeSelector": { "nauvi.test/no-such-node": "true" },
                                "containers": [{ "name": "app", "image": "nginx:1.27" }]
                            }
                        }
                    }
                }))?,
            )
            .await?;
        let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), &ns);
        let mut rs_name = String::new();
        for _ in 0..60 {
            if let Some(rs) = rs_api.list(&ListParams::default()).await?.items.first() {
                rs_name = rs.metadata.name.clone().unwrap_or_default();
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        ensure!(!rs_name.is_empty(), "no ReplicaSet for deploy/web");

        let reports = api(
            &client,
            &ns,
            "aquasecurity.github.io",
            "v1alpha1",
            "ConfigAuditReport",
            "configauditreports",
        );
        let web = config_report(
            &ns,
            "ReplicaSet",
            &rs_name,
            vec![
                check("KSV011", "LOW", false),
                check("KSV014", "HIGH", false),
                check("KSV001", "MEDIUM", false),
                check("KSV012", "MEDIUM", true),
            ],
        )?;
        reports.create(&PostParams::default(), &web).await?;
        let svc = config_report(&ns, "Service", "api", vec![check("KSV100", "LOW", true)])?;
        reports.create(&PostParams::default(), &svc).await?;

        let s = within("workload_configs", workload_configs(&client, Some(&ns))).await?;
        ensure!(s.state == VulnsState::Ok, "{s:?}");
        ensure!(s.workloads.len() == 2, "{s:?}");
        let row = &s.workloads[0];
        // Named after the Deployment, not its ReplicaSet.
        ensure!(
            row.target.kind == "Deployment" && row.target.name == "web",
            "{row:?}"
        );
        ensure!(
            row.failed.high == 1 && row.failed.medium == 1 && row.failed.low == 1,
            "{row:?}"
        );
        ensure!(row.scanner == "Trivy 0.69.3", "{row:?}");
        ensure!(s.workloads[1].target.kind == "Service", "{s:?}");
        ensure!(s.workloads[1].failed.total() == 0, "{s:?}");

        let d = within("config_detail", config_detail(&client, row.clone())).await?;
        ensure!(d.passed == 1, "{d:?}");
        let ids: Vec<_> = d.failed.iter().map(|c| c.id.as_str()).collect();
        ensure!(ids == ["KSV014", "KSV001", "KSV011"], "{ids:?}");
        ensure!(d.failed[0].severity == Severity::High, "{d:?}");
        ensure!(
            d.failed[0].remediation == "Change what KSV014 says.",
            "{d:?}"
        );
        ensure!(d.failed[0].container == "app", "{d:?}");
        ensure!(d.workload.target.name == "web", "{d:?}");
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore]
async fn kubescape_summaries_are_read_and_its_manifest_gives_the_fixes() -> Result<()> {
    in_temp_ns(|client, ns| async move {
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        pods.create(
            &PostParams::default(),
            &serde_json::from_value(json!({
                "metadata": { "name": "web-a" },
                "spec": {
                    "nodeSelector": { "nauvi.test/no-such-node": "true" },
                    "containers": [{ "name": "app", "image": "nginx:1.27" }]
                }
            }))?,
        )
        .await?;
        let args = VulnsArgs {
            namespace: Some(ns.clone()),
            ..Default::default()
        };
        let s = within("image_vulns_from", image_vulns_from(&client, ScanSource::Kubescape, &args)).await?;
        ensure!(s.state == VulnsState::NoReports, "{s:?}");
        ensure!(s.source == ScanSource::Kubescape, "{s:?}");

        let group = "spdx.softwarecomposition.kubescape.io";
        let manifests = api(&client, &ns, group, "v1beta1", "VulnerabilityManifest", "vulnerabilitymanifests");
        manifests
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "apiVersion": format!("{group}/v1beta1"),
                    "kind": "VulnerabilityManifest",
                    "metadata": { "name": "docker.io-library-nginx-1.27-abc", "namespace": ns },
                    "spec": { "payload": { "matches": [
                        { "vulnerability": { "id": "CVE-2026-1", "severity": "Critical",
                            "dataSource": "https://security-tracker.debian.org/tracker/CVE-2026-1",
                            "fix": { "versions": ["3.0.15"], "state": "fixed" } },
                          "artifact": { "name": "openssl", "version": "3.0.11" } },
                        { "vulnerability": { "id": "CVE-2026-2", "severity": "High", "fix": { "state": "not-fixed" } },
                          "artifact": { "name": "zlib", "version": "1.2" } },
                        { "vulnerability": { "id": "CVE-2026-3", "severity": "Negligible", "fix": { "state": "wont-fix" } },
                          "artifact": { "name": "tar", "version": "1.34" } }
                    ] } }
                }))?,
            )
            .await?;
        let summaries = api(&client, &ns, group, "v1beta1", "VulnerabilityManifestSummary", "vulnerabilitymanifestsummaries");
        summaries
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "apiVersion": format!("{group}/v1beta1"),
                    "kind": "VulnerabilityManifestSummary",
                    "metadata": {
                        "name": "pod-web-a-app",
                        "namespace": ns,
                        "labels": {
                            "kubescape.io/workload-kind": "pod",
                            "kubescape.io/workload-name": "web-a",
                            "kubescape.io/workload-namespace": ns,
                            "kubescape.io/workload-container-name": "app"
                        },
                        "annotations": {
                            "kubescape.io/image-tag": "nginx:1.27",
                            "kubescape.io/timestamp": jiff::Timestamp::now().as_second().to_string()
                        }
                    },
                    "spec": {
                        "severities": { "critical": { "all": 1 }, "high": { "all": 1 }, "negligible": { "all": 1 } },
                        "vulnerabilitiesRef": { "all": { "kind": "VulnerabilityManifest",
                            "name": "docker.io-library-nginx-1.27-abc", "namespace": ns } }
                    }
                }))?,
            )
            .await?;

        let s = within("image_vulns_from", image_vulns_from(&client, ScanSource::Kubescape, &args)).await?;
        ensure!(s.state == VulnsState::Ok, "{s:?}");
        ensure!(s.images.len() == 1, "{s:?}");
        let row = s.images[0].clone();
        ensure!(row.source == ScanSource::Kubescape && row.scanned, "{row:?}");
        ensure!(row.image == "nginx:1.27", "{row:?}");
        ensure!(row.counts.critical == 1 && row.counts.high == 1 && row.counts.low == 1, "{row:?}");
        ensure!(!row.fixes_known, "{row:?}");
        ensure!(row.workloads[0].name == "web-a", "{row:?}");

        let d = within("image_detail_of", image_detail_of(&client, row, &VulnsArgs::default())).await?;
        ensure!(d.vulnerabilities.len() == 3, "{d:?}");
        ensure!(d.image.fixes_known && d.image.fixable.critical == 1, "{d:?}");
        ensure!(d.fix_groups[0].package == "openssl", "{d:?}");
        ensure!(d.fix_groups[0].fixed_in == ["3.0.15"], "{d:?}");
        ensure!(
            d.vulnerabilities[0].link == "https://security-tracker.debian.org/tracker/CVE-2026-1",
            "{d:?}"
        );
        Ok(())
    })
    .await
}
