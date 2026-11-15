//! Installing a chart and upgrading a release through the `helm` CLI, with
//! the user's values on stdin (`--values -`), optionally as a server-side
//! dry run that renders the manifest without changing the cluster.

use super::command::release_failure;
use super::command::{check_namespace, run_helm_with_input, HelmTarget};
use super::decode::StoredRelease;
use super::repo::check_word;
use super::{check_release_name, manifest_resources, redact_manifest, HelmResource, HelmStorage};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// What to install or upgrade, and how.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmDeployRequest {
    /// The release name.
    pub name: String,
    pub namespace: String,
    /// `repo/chart` (or a chart directory or archive, from the CLI).
    pub chart: String,
    /// The chart version; empty for the newest.
    pub version: String,
    /// The user values as YAML: on an upgrade they replace the release's
    /// values (`--reset-values`). Empty: the chart defaults.
    pub values: String,
    /// Install only: create the namespace if it does not exist.
    pub create_namespace: bool,
    /// Render and validate against the cluster (`--dry-run=server`) without
    /// changing anything.
    pub dry_run: bool,
    /// Show Secret values in the returned manifest.
    pub reveal: bool,
    /// Where helm keeps the release (`HELM_DRIVER`): on an upgrade, where
    /// it is stored now; on an install, Secrets (helm's default) or ConfigMaps.
    pub storage: HelmStorage,
}

/// The release helm installed, upgraded or (dry run) would have.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HelmDeployResult {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    /// `deployed`, or `pending-install` / `pending-upgrade` for a dry run.
    pub status: String,
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    pub notes: String,
    /// The rendered manifest (without hooks, like a stored release's);
    /// Secret values hidden unless revealed.
    pub manifest: String,
    pub secrets_hidden: bool,
    pub resources: Vec<HelmResource>,
    pub dry_run: bool,
    /// One line for a notice.
    pub summary: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Install,
    Upgrade,
}

/// The values text checked to be a YAML mapping (or empty).
fn check_values(values: &str) -> Result<()> {
    if values.trim().is_empty() {
        return Ok(());
    }
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(values).map_err(|e| anyhow!("The values are not valid YAML: {e}"))?;
    match parsed {
        serde_yaml::Value::Mapping(_) | serde_yaml::Value::Null => Ok(()),
        _ => bail!("The values must be a YAML mapping (key: value), not a single value or a list"),
    }
}

fn check_request(req: &HelmDeployRequest) -> Result<()> {
    check_release_name(&req.name)?;
    check_namespace(&req.namespace)?;
    check_word("chart", &req.chart)?;
    if !req.version.is_empty() {
        check_word("chart version", &req.version)?;
    }
    check_values(&req.values)
}

fn deploy_args(mode: Mode, target: &HelmTarget, req: &HelmDeployRequest) -> Vec<String> {
    let verb = match mode {
        Mode::Install => "install",
        Mode::Upgrade => "upgrade",
    };
    let mut args: Vec<String> = vec![verb.into(), req.name.clone(), req.chart.clone()];
    args.extend(["--namespace".into(), req.namespace.clone()]);
    if !req.version.is_empty() {
        args.extend(["--version".into(), req.version.clone()]);
    }
    if !req.values.trim().is_empty() {
        args.extend(["--values".into(), "-".into()]);
    }
    match mode {
        Mode::Install if req.create_namespace => args.push("--create-namespace".into()),
        Mode::Install => {}
        // The edited values are the whole of the user values.
        Mode::Upgrade => args.push("--reset-values".into()),
    }
    if req.dry_run {
        args.push("--dry-run=server".into());
    }
    args.extend(["--output".into(), "json".into()]);
    args.extend(target.args());
    args
}

fn result_from(out: &str, req: &HelmDeployRequest, mode: Mode) -> Result<HelmDeployResult> {
    let r: StoredRelease =
        serde_json::from_str(out).context("cannot read the release helm printed")?;
    let (manifest, secrets_hidden) = if req.reveal {
        (r.manifest.clone(), false)
    } else {
        redact_manifest(&r.manifest)
    };
    let resources = manifest_resources(&r.manifest, &req.namespace);
    let what = format!("{}/{}", req.namespace, req.name);
    let summary = match (req.dry_run, mode) {
        (true, _) => format!(
            "Dry run of {what}: {} objects, nothing changed",
            resources.len()
        ),
        (false, Mode::Install) => format!("Installed {what} (revision {})", r.version),
        (false, Mode::Upgrade) => format!("Upgraded {what} to revision {}", r.version),
    };
    Ok(HelmDeployResult {
        name: r.name,
        namespace: r.namespace,
        revision: r.version,
        status: r.info.status,
        chart: r.chart.metadata.name,
        chart_version: r.chart.metadata.version,
        app_version: r.chart.metadata.app_version,
        notes: r.info.notes,
        manifest,
        secrets_hidden,
        resources,
        dry_run: req.dry_run,
        summary,
    })
}

async fn deploy(
    mode: Mode,
    target: &HelmTarget,
    req: &HelmDeployRequest,
) -> Result<HelmDeployResult> {
    check_request(req)?;
    let input = (!req.values.trim().is_empty()).then_some(req.values.as_str());
    let verb = match (mode, req.dry_run) {
        (Mode::Install, false) => "Install",
        (Mode::Upgrade, false) => "Upgrade",
        (Mode::Install, true) => "Dry run of the install",
        (Mode::Upgrade, true) => "Dry run of the upgrade",
    };
    let args = deploy_args(mode, target, req);
    let out = run_helm_with_input(&args, input, Some(req.storage))
        .await
        .map_err(|e| {
            let why = match mode {
                Mode::Install => plain_failure(&e),
                Mode::Upgrade => {
                    release_failure(&plain_failure(&e), &req.namespace, &req.name, req.storage)
                }
            };
            anyhow!("{verb} of {} failed: {why}", req.name)
        })?;
    result_from(&out, req, mode)
}

/// Helm's error without its `INSTALLATION FAILED: ` / `UPGRADE FAILED: `
/// prefix, which the caller's own words replace.
fn plain_failure(e: &anyhow::Error) -> String {
    let text = format!("{e:#}");
    for prefix in ["INSTALLATION FAILED: ", "UPGRADE FAILED: "] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    text
}

/// `helm install <name> <chart> -n <namespace> [--version] [--values -]`,
/// or its server-side dry run.
pub async fn helm_install(
    target: &HelmTarget,
    req: &HelmDeployRequest,
) -> Result<HelmDeployResult> {
    deploy(Mode::Install, target, req).await
}

/// `helm upgrade <name> <chart> -n <namespace> --reset-values [--version]
/// [--values -]`, or its server-side dry run.
pub async fn helm_upgrade(
    target: &HelmTarget,
    req: &HelmDeployRequest,
) -> Result<HelmDeployResult> {
    deploy(Mode::Upgrade, target, req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> HelmDeployRequest {
        HelmDeployRequest {
            name: "web".into(),
            namespace: "apps".into(),
            chart: "local/demo".into(),
            ..Default::default()
        }
    }

    #[test]
    fn builds_install_and_upgrade_arguments() {
        let t = HelmTarget {
            kubeconfig: None,
            context: Some("kind-x".into()),
        };
        assert_eq!(
            deploy_args(Mode::Install, &t, &req()).join(" "),
            "install web local/demo --namespace apps --output json --kube-context kind-x"
        );
        let full = HelmDeployRequest {
            version: "0.2.0".into(),
            values: "a: 1\n".into(),
            create_namespace: true,
            dry_run: true,
            ..req()
        };
        assert_eq!(
            deploy_args(Mode::Install, &HelmTarget::default(), &full).join(" "),
            "install web local/demo --namespace apps --version 0.2.0 --values - --create-namespace --dry-run=server --output json"
        );
        assert_eq!(
            deploy_args(Mode::Upgrade, &HelmTarget::default(), &full).join(" "),
            "upgrade web local/demo --namespace apps --version 0.2.0 --values - --reset-values --dry-run=server --output json"
        );
    }

    #[test]
    fn values_must_be_a_mapping() {
        assert!(check_values("").is_ok());
        assert!(check_values("# nothing\n").is_ok());
        assert!(check_values("a: 1\nb: [x]\n").is_ok());
        let e = check_values("a: [\n").unwrap_err().to_string();
        assert!(e.starts_with("The values are not valid YAML"), "{e}");
        assert!(check_values("- a\n- b\n").is_err());
        assert!(check_values("just text").is_err());
    }

    #[test]
    fn reads_helms_json_and_hides_secrets() {
        let out = serde_json::json!({
            "name": "web", "namespace": "apps", "version": 1,
            "info": { "status": "pending-install", "notes": "hi\n" },
            "chart": { "metadata": { "name": "demo", "version": "0.2.0", "appVersion": "1.36" } },
            "manifest": "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  password: hunter2\n"
        })
        .to_string();
        let dry = HelmDeployRequest {
            dry_run: true,
            ..req()
        };
        let r = result_from(&out, &dry, Mode::Install).unwrap();
        assert_eq!(
            (r.revision, r.status.as_str(), r.chart_version.as_str()),
            (1, "pending-install", "0.2.0")
        );
        assert!(r.secrets_hidden && !r.manifest.contains("hunter2"));
        assert_eq!(r.resources.len(), 1);
        assert_eq!(r.summary, "Dry run of apps/web: 1 objects, nothing changed");
        let shown = HelmDeployRequest {
            reveal: true,
            ..req()
        };
        let r = result_from(&out, &shown, Mode::Upgrade).unwrap();
        assert!(!r.secrets_hidden && r.manifest.contains("hunter2"));
        assert_eq!(r.summary, "Upgraded apps/web to revision 1");
    }

    #[test]
    fn helm_prefixes_are_replaced() {
        let e = anyhow!("INSTALLATION FAILED: cannot re-use a name that is still in use");
        assert_eq!(
            plain_failure(&e),
            "cannot re-use a name that is still in use"
        );
    }

    #[tokio::test]
    async fn rejects_bad_input_before_running_helm() {
        let t = HelmTarget::default();
        let bad = |f: fn(&mut HelmDeployRequest)| {
            let mut r = req();
            f(&mut r);
            r
        };
        for r in [
            bad(|r| r.name = "-x".into()),
            bad(|r| r.namespace = "--all".into()),
            bad(|r| r.chart = "--set".into()),
            bad(|r| r.version = "-1".into()),
            bad(|r| r.values = "[1, 2]".into()),
        ] {
            assert!(helm_install(&t, &r).await.is_err(), "{r:?}");
            assert!(helm_upgrade(&t, &r).await.is_err(), "{r:?}");
        }
    }
}
