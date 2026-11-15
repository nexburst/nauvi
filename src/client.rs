//! Building a client for a kubeconfig context, and listing contexts.

use crate::auth::{describe_client_error, prepare_exec, AuthTarget, NO_KUBECONFIG};
use crate::catalog::ContextTarget;
use crate::errors::{chain_text, kubeconfig_error_text};
use anyhow::{anyhow, Result};
use kube::config::KubeConfigOptions;
use kube::Client;
use std::ffi::OsStr;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

/// Build a client for the given context (`None` = the kubeconfig's
/// current-context), or from in-cluster config.
///
/// Exec credential plugins may prompt only when stdin is a terminal; use
/// [`client_for_context_with`] to decide that yourself.
pub async fn client_for_context(context: Option<&str>) -> Result<Client> {
    client_for_context_with(context, std::io::stdin().is_terminal()).await
}

/// Build a client for the given context and check that it can log in.
///
/// `interactive` says whether an exec credential plugin may prompt the user
/// (it then inherits our stdin and stderr). The desktop app passes false.
///
/// The client makes one request (`/version`) before it is returned, so a
/// missing plugin, rejected credentials or a certificate problem fail here,
/// with a readable message naming the context (see [`crate::auth`]).
pub async fn client_for_context_with(context: Option<&str>, interactive: bool) -> Result<Client> {
    match kube::config::Kubeconfig::read() {
        Ok(kubeconfig) => client_from_kubeconfig(kubeconfig, context, interactive).await,
        // No kubeconfig inside a pod: in-cluster config. A named context
        // needs a kubeconfig.
        Err(_) if context.is_none() && in_cluster() => {
            let config = kube::Config::incluster()
                .map_err(|e| anyhow!("Cannot use the in-cluster config: {}", chain_text(&e)))?;
            connect(config, "in-cluster".to_string(), interactive).await
        }
        Err(e) => Err(anyhow!(kubeconfig_read_message(
            &e,
            std::env::var_os("KUBECONFIG").as_deref(),
            home::home_dir().as_deref(),
        ))),
    }
}

/// Whether we run in a pod (the variable every pod gets).
fn in_cluster() -> bool {
    std::env::var_os("KUBERNETES_SERVICE_HOST").is_some()
}

/// The message for a default kubeconfig that could not be loaded: where we
/// looked when there is none (it starts with [`NO_KUBECONFIG`]), otherwise
/// what is wrong with it. `kubeconfig_env` is `KUBECONFIG`, `home` the
/// home directory.
pub fn kubeconfig_read_message(
    e: &kube::config::KubeconfigError,
    kubeconfig_env: Option<&OsStr>,
    home: Option<&Path>,
) -> String {
    let from_env: Vec<PathBuf> = kubeconfig_env
        .map(|v| {
            std::env::split_paths(v)
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let (looked_at, how) = if from_env.is_empty() {
        let default = home.map(|h| h.join(".kube").join("config"));
        let how = if kubeconfig_env.is_some() {
            "KUBECONFIG is empty"
        } else {
            "KUBECONFIG is not set"
        };
        (default.into_iter().collect::<Vec<_>>(), how)
    } else {
        (from_env, "from KUBECONFIG")
    };
    if looked_at.iter().all(|p| !p.exists()) {
        let paths = if looked_at.is_empty() {
            "no home directory".to_string()
        } else {
            looked_at
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        return format!("{NO_KUBECONFIG} (looked at {paths}; {how}).");
    }
    format!("{}.", kubeconfig_error_text(e, None))
}

/// [`client_for_context_with`] for a kubeconfig the caller loaded.
pub async fn client_from_kubeconfig(
    kubeconfig: kube::config::Kubeconfig,
    context: Option<&str>,
    interactive: bool,
) -> Result<Client> {
    let context_name = match context {
        Some(name) => name.to_string(),
        None => kubeconfig.current_context.clone().unwrap_or_default(),
    };
    let has_proxy = kubeconfig_has_proxy(&kubeconfig, context);
    let mut config = kube::Config::from_custom_kubeconfig(
        kubeconfig,
        &KubeConfigOptions {
            context: context.map(str::to_string),
            cluster: None,
            user: None,
        },
    )
    .await?;
    if !has_proxy {
        // kube-rs takes HTTPS_PROXY from the environment as the cluster
        // proxy and has no no_proxy support, so on a machine with a proxy
        // configured it would tunnel even local cluster addresses through
        // the proxy and fail. Only honour a proxy the kubeconfig sets
        // explicitly for this cluster.
        config.proxy_url = None;
    }
    connect(config, context_name, interactive).await
}

/// Build the client, run its exec plugin and make the first request.
async fn connect(mut config: kube::Config, context: String, interactive: bool) -> Result<Client> {
    let exec = config.auth_info.exec.as_ref();
    let target = AuthTarget {
        context,
        server: config.cluster_url.to_string(),
        exec_command: exec.and_then(|e| e.command.clone()),
        // The plugin's own `env` may set the PATH it is looked up in.
        exec_path: exec
            .and_then(|e| e.env.as_ref())
            .and_then(|env| {
                env.iter()
                    .find(|v| v.get("name").map(String::as_str) == Some("PATH"))
            })
            .and_then(|v| v.get("value").cloned()),
    };
    if let Some(exec) = config.auth_info.exec.as_mut() {
        prepare_exec(exec, interactive, &target).map_err(|msg| anyhow!(msg))?;
    }
    // Building the client runs the exec plugin, if any.
    let client =
        Client::try_from(config).map_err(|e| anyhow!(describe_client_error(&e, &target)))?;
    client
        .apiserver_version()
        .await
        .map_err(|e| anyhow!(describe_client_error(&e, &target)))?;
    Ok(client)
}

/// Build a client for an explicit kubeconfig file and/or context: the CLI's
/// `--kubeconfig` and `--context`. Without a file this is
/// [`client_for_context_with`] (`KUBECONFIG`, `~/.kube/config`, then
/// in-cluster config).
pub async fn client_with(
    kubeconfig: Option<&Path>,
    context: Option<&str>,
    interactive: bool,
) -> Result<Client> {
    match kubeconfig {
        Some(path) => {
            let kc = kube::config::Kubeconfig::read_from(path)
                .map_err(|e| anyhow!(kubeconfig_error_text(&e, Some(path))))?;
            client_from_kubeconfig(kc, context, interactive).await
        }
        None => client_for_context_with(context, interactive).await,
    }
}

/// Build a client for a catalog context (#78): from the file it came from,
/// or the default kubeconfig.
pub async fn client_for_target(target: &ContextTarget, interactive: bool) -> Result<Client> {
    client_with(
        target.kubeconfig.as_deref(),
        Some(&target.context),
        interactive,
    )
    .await
}

/// Build a client from the current kubeconfig (or in-cluster config).
pub async fn client() -> Result<Client> {
    client_for_context(None).await
}

/// Whether the kubeconfig sets a proxy-url for the given context's cluster
/// (`None` = the kubeconfig's current-context).
fn kubeconfig_has_proxy(kubeconfig: &kube::config::Kubeconfig, context: Option<&str>) -> bool {
    let current = match context {
        Some(name) => name.to_string(),
        None => match kubeconfig.current_context.clone() {
            Some(name) => name,
            None => return false,
        },
    };
    let Some(cluster_name) = kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == current)
        .and_then(|c| c.context.as_ref())
        .map(|ctx| ctx.cluster.clone())
    else {
        return false;
    };
    kubeconfig
        .clusters
        .iter()
        .find(|c| c.name == cluster_name)
        .and_then(|c| c.cluster.as_ref())
        .map(|cluster| cluster.proxy_url.is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_kubeconfig() -> kube::config::Kubeconfig {
        kube::config::Kubeconfig::from_yaml(
            r#"
apiVersion: v1
kind: Config
current-context: proxied
contexts:
- name: proxied
  context: {cluster: with-proxy, user: u}
- name: direct
  context: {cluster: no-proxy, user: u}
clusters:
- name: with-proxy
  cluster: {server: "https://a.example", proxy-url: "http://127.0.0.1:8080"}
- name: no-proxy
  cluster: {server: "https://b.example"}
users:
- name: u
  user: {}
"#,
        )
        .unwrap()
    }

    fn not_found(path: &str) -> kube::config::KubeconfigError {
        kube::config::KubeconfigError::ReadConfig(
            std::io::Error::new(std::io::ErrorKind::NotFound, "No such file or directory"),
            PathBuf::from(path),
        )
    }

    #[test]
    fn no_kubeconfig_says_where_it_looked() {
        let home = Path::new("/nonexistent-131/home");
        let default = home.join(".kube").join("config");
        assert_eq!(
            kubeconfig_read_message(&not_found("/x"), None, Some(home)),
            format!(
                "No kubeconfig found (looked at {}; KUBECONFIG is not set).",
                default.display()
            )
        );
        let env = std::env::join_paths(["/nonexistent-131/a", "/nonexistent-131/b"]).unwrap();
        assert_eq!(
            kubeconfig_read_message(&not_found("/nonexistent-131/a"), Some(&env), Some(home)),
            "No kubeconfig found (looked at /nonexistent-131/a, /nonexistent-131/b; from KUBECONFIG)."
        );
        assert_eq!(
            kubeconfig_read_message(&not_found("/x"), Some(OsStr::new("")), Some(home)),
            "No kubeconfig found (looked at /nonexistent-131/home/.kube/config; KUBECONFIG is empty)."
        );
        assert_eq!(
            kubeconfig_read_message(&kube::config::KubeconfigError::FindPath, None, None),
            "No kubeconfig found (looked at no home directory; KUBECONFIG is not set)."
        );
    }

    #[test]
    fn a_kubeconfig_that_exists_but_fails_says_why() {
        let dir = std::env::temp_dir().join(format!("kubeloupe-131-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config");
        std::fs::write(&file, "not: [valid").unwrap();
        let err = kube::config::Kubeconfig::read_from(&file).unwrap_err();
        let msg = kubeconfig_read_message(&err, Some(file.as_os_str()), None);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(msg.starts_with("Cannot use the kubeconfig: "), "{msg}");
        assert!(!msg.starts_with(NO_KUBECONFIG), "{msg}");
    }

    #[test]
    fn proxy_detection() {
        let kc = sample_kubeconfig();
        assert!(kubeconfig_has_proxy(&kc, None));
        assert!(kubeconfig_has_proxy(&kc, Some("proxied")));
        assert!(!kubeconfig_has_proxy(&kc, Some("direct")));
        assert!(!kubeconfig_has_proxy(&kc, Some("missing")));
    }
}
