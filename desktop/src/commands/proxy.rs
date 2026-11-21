//! The proxy of a cluster (#329), set on its settings page. Saved by
//! context id in `proxies.json` (see `catalog/proxies.rs`), never in a
//! kubeconfig. The UI only gets it with the user and password masked.
//!
//! Like `cmd_check_context`, these take a context id (`id`) and need no
//! session: a cluster's settings open whether or not a window is connected
//! to it, so they are not cluster commands (ADR 0007). A changed proxy is used by clients built afterwards, so it applies the
//! next time a window connects to the cluster.

use crate::catalog::KubeconfigSources;
use crate::state::AppState;
use kube::config::Kubeconfig;
use nauvi::proxy::{is_local_server_url, ClusterProxy, ProxyUrl};
use nauvi::proxy_tls::ProxyTrust;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use tauri::State;

/// A cluster's proxy, for its settings page and diagnostics. No field
/// holds a password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub(crate) struct ClusterProxyInfo {
    /// The proxy set in the app, its user and password masked (`""`: none).
    pub(crate) url: String,
    /// Whether that URL has a user and password.
    pub(crate) has_credentials: bool,
    /// Use the proxy for a cluster on this machine too.
    pub(crate) local: bool,
    /// An https:// proxy's CA file, besides the system's trust store
    /// (`""`: none).
    pub(crate) ca_file: String,
    /// The kubeconfig's own proxy-url for the cluster, masked (`""`: none).
    pub(crate) kubeconfig_proxy: String,
    /// The API server is on this machine (localhost, 127.0.0.1, ::1).
    pub(crate) server_local: bool,
    /// How the cluster's next connection goes, in a sentence.
    pub(crate) route: String,
}

/// The proxy of the cluster of context `id`.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_get_cluster_proxy(
    id: String,
    state: State<'_, AppState>,
) -> Result<ClusterProxyInfo, String> {
    info(&state.sources, &id)
}

/// Set the proxy of the cluster of context `id`: `url` a proxy URL
/// (http://, https:// or socks5://), `""` to remove it, or left out to keep
/// the saved one and change only `local` or the CA file. `ca_file`, for an
/// https:// proxy: the full path of a PEM file of CA certificates its
/// certificate may be signed by (#362), `""` for none, or left out to keep
/// the saved one.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_set_cluster_proxy(
    id: String,
    url: Option<String>,
    local: bool,
    ca_file: Option<String>,
    state: State<'_, AppState>,
) -> Result<ClusterProxyInfo, String> {
    set(
        &state.sources,
        &id,
        url.as_deref(),
        local,
        ca_file.as_deref(),
    )?;
    info(&state.sources, &id)
}

fn set(
    sources: &KubeconfigSources,
    cluster: &str,
    url: Option<&str>,
    local: bool,
    ca_file: Option<&str>,
) -> Result<(), String> {
    if cluster.is_empty() {
        return Err("Name the cluster to set a proxy for.".into());
    }
    if sources.catalog().find(cluster).is_none() {
        return Err(format!(
            "There is no context {cluster} in your kubeconfigs."
        ));
    }
    let saved = sources.proxy(cluster);
    let proxy = match url.map(str::trim) {
        Some("") => None,
        Some(text) => Some(with_ca(
            ProxyUrl::parse(text)?,
            local,
            ca_file,
            saved.and_then(|p| p.ca_file),
        )?),
        None => match saved {
            Some(p) => Some(with_ca(p.url, local, ca_file, p.ca_file)?),
            None => return Err(format!("No proxy is set for {cluster}.")),
        },
    };
    sources.set_proxy(cluster, proxy)
}

/// The setting for `url`, with the CA file `ca_file` (`None`: the saved
/// one, `""`: none), checked. Only an https:// proxy has one: a saved one
/// is dropped for another scheme, a new one refused.
fn with_ca(
    url: ProxyUrl,
    local: bool,
    ca_file: Option<&str>,
    saved: Option<PathBuf>,
) -> Result<ClusterProxy, String> {
    let https = url.scheme() == "https";
    let ca_file = match ca_file.map(str::trim) {
        None => saved.filter(|_| https),
        Some("") => None,
        Some(_) if !https => {
            return Err("A CA file is only used for an https:// proxy.".into());
        }
        Some(path) => {
            let path = PathBuf::from(path);
            ProxyTrust::from_ca_file(&path)?;
            Some(path)
        }
    };
    Ok(ClusterProxy {
        url,
        local,
        ca_file,
    })
}

fn info(sources: &KubeconfigSources, cluster: &str) -> Result<ClusterProxyInfo, String> {
    let catalog = sources.catalog();
    let Some(ctx) = catalog.find(cluster) else {
        return Err(format!(
            "There is no context {cluster} in your kubeconfigs."
        ));
    };
    let server_local = is_local_server_url(&ctx.server);
    let kubeconfig_proxy = catalog
        .resolve(Some(cluster))
        .ok()
        .and_then(|t| {
            let kc = match &t.kubeconfig {
                Some(path) => Kubeconfig::read_from(path).ok()?,
                None => Kubeconfig::read().ok()?,
            };
            nauvi::kubeconfig_proxy_url(&kc, Some(&t.context))
        })
        .unwrap_or_default();
    let set = sources.proxy(cluster);
    Ok(describe(set.as_ref(), kubeconfig_proxy, server_local))
}

fn describe(
    set: Option<&ClusterProxy>,
    kubeconfig_proxy: String,
    server_local: bool,
) -> ClusterProxyInfo {
    let route = match set {
        Some(p) if p.local || !server_local => match (&p.ca_file, p.url.scheme()) {
            (Some(ca), "https") => format!(
                "Connects through {}, its certificate checked against the system's trust \
                 store and {}.",
                p.url,
                ca.display()
            ),
            (None, "https") => format!(
                "Connects through {}, its certificate checked against the system's trust \
                 store.",
                p.url
            ),
            _ => format!("Connects through {}.", p.url),
        },
        _ if !kubeconfig_proxy.is_empty() => {
            format!("Connects through the kubeconfig's proxy-url, {kubeconfig_proxy}.")
        }
        Some(_) => "Connects directly: the cluster is on this machine, and the proxy is \
                    not used for it unless you ask below."
            .to_string(),
        None => {
            "Connects directly. Proxy environment variables (HTTPS_PROXY) are not used.".to_string()
        }
    };
    ClusterProxyInfo {
        url: set.map(|p| p.url.redacted()).unwrap_or_default(),
        has_credentials: set.is_some_and(|p| p.url.has_credentials()),
        local: set.is_some_and(|p| p.local),
        ca_file: set
            .and_then(|p| p.ca_file.as_ref())
            .map(|f| f.display().to_string())
            .unwrap_or_default(),
        kubeconfig_proxy,
        server_local,
        route,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(url: &str, local: bool) -> ClusterProxy {
        ClusterProxy {
            url: ProxyUrl::parse(url).unwrap(),
            local,
            ca_file: None,
        }
    }

    #[test]
    fn the_info_never_holds_the_password() {
        let p = proxy("http://me:hunter2@proxy.example:3128", false);
        let i = describe(Some(&p), String::new(), false);
        assert_eq!(i.url, "http://[redacted]@proxy.example:3128");
        assert!(i.has_credentials);
        assert_eq!(
            i.route,
            "Connects through http://[redacted]@proxy.example:3128."
        );
        assert!(!format!("{i:?}").contains("hunter2"));
        assert!(!serde_json::to_string(&i).unwrap().contains("hunter2"));
    }

    #[test]
    fn says_how_the_cluster_is_reached() {
        let p = proxy("socks5://10.0.0.1", false);
        assert!(describe(None, String::new(), false)
            .route
            .starts_with("Connects directly."));
        assert!(describe(Some(&p), String::new(), true)
            .route
            .contains("on this machine"));
        let local = proxy("socks5://10.0.0.1", true);
        let i = describe(Some(&local), String::new(), true);
        assert_eq!(i.route, "Connects through socks5://10.0.0.1:1080.");
        assert!(i.local && i.server_local && !i.has_credentials);
        let kc = describe(None, "http://[redacted]@corp:8080".into(), false);
        assert!(kc.route.contains("kubeconfig's proxy-url"), "{}", kc.route);
    }

    #[test]
    fn setting_needs_a_known_cluster_and_a_valid_url() {
        let sources = KubeconfigSources::default();
        assert!(set(&sources, "", Some("http://p:1"), false, None).is_err());
        let e = set(
            &sources,
            "nauvi-329-no-such-context",
            Some("http://p:1"),
            false,
            None,
        )
        .unwrap_err();
        assert!(e.contains("no context"), "{e}");
    }

    #[test]
    fn an_https_proxy_says_what_its_certificate_is_checked_against() {
        let p = proxy("https://me:hunter2@proxy.example:3129", false);
        let i = describe(Some(&p), String::new(), false);
        assert_eq!(
            i.route,
            "Connects through https://[redacted]@proxy.example:3129, its certificate checked \
             against the system's trust store."
        );
        assert_eq!(i.ca_file, "");
        let with_ca = ClusterProxy {
            ca_file: Some("/etc/proxy-ca.pem".into()),
            ..p
        };
        let i = describe(Some(&with_ca), String::new(), false);
        assert!(
            i.route.ends_with("trust store and /etc/proxy-ca.pem."),
            "{}",
            i.route
        );
        assert_eq!(i.ca_file, "/etc/proxy-ca.pem");
    }

    #[test]
    fn a_ca_file_is_checked_and_only_kept_for_an_https_proxy() {
        let url = |u: &str| ProxyUrl::parse(u).unwrap();
        let saved = Some(PathBuf::from("/saved/ca.pem"));
        // Kept when left out, removed with "", dropped for another scheme.
        let p = with_ca(url("https://p:1"), false, None, saved.clone()).unwrap();
        assert_eq!(p.ca_file, saved);
        let p = with_ca(url("https://p:1"), false, Some(""), saved.clone()).unwrap();
        assert_eq!(p.ca_file, None);
        let p = with_ca(url("http://p:1"), false, None, saved.clone()).unwrap();
        assert_eq!(p.ca_file, None);
        let e = with_ca(url("http://p:1"), false, Some("/ca.pem"), None).unwrap_err();
        assert!(e.contains("only used for an https:// proxy"), "{e}");
        // A file that is not there, or no certificate: refused when saved.
        let none = std::env::temp_dir().join("nauvi-362-none.pem");
        let none = none.to_str().unwrap();
        let e = with_ca(url("https://p:1"), false, Some(none), None).unwrap_err();
        assert!(e.starts_with("Cannot read the proxy's CA file"), "{e}");
        let e = with_ca(url("https://p:1"), false, Some("ca.pem"), None).unwrap_err();
        assert!(e.contains("full path"), "{e}");
    }
}
