//! Image vulnerabilities (#533) against the kind cluster: only the Trivy
//! Operator's VulnerabilityReport CRD (vendored in
//! `scripts/test-cluster/`, which `setup.sh` applies; applied here too when
//! missing) and fixture reports in a temporary namespace. No operator runs
//! and no image is pulled: the pod never schedules.
//!
//! `#[ignore]`d; run with `cargo test --test image_security_cluster --
//! --ignored`. The CRD stays installed (other runs share it).

mod common;

use std::future::Future;
use std::process::Command;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject, PostParams};
use kube::discovery::ApiResource;
use kube::Client;
use nauvi::image_security::{
    image_detail, image_vulns, trivy_operator, Severity, VulnsArgs, VulnsState,
};
use serde_json::json;

const TIMEOUT: Duration = Duration::from_secs(90);
const CRD_YAML: &str = include_str!("../scripts/test-cluster/trivy-vulnerabilityreports-crd.yaml");

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

/// Install the CRD if the cluster has none, and wait until it is served.
async fn ensure_crd(client: &Client) -> Result<()> {
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let crd: CustomResourceDefinition = serde_yaml::from_str(CRD_YAML)?;
    let name = crd.metadata.name.clone().unwrap_or_default();
    if crds.get_opt(&name).await?.is_none() {
        match crds.create(&PostParams::default(), &crd).await {
            Ok(_) => {}
            // Another test run created it meanwhile.
            Err(kube::Error::Api(e)) if e.code == 409 => {}
            Err(e) => return Err(e.into()),
        }
    }
    for _ in 0..60 {
        if trivy_operator::served(client).await.unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!("{name} is not served after 60 s")
}

async fn in_temp_ns<F, Fut>(body: F) -> Result<()>
where
    F: FnOnce(Client, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let client = connect().await?;
    within("installing the CRD", ensure_crd(&client)).await?;
    let ns = format!("kl-it-vulns-{:x}", common::unique_suffix());
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

/// A pod that never schedules, so its image is never pulled.
fn unschedulable_pod(name: &str, image: &str) -> Result<Pod> {
    Ok(serde_json::from_value(json!({
        "metadata": { "name": name },
        "spec": {
            "nodeSelector": { "nauvi.test/no-such-node": "true" },
            "containers": [{ "name": "app", "image": image }]
        }
    }))?)
}

fn vuln(id: &str, package: &str, severity: &str, fixed: &str) -> serde_json::Value {
    json!({
        "vulnerabilityID": id, "resource": package, "installedVersion": "1.0",
        "fixedVersion": fixed, "severity": severity, "score": 7.5,
        "title": format!("{package}: {id}"), "primaryLink": "",
        "lastModifiedDate": "2026-01-01T00:00:00Z", "publishedDate": "2026-01-01T00:00:00Z"
    })
}

/// A report as the operator writes it for `kind/name`, container `app`.
fn report(
    ns: &str,
    kind: &str,
    name: &str,
    repository: &str,
    tag: &str,
    vulns: Vec<serde_json::Value>,
) -> Result<DynamicObject> {
    let mut summary = json!({ "criticalCount": 0, "highCount": 0, "mediumCount": 0,
        "lowCount": 0, "unknownCount": 0, "noneCount": 0 });
    for v in &vulns {
        let key = format!(
            "{}Count",
            v["severity"].as_str().unwrap_or("UNKNOWN").to_lowercase()
        );
        summary[&key] = json!(summary[&key].as_u64().unwrap_or(0) + 1);
    }
    Ok(serde_json::from_value(json!({
        "apiVersion": "aquasecurity.github.io/v1alpha1",
        "kind": "VulnerabilityReport",
        "metadata": {
            "name": format!("{}-{name}-app", kind.to_lowercase()),
            "namespace": ns,
            "labels": {
                "trivy-operator.resource.kind": kind,
                "trivy-operator.resource.name": name,
                "trivy-operator.resource.namespace": ns,
                "trivy-operator.container.name": "app",
            }
        },
        "report": {
            "artifact": { "repository": repository, "tag": tag },
            "os": { "family": "debian", "name": "12" },
            "registry": { "server": "index.docker.io" },
            "scanner": { "name": "Trivy", "vendor": "Aqua Security", "version": "0.58.1" },
            "summary": summary,
            "updateTimestamp": jiff::Timestamp::now().to_string(),
            "vulnerabilities": vulns,
        }
    }))?)
}

fn args(ns: &str) -> VulnsArgs {
    VulnsArgs {
        namespace: Some(ns.to_string()),
        ..Default::default()
    }
}

fn nauvi(args: &[&str]) -> std::process::Output {
    let ctx = context();
    Command::new(env!("CARGO_BIN_EXE_nauvi"))
        .args(["--context", &ctx])
        .args(args)
        .output()
        .expect("run nauvi")
}

#[tokio::test]
#[ignore]
async fn vulnerability_reports_list_one_row_per_image() -> Result<()> {
    in_temp_ns(|client, ns| async move {
        let pods: Api<Pod> = Api::namespaced(client.clone(), &ns);
        for name in ["web-a", "web-b"] {
            pods.create(
                &PostParams::default(),
                &unschedulable_pod(name, "nginx:1.27")?,
            )
            .await?;
        }

        // The CRD, no reports yet.
        let s = within("image_vulns", image_vulns(&client, &args(&ns))).await?;
        ensure!(s.state == VulnsState::NoReports, "{s:?}");
        ensure!(s.unscanned == 1, "{s:?}");
        ensure!(s.images.len() == 1 && !s.images[0].scanned, "{s:?}");

        // A report for each pod (joined by workload: they have no digest
        // yet) and one for a workload without pods.
        let ar = ApiResource::from_gvk_with_plural(
            &kube::api::GroupVersionKind::gvk(
                "aquasecurity.github.io",
                "v1alpha1",
                "VulnerabilityReport",
            ),
            "vulnerabilityreports",
        );
        let reports: Api<DynamicObject> = Api::namespaced_with(client.clone(), &ns, &ar);
        let web = vec![
            vuln("CVE-2026-1001", "openssl", "CRITICAL", "3.0.15"),
            vuln("CVE-2026-1002", "openssl", "HIGH", "3.0.14"),
            vuln("CVE-2026-1003", "zlib", "LOW", ""),
        ];
        for pod in ["web-a", "web-b"] {
            let r = report(&ns, "Pod", pod, "library/nginx", "1.27", web.clone())?;
            reports.create(&PostParams::default(), &r).await?;
        }
        let gone = report(
            &ns,
            "ReplicaSet",
            "gone-5f6b",
            "library/redis",
            "7",
            vec![vuln("CVE-2026-2001", "redis", "MEDIUM", "")],
        )?;
        reports.create(&PostParams::default(), &gone).await?;

        let s = within("image_vulns", image_vulns(&client, &args(&ns))).await?;
        ensure!(s.state == VulnsState::Ok, "{s:?}");
        let images: Vec<_> = s.images.iter().map(|r| r.image.as_str()).collect();
        ensure!(images == ["nginx:1.27", "redis:7"], "{images:?}");
        let nginx = &s.images[0];
        ensure!(nginx.scanned && nginx.reports == 2, "{nginx:?}");
        ensure!(
            nginx.counts.critical == 1 && nginx.counts.high == 1,
            "{nginx:?}"
        );
        ensure!(nginx.fixable.total() == 2, "{nginx:?}");
        let workloads: Vec<_> = nginx.workloads.iter().map(|w| w.name.as_str()).collect();
        ensure!(workloads == ["web-a", "web-b"], "{workloads:?}");
        ensure!(s.images[1].workloads[0].kind == "ReplicaSet", "{s:?}");

        // Filters.
        let high = VulnsArgs {
            severity: Some(Severity::High),
            ..args(&ns)
        };
        let s = within("image_vulns", image_vulns(&client, &high)).await?;
        ensure!(
            s.images.len() == 1 && s.images[0].image == "nginx:1.27",
            "{s:?}"
        );
        let fixable = VulnsArgs {
            fixable: true,
            ..args(&ns)
        };
        let s = within("image_vulns", image_vulns(&client, &fixable)).await?;
        ensure!(s.images.len() == 1, "{s:?}");

        // One image: its full report, fixes by package.
        let d = within(
            "image_detail",
            image_detail(&client, &args(&ns), "nginx:1.27"),
        )
        .await?;
        ensure!(d.vulnerabilities.len() == 3, "{d:?}");
        ensure!(d.fix_groups[0].package == "openssl", "{d:?}");
        ensure!(d.fix_groups[0].fixed_in == ["3.0.14", "3.0.15"], "{d:?}");

        // The CLI: a table, stable JSON, the detail.
        let out = nauvi(&["vulns", "-n", &ns]);
        let text = String::from_utf8_lossy(&out.stdout);
        ensure!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        ensure!(text.starts_with("IMAGE"), "{text}");
        ensure!(text.contains("pod/web-a, pod/web-b"), "{text}");
        let out = nauvi(&["vulns", "-n", &ns, "-o", "json", "--severity", "critical"]);
        ensure!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
        ensure!(v["state"] == "ok", "{v}");
        ensure!(v["namespace"] == ns.as_str(), "{v}");
        ensure!(v["images"].as_array().map(Vec::len) == Some(1), "{v}");
        ensure!(v["images"][0]["counts"]["critical"] == 1, "{v}");
        ensure!(v["images"][0]["fixable"]["high"] == 1, "{v}");
        let out = nauvi(&["vulns", "nginx:1.27", "-n", &ns]);
        let text = String::from_utf8_lossy(&out.stdout);
        ensure!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        ensure!(text.contains("Fixes by package:"), "{text}");
        let out = nauvi(&["vulns", "nope:1", "-n", &ns]);
        ensure!(!out.status.success());
        ensure!(
            String::from_utf8_lossy(&out.stderr).contains("No image \"nope:1\""),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(())
    })
    .await
}

/// The namespace-scoped user (`scripts/test-cluster/limited-user.sh`):
/// `edit` does not cover the operator's reports, so it is not allowed.
/// Skips unless NAUVI_LIMITED_KUBECONFIG is set.
#[tokio::test]
#[ignore]
async fn a_limited_user_is_told_it_may_not_list_reports() -> Result<()> {
    let Ok(path) = std::env::var("NAUVI_LIMITED_KUBECONFIG") else {
        eprintln!("NAUVI_LIMITED_KUBECONFIG not set; skipping");
        return Ok(());
    };
    within("installing the CRD", ensure_crd(&connect().await?)).await?;
    let kubeconfig = kube::config::Kubeconfig::read_from(&path)?;
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &Default::default()).await?;
    config.proxy_url = None;
    let client = Client::try_from(config)?;
    for namespace in [Some("team-a".to_string()), None] {
        let a = VulnsArgs {
            namespace,
            ..Default::default()
        };
        let s = within("image_vulns", image_vulns(&client, &a)).await?;
        ensure!(s.state == VulnsState::Forbidden, "{s:?}");
    }
    let out = Command::new(env!("CARGO_BIN_EXE_nauvi"))
        .args(["--kubeconfig", &path, "vulns", "-n", "team-a"])
        .output()?;
    ensure!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    ensure!(
        err.contains("Not allowed to list VulnerabilityReports"),
        "{err}"
    );
    Ok(())
}
