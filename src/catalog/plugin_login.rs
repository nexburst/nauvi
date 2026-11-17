//! Logins through a plugin that may ask the user (a browser for OIDC or
//! SSO, a device code, a prompt), ADR 0007: the desktop app never
//! disconnects such a cluster when it is idle, since connecting it again
//! could ask again.
//!
//! Every exec plugin counts as one, unless the kubeconfig says it never
//! asks (`interactiveMode: Never`) or it is a command known not to ask.
//! Wrappers (`env …`, `sh -c …`) and unknown scripts count: what they run
//! is not known. A false positive only keeps an idle cluster connected.

use kube::config::{AuthInfo, ExecConfig, ExecInteractiveMode};
use std::path::Path;

/// `kubelogin --login` modes that never ask (Azure service principal,
/// managed identity, workload identity, the Azure CLI's token).
const KUBELOGIN_QUIET: &[&str] = &["spn", "msi", "workloadidentity", "azurecli"];

/// Whether logging in as `auth` runs a plugin that may ask the user: an
/// exec plugin (see the module docs for the exceptions), or the legacy
/// `gcp` or `azure` auth provider. The `oidc` auth provider refreshes its
/// token without asking.
pub fn plugin_login(auth: &AuthInfo) -> bool {
    if let Some(exec) = &auth.exec {
        return !never_asks(exec);
    }
    auth.auth_provider
        .as_ref()
        .is_some_and(|p| p.name == "gcp" || p.name == "azure")
}

fn never_asks(exec: &ExecConfig) -> bool {
    if matches!(exec.interactive_mode, Some(ExecInteractiveMode::Never)) {
        return true;
    }
    let args: Vec<&str> = exec.args.iter().flatten().map(String::as_str).collect();
    match program_name(exec.command.as_deref().unwrap_or_default()).as_str() {
        "aws-iam-authenticator" | "gke-gcloud-auth-plugin" => true,
        // A profile may be an SSO one, which asks for a browser login.
        "aws" => {
            let profile = args
                .iter()
                .any(|a| *a == "--profile" || a.starts_with("--profile="))
                || exec
                    .env
                    .iter()
                    .flatten()
                    .any(|e| e.get("name").map(String::as_str) == Some("AWS_PROFILE"));
            args.starts_with(&["eks", "get-token"]) && !profile
        }
        "kubelogin" => login_mode(&args).is_some_and(|m| KUBELOGIN_QUIET.contains(&m)),
        _ => false,
    }
}

/// The value of `--login`/`-l` (`--login x` or `--login=x`).
fn login_mode<'a>(args: &[&'a str]) -> Option<&'a str> {
    args.iter().enumerate().find_map(|(i, a)| match *a {
        "--login" | "-l" => args.get(i + 1).copied(),
        _ => a.strip_prefix("--login="),
    })
}

/// `command`'s file name, lower-cased, without a Windows `.exe`.
fn program_name(command: &str) -> String {
    let name = Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);
    // Windows paths on other systems too: a kubeconfig is copied around.
    let name = name.rsplit('\\').next().unwrap_or(name).to_lowercase();
    name.strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn auth(exec: Value) -> AuthInfo {
        serde_json::from_value(json!({ "exec": exec })).unwrap()
    }

    fn exec(command: &str, args: &[&str]) -> AuthInfo {
        auth(json!({ "command": command, "args": args }))
    }

    fn provider(name: &str) -> AuthInfo {
        serde_json::from_value(json!({ "auth-provider": { "name": name, "config": {} } })).unwrap()
    }

    #[test]
    fn exec_plugins_may_ask_by_default() {
        assert!(plugin_login(&exec("kubelogin", &["get-token"])));
        assert!(plugin_login(&exec(
            "kubelogin",
            &["get-token", "--login", "devicecode"]
        )));
        assert!(plugin_login(&exec("kubectl", &["oidc-login", "get-token"])));
        assert!(plugin_login(&exec("tsh", &["kube", "credentials"])));
        assert!(plugin_login(&exec("doctl", &["kubernetes", "cluster"])));
        // Wrappers and scripts: what they run is not known.
        assert!(plugin_login(&exec("/bin/sh", &["-c", "echo kubelogin"])));
        assert!(plugin_login(&exec("env", &["gke-gcloud-auth-plugin"])));
        assert!(plugin_login(&exec("/home/me/bin/token.sh", &[])));
        // aws with a profile, which may be an SSO one.
        assert!(plugin_login(&exec(
            "aws",
            &["eks", "get-token", "--profile", "sso"]
        )));
        assert!(plugin_login(&exec(
            "aws",
            &["eks", "get-token", "--profile=sso"]
        )));
        assert!(plugin_login(&auth(json!({
            "command": "aws",
            "args": ["eks", "get-token"],
            "env": [{ "name": "AWS_PROFILE", "value": "sso" }],
        }))));
        assert!(plugin_login(&provider("gcp")));
        assert!(plugin_login(&provider("azure")));
    }

    #[test]
    fn known_quiet_plugins_and_never_interactive_do_not() {
        assert!(!plugin_login(&AuthInfo::default()));
        assert!(!plugin_login(&provider("oidc")));
        assert!(!plugin_login(&exec(
            "aws",
            &["eks", "get-token", "--cluster-name", "c"]
        )));
        assert!(!plugin_login(&exec(
            "aws-iam-authenticator",
            &["token", "-i", "c"]
        )));
        assert!(!plugin_login(&exec("gke-gcloud-auth-plugin", &[])));
        assert!(!plugin_login(&exec(
            r"C:\Program Files\gcloud\gke-gcloud-auth-plugin.exe",
            &[]
        )));
        for mode in ["spn", "msi", "workloadidentity", "azurecli"] {
            assert!(
                !plugin_login(&exec("kubelogin", &["get-token", "--login", mode])),
                "{mode}"
            );
        }
        assert!(!plugin_login(&exec(
            "kubelogin",
            &["get-token", "-l", "msi"]
        )));
        assert!(!plugin_login(&exec(
            "kubelogin",
            &["get-token", "--login=azurecli"]
        )));
        // The kubeconfig says it never asks.
        assert!(!plugin_login(&auth(json!({
            "command": "/bin/sh",
            "args": ["-c", "echo token"],
            "interactiveMode": "Never",
        }))));
    }
}
