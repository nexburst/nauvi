//! Logins that may open a browser (OIDC or SSO), ADR 0007: the desktop app
//! never disconnects such a cluster when it is idle, since connecting it
//! again would open the browser again.

use kube::config::AuthInfo;
use std::path::Path;

/// Exec plugins that log in through a browser, or can (an SSO profile).
/// Matched on the program's file name. A false positive only keeps an idle
/// cluster connected; a false negative reopens the browser, so the list
/// leans towards yes (`aws`, say, may or may not use SSO).
const BROWSER_PLUGINS: &[&str] = &[
    // int128/kubelogin (`kubectl oidc-login`) and Azure's kubelogin.
    "kubelogin",
    "kubectl-oidc_login",
    "kubectl-oidc-login",
    // GKE.
    "gke-gcloud-auth-plugin",
    "gcloud",
    // AWS with SSO.
    "aws",
    "aws-vault",
    "aws-sso-util",
    // Azure CLI, OCI CLI, Pinniped, Teleport.
    "az",
    "oci",
    "pinniped",
    "tsh",
];

/// Whether logging in as `auth` may open a browser: its exec plugin is one
/// of [`BROWSER_PLUGINS`] (or `kubectl oidc-login`), or it uses the legacy
/// `gcp` or `azure` auth provider. The `oidc` auth provider refreshes its
/// token without one.
pub fn browser_login(auth: &AuthInfo) -> bool {
    if let Some(exec) = &auth.exec {
        let command = exec.command.as_deref().unwrap_or_default();
        let program = program_name(command);
        if BROWSER_PLUGINS.contains(&program.as_str()) {
            return true;
        }
        let first_arg = exec.args.iter().flatten().next().map(String::as_str);
        return program == "kubectl" && first_arg == Some("oidc-login");
    }
    auth.auth_provider
        .as_ref()
        .is_some_and(|p| p.name == "gcp" || p.name == "azure")
}

/// `command`'s file name, lower-cased, without a Windows `.exe` or `.cmd`.
fn program_name(command: &str) -> String {
    let name = Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);
    // Windows paths on other systems too: a kubeconfig is copied around.
    let name = name.rsplit('\\').next().unwrap_or(name).to_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(stem) = name.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exec(command: &str, args: &[&str]) -> AuthInfo {
        serde_json::from_value(json!({ "exec": { "command": command, "args": args } })).unwrap()
    }

    fn provider(name: &str) -> AuthInfo {
        serde_json::from_value(json!({ "auth-provider": { "name": name, "config": {} } })).unwrap()
    }

    #[test]
    fn browser_logins_are_recognised() {
        assert!(browser_login(&exec("kubelogin", &["get-token"])));
        assert!(browser_login(&exec(
            "/usr/local/bin/kubectl-oidc_login",
            &[]
        )));
        assert!(browser_login(&exec(
            "kubectl",
            &["oidc-login", "get-token"]
        )));
        assert!(browser_login(&exec("gke-gcloud-auth-plugin", &[])));
        assert!(browser_login(&exec(
            r"C:\Program Files\gcloud\gke-gcloud-auth-plugin.exe",
            &[]
        )));
        assert!(browser_login(&exec("aws", &["eks", "get-token"])));
        assert!(browser_login(&exec("tsh", &["kube", "credentials"])));
        assert!(browser_login(&provider("gcp")));
        assert!(browser_login(&provider("azure")));
    }

    #[test]
    fn other_logins_are_not() {
        assert!(!browser_login(&AuthInfo::default()));
        assert!(!browser_login(&exec("kubectl", &["get", "pods"])));
        assert!(!browser_login(&exec("/bin/sh", &["-c", "echo kubelogin"])));
        assert!(!browser_login(&exec("doctl", &["kubernetes", "cluster"])));
        assert!(!browser_login(&provider("oidc")));
    }
}
