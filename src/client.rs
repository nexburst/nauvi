//! Building a client for a kubeconfig context, and listing contexts.

use crate::auth::{describe_client_error, prepare_exec, AuthTarget, NO_KUBECONFIG};
use crate::catalog::ContextTarget;
use crate::errors::{chain_text, kubeconfig_error_text};
use crate::proxy::{apply_proxy, redact_credentials, ClusterProxy, ProxyRoute};
use crate::proxy_tls::ProxyTrust;
use anyhow::{anyhow, Result};
use kube::config::KubeConfigOptions;
use kube::Client;
use std::ffi::OsStr;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a response may stay silent: kube 2's default (#252).
pub const READ_TIMEOUT: Duration = Duration::from_secs(295);

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
    client_for_context_via(context, interactive, None).await
}

/// [`client_for_context_with`] through the cluster's proxy setting (#329),
/// if it has one.
pub async fn client_for_context_via(
    context: Option<&str>,
    interactive: bool,
    proxy: Option<&ClusterProxy>,
) -> Result<Client> {
    match kube::config::Kubeconfig::read() {
        Ok(kubeconfig) => client_from_kubeconfig_via(kubeconfig, context, interactive, proxy).await,
        // No kubeconfig inside a pod: in-cluster config. A named context
        // needs a kubeconfig.
        Err(_) if context.is_none() && in_cluster() => {
            let mut config = kube::Config::incluster()
                .map_err(|e| anyhow!("Cannot use the in-cluster config: {}", chain_text(&e)))?;
            let route = apply_proxy(&mut config, false, proxy);
            connect(config, "in-cluster".to_string(), interactive, route, proxy).await
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
    client_from_kubeconfig_via(kubeconfig, context, interactive, None).await
}

/// [`client_from_kubeconfig`] through the cluster's proxy setting (#329),
/// if it has one. The kubeconfig is not changed.
pub async fn client_from_kubeconfig_via(
    kubeconfig: kube::config::Kubeconfig,
    context: Option<&str>,
    interactive: bool,
    proxy: Option<&ClusterProxy>,
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
    .await
    .map_err(|e| anyhow!(redact_credentials(&chain_text(&e))))?;
    // Never HTTPS_PROXY from the environment: only a proxy set for this
    // cluster (see `apply_proxy`).
    let route = apply_proxy(&mut config, has_proxy, proxy);
    connect(config, context_name, interactive, route, proxy).await
}

/// The client settings kube 5 changed that we keep as kube 2 had them (#252).
fn keep_kube2_defaults(config: &mut kube::Config) {
    // kube 5 dropped its default read timeout. Keep kube 2's, so a one-off
    // request (a get, an apply, a log fetch) to a server that stopped
    // answering still fails instead of waiting forever. Watches and polls
    // don't rely on it: `crate::liveness` notices a quiet server first.
    if config.read_timeout.is_none() {
        config.read_timeout = Some(READ_TIMEOUT);
    }
    // kube 5 also retries 429, 503 and 504 answers by default, up to 15
    // times. We handle those ourselves: a drain reads an eviction's 429 as
    // "blocked by a PodDisruptionBudget", and a liveness probe counts a 503
    // from /readyz as an answer.
    config.default_retry = false;
}

/// Build the client, run its exec plugin and make the first request.
/// `setting` is the cluster's proxy setting: its CA file is used if
/// `route` goes through it.
async fn connect(
    mut config: kube::Config,
    context: String,
    interactive: bool,
    route: ProxyRoute,
    setting: Option<&ClusterProxy>,
) -> Result<Client> {
    keep_kube2_defaults(&mut config);
    // A failure names the proxy it went through, without its credentials
    // (nor any other URL's: a kubeconfig's proxy-url may have them too).
    let explain = |msg: String| {
        let via = match &route {
            ProxyRoute::Setting(url) => format!(" (through the proxy {url} set for this cluster)"),
            ProxyRoute::Kubeconfig => " (through the kubeconfig's proxy-url)".to_string(),
            ProxyRoute::Direct | ProxyRoute::LocalDirect => String::new(),
        };
        let hint = if !via.is_empty() && msg.contains("proxy authorization required") {
            ". The proxy wants a user name and password, or rejected the ones in its URL."
        } else {
            ""
        };
        let via = format!("{via}{hint}");
        anyhow!(redact_credentials(&format!("{msg}{via}")))
    };
    // An https:// proxy's certificate: the system's trust store, plus the
    // setting's CA file when the setting's proxy is used (a kubeconfig's
    // proxy-url gets the system's trust store only).
    let proxy_trust = match (&route, setting) {
        (ProxyRoute::Setting(_), Some(s)) => s.trust().map_err(&explain)?,
        _ => ProxyTrust::system(),
    };
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
        prepare_exec(exec, interactive, &target)
            .map_err(|msg| anyhow!(redact_credentials(&msg)))?;
    }
    // An exec plugin runs once, through the credential cache (#201), not
    // the ~3 times kube-client would run it for each client.
    let exec = crate::exec_credentials::logs_in_with_exec(&config)
        .then(|| config.auth_info.exec.clone())
        .flatten();
    let client = match &exec {
        Some(_) => crate::exec_credentials::client_with_exec(config, &proxy_trust).await,
        None => crate::forward_client::builder(config, &proxy_trust).map(|b| b.build()),
    }
    .map_err(|e| explain(describe_client_error(&e, &target)))?;
    if let Err(e) = client.apiserver_version().await {
        if let (Some(exec), kube::Error::Api(resp)) = (&exec, &e) {
            if resp.code == 401 {
                // Rejected: the next attempt asks the plugin again.
                crate::exec_credentials::forget(exec);
            }
        }
        return Err(explain(describe_client_error(&e, &target)));
    }
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
    client_with_via(kubeconfig, context, interactive, None).await
}

/// [`client_with`] through the cluster's proxy setting (#329), if any.
pub async fn client_with_via(
    kubeconfig: Option<&Path>,
    context: Option<&str>,
    interactive: bool,
    proxy: Option<&ClusterProxy>,
) -> Result<Client> {
    match kubeconfig {
        Some(path) => {
            let kc = kube::config::Kubeconfig::read_from(path)
                .map_err(|e| anyhow!(kubeconfig_error_text(&e, Some(path))))?;
            client_from_kubeconfig_via(kc, context, interactive, proxy).await
        }
        None => client_for_context_via(context, interactive, proxy).await,
    }
}

/// Build a client for a catalog context (#78): from the file it came from,
/// or the default kubeconfig.
pub async fn client_for_target(target: &ContextTarget, interactive: bool) -> Result<Client> {
    client_for_target_via(target, interactive, None).await
}

/// [`client_for_target`] through the cluster's proxy setting (#329), if any.
pub async fn client_for_target_via(
    target: &ContextTarget,
    interactive: bool,
    proxy: Option<&ClusterProxy>,
) -> Result<Client> {
    client_with_via(
        target.kubeconfig.as_deref(),
        Some(&target.context),
        interactive,
        proxy,
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
    kubeconfig_proxy_url(kubeconfig, context).is_some()
}

/// The proxy-url the kubeconfig sets for the given context's cluster
/// (`None` = the kubeconfig's current-context), with its user and password
/// masked: for showing which proxy a cluster uses.
pub fn kubeconfig_proxy_url(
    kubeconfig: &kube::config::Kubeconfig,
    context: Option<&str>,
) -> Option<String> {
    let current = match context {
        Some(name) => name.to_string(),
        None => kubeconfig.current_context.clone()?,
    };
    let cluster_name = kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == current)
        .and_then(|c| c.context.as_ref())
        .map(|ctx| ctx.cluster.clone())?;
    kubeconfig
        .clusters
        .iter()
        .find(|c| c.name == cluster_name)
        .and_then(|c| c.cluster.as_ref())
        .and_then(|cluster| cluster.proxy_url.as_deref())
        .map(redact_credentials)
}

/// The API server's release as it reports it (`gitVersion`: `v1.31.2`,
/// `v1.31.2+k3s1`), waiting at most `wait`. Text that does not look like a
/// version (`v` and a digit, then only `[0-9A-Za-z.+-_]`, 40 at most) is
/// refused, so a server cannot put anything else on screen.
pub async fn server_version(client: &Client, wait: Duration) -> Result<String, String> {
    let info = tokio::time::timeout(wait, client.apiserver_version())
        .await
        .map_err(|_| "the API server did not say its version in time".to_string())?
        .map_err(|e| format!("cannot read the API server's version: {}", chain_text(&e)))?;
    shown_version(&info.git_version)
}

/// `git_version` if it looks like a release (see [`server_version`]).
fn shown_version(git_version: &str) -> Result<String, String> {
    let v = git_version.trim();
    let ok = v.len() <= 40
        && v.starts_with('v')
        && v[1..].starts_with(|c: char| c.is_ascii_digit())
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_'));
    if ok {
        Ok(v.to_string())
    } else {
        let shown: String = v.chars().take(64).collect();
        Err(format!("Not a Kubernetes version: {shown:?}."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_versions_are_shown_as_reported_or_refused() {
        assert_eq!(shown_version("v1.31.2").unwrap(), "v1.31.2");
        assert_eq!(shown_version(" v1.31.2+k3s1\n").unwrap(), "v1.31.2+k3s1");
        assert_eq!(
            shown_version("v1.30.5-eks-ce1d5eb").unwrap(),
            "v1.30.5-eks-ce1d5eb"
        );
        for bad in [
            "",
            "1.31.2",
            "vx",
            "v1.31.2 <b>",
            "v1.31.2\u{202e}",
            &format!("v1.{}", "1".repeat(60)),
        ] {
            assert!(shown_version(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn clients_keep_kube2s_timeout_and_no_retries() {
        let mut config = kube::Config::new("https://127.0.0.1:6443".parse().unwrap());
        keep_kube2_defaults(&mut config);
        assert_eq!(config.read_timeout, Some(READ_TIMEOUT));
        assert!(!config.default_retry);
        // A timeout the caller set stays.
        config.read_timeout = Some(Duration::from_secs(7));
        keep_kube2_defaults(&mut config);
        assert_eq!(config.read_timeout, Some(Duration::from_secs(7)));
    }

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
            format!(
                "No kubeconfig found (looked at {}; KUBECONFIG is empty).",
                default.display()
            )
        );
        assert_eq!(
            kubeconfig_read_message(&kube::config::KubeconfigError::FindPath, None, None),
            "No kubeconfig found (looked at no home directory; KUBECONFIG is not set)."
        );
    }

    #[test]
    fn a_kubeconfig_that_exists_but_fails_says_why() {
        let dir = std::env::temp_dir().join(format!("nauvi-131-{}", std::process::id()));
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
