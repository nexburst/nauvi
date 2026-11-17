//! Changing releases through the `helm` CLI: rollback and uninstall (and,
//! through [`run_helm_with_input`], the `repo` and `deploy` modules).
//!
//! Reading releases is native (see the parent module); writing them is left
//! to Helm itself, which knows how to render, hook and record a revision.
//! The binary is `helm` on `PATH`, or `NAUVI_HELM` if set. Helm reads its
//! repositories from its own configuration (`HELM_REPOSITORY_CONFIG`,
//! `HELM_CONFIG_HOME`, ...), which the child process inherits. Commands on a
//! release set `HELM_DRIVER` to where that release is stored (#122).

use super::{check_release_name, HelmStorage};
use anyhow::{anyhow, bail, Result};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

/// Give up on a helm command after this long (it does not `--wait`).
const HELM_TIMEOUT: Duration = Duration::from_secs(300);

/// The cluster helm should talk to: the same kubeconfig file and context as
/// nauvi. `None` leaves helm's default (`KUBECONFIG`, then
/// `~/.kube/config`; the current context).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HelmTarget {
    pub kubeconfig: Option<PathBuf>,
    pub context: Option<String>,
}

impl HelmTarget {
    pub(crate) fn args(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(ctx) = &self.context {
            out.push("--kube-context".to_string());
            out.push(ctx.clone());
        }
        if let Some(path) = &self.kubeconfig {
            out.push("--kubeconfig".to_string());
            out.push(path.display().to_string());
        }
        out
    }
}

fn helm_binary() -> String {
    std::env::var("NAUVI_HELM")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "helm".to_string())
}

const NOT_INSTALLED: &str = "helm is not installed or not on PATH. Install it (https://helm.sh/docs/intro/install/) to install, upgrade, roll back or uninstall releases and to browse charts.";

/// Helm's own error text without its `Error: ` prefix, else the exit status.
fn failure_text(stderr: &str, status: std::process::ExitStatus) -> String {
    let text = stderr.trim();
    let text = text.strip_prefix("Error: ").unwrap_or(text);
    if text.is_empty() {
        format!("helm exited with {status}")
    } else {
        text.to_string()
    }
}

/// Helm's error about release `name` in plain words: without the helm
/// command's name in front (`uninstall: `), and a missing release
/// (`release: not found`, `Release not loaded: <name>: release: not found`,
/// `"<name>" has no deployed releases`) said as where helm looked.
pub(crate) fn release_failure(
    text: &str,
    namespace: &str,
    name: &str,
    storage: HelmStorage,
) -> String {
    let text = text.trim();
    let text = text.strip_prefix("Error: ").unwrap_or(text);
    let text = ["uninstall: ", "rollback: ", "upgrade: "]
        .iter()
        .find_map(|p| text.strip_prefix(p))
        .unwrap_or(text);
    let not_found = text == "release: not found"
        || text == format!("Release not loaded: {name}: release: not found")
        || text == format!("\"{name}\" has no deployed releases");
    if not_found {
        format!(
            "release {name} was not found in namespace {namespace} (helm looked in its {})",
            storage.objects()
        )
    } else {
        text.to_string()
    }
}

/// Run helm with `args`, writing `input` to its stdin (for `--values -`).
/// With `storage`, helm keeps releases there (`HELM_DRIVER`); without, it
/// inherits the environment's. Returns its stdout, trimmed; fails with
/// helm's own error text.
pub(crate) async fn run_helm_with_input(
    args: &[String],
    input: Option<&str>,
    storage: Option<HelmStorage>,
) -> Result<String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut cmd = Command::new(helm_binary());
    cmd.args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(storage) = storage {
        cmd.env("HELM_DRIVER", storage.driver());
    }
    let run = async {
        let mut child = cmd.spawn()?;
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            // A helm that exits early closes the pipe; its stderr says why.
            let _ = stdin.write_all(text.as_bytes()).await;
            drop(stdin);
        }
        child.wait_with_output().await
    };
    let out = match tokio::time::timeout(HELM_TIMEOUT, run).await {
        Err(_) => bail!("helm did not finish within {} s", HELM_TIMEOUT.as_secs()),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => bail!(NOT_INSTALLED),
        Ok(Err(e)) => return Err(anyhow!(e).context("cannot run helm")),
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        bail!(failure_text(
            &String::from_utf8_lossy(&out.stderr),
            out.status
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The installed helm's version (`v3.16.4+g7877b45`), or why there is none.
pub async fn helm_version() -> Result<String> {
    run_helm_with_input(&["version".into(), "--short".into()], None, None).await
}

fn rollback_args(target: &HelmTarget, namespace: &str, name: &str, revision: u32) -> Vec<String> {
    let mut args: Vec<String> = vec!["rollback".into(), name.into(), revision.to_string()];
    args.extend(["--namespace".into(), namespace.into()]);
    args.extend(target.args());
    args
}

fn uninstall_args(target: &HelmTarget, namespace: &str, name: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["uninstall".into(), name.into()];
    args.extend(["--namespace".into(), namespace.into()]);
    args.extend(target.args());
    args
}

pub(crate) fn check_namespace(namespace: &str) -> Result<()> {
    if namespace.is_empty() || namespace.starts_with('-') {
        bail!("{namespace:?} is not a valid namespace");
    }
    Ok(())
}

/// `helm rollback <name> <revision> -n <namespace>` of a release kept in
/// `storage`. Returns a short summary.
pub async fn helm_rollback(
    target: &HelmTarget,
    namespace: &str,
    name: &str,
    revision: u32,
    storage: HelmStorage,
) -> Result<String> {
    check_release_name(name)?;
    check_namespace(namespace)?;
    if revision == 0 {
        bail!("revision must be 1 or more");
    }
    let args = rollback_args(target, namespace, name, revision);
    run_helm_with_input(&args, None, Some(storage))
        .await
        .map_err(|e| {
            let why = release_failure(&format!("{e:#}"), namespace, name, storage);
            anyhow!("Rollback of {name} failed: {why}")
        })?;
    Ok(format!(
        "Rolled back {namespace}/{name} to revision {revision}"
    ))
}

/// `helm uninstall <name> -n <namespace>` of a release kept in `storage`.
/// Returns a short summary.
pub async fn helm_uninstall(
    target: &HelmTarget,
    namespace: &str,
    name: &str,
    storage: HelmStorage,
) -> Result<String> {
    check_release_name(name)?;
    check_namespace(namespace)?;
    let args = uninstall_args(target, namespace, name);
    run_helm_with_input(&args, None, Some(storage))
        .await
        .map_err(|e| {
            let why = release_failure(&format!("{e:#}"), namespace, name, storage);
            anyhow!("Uninstall of {name} failed: {why}")
        })?;
    Ok(format!("Uninstalled {namespace}/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_context_and_kubeconfig() {
        let t = HelmTarget {
            kubeconfig: Some("/k/config".into()),
            context: Some("kind-x".into()),
        };
        assert_eq!(
            rollback_args(&t, "apps", "web", 2).join(" "),
            "rollback web 2 --namespace apps --kube-context kind-x --kubeconfig /k/config"
        );
        assert_eq!(
            uninstall_args(&HelmTarget::default(), "apps", "web").join(" "),
            "uninstall web --namespace apps"
        );
    }

    #[cfg(unix)]
    #[test]
    fn helm_errors_lose_their_prefix() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(1 << 8);
        assert_eq!(
            failure_text("Error: release: not found\n", status),
            "release: not found"
        );
        assert_eq!(
            failure_text("  ", status),
            "helm exited with exit status: 1"
        );
    }

    #[test]
    fn a_missing_release_says_where_helm_looked() {
        use HelmStorage::*;
        let want = "release qa-cm-rel was not found in namespace apps (helm looked in its Secrets)";
        // What helm 3.16 says on uninstall, rollback and upgrade of a missing
        // release.
        for text in [
            "uninstall: Release not loaded: qa-cm-rel: release: not found",
            "Error: uninstall: Release not loaded: qa-cm-rel: release: not found\n",
            "release: not found",
            "\"qa-cm-rel\" has no deployed releases",
        ] {
            assert_eq!(release_failure(text, "apps", "qa-cm-rel", Secret), want);
        }
        assert_eq!(
            release_failure("release: not found", "apps", "web", ConfigMap),
            "release web was not found in namespace apps (helm looked in its ConfigMaps)"
        );
    }

    #[test]
    fn other_helm_errors_only_lose_the_command_name() {
        let plain = |text| release_failure(text, "apps", "web", HelmStorage::Secret);
        assert_eq!(
            plain("uninstall: Failed to purge the release: secrets is forbidden"),
            "Failed to purge the release: secrets is forbidden"
        );
        assert_eq!(
            plain("another operation (install/upgrade/rollback) is in progress"),
            "another operation (install/upgrade/rollback) is in progress"
        );
        // Another release's name is not this one's.
        assert_eq!(
            plain("\"other\" has no deployed releases"),
            "\"other\" has no deployed releases"
        );
    }

    #[tokio::test]
    async fn rejects_bad_input_before_running_helm() {
        let t = HelmTarget::default();
        let s = HelmStorage::Secret;
        assert!(helm_rollback(&t, "ns", "-x", 1, s).await.is_err());
        assert!(helm_rollback(&t, "ns", "web", 0, s).await.is_err());
        assert!(helm_uninstall(&t, "--all", "web", s).await.is_err());
    }
}
