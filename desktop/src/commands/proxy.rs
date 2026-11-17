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
use serde::Serialize;
use specta::Type;
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

/// Set the proxy of the cluster of context `id`: `url` a proxy URL (http://,
/// https:// or socks5://), `""` to remove it, or left out to keep the saved
/// one and change only `local`.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_set_cluster_proxy(
    id: String,
    url: Option<String>,
    local: bool,
    state: State<'_, AppState>,
) -> Result<ClusterProxyInfo, String> {
    set(&state.sources, &id, url.as_deref(), local)?;
    info(&state.sources, &id)
}

fn set(
    sources: &KubeconfigSources,
    cluster: &str,
    url: Option<&str>,
    local: bool,
) -> Result<(), String> {
    if cluster.is_empty() {
        return Err("Name the cluster to set a proxy for.".into());
    }
    if sources.catalog().find(cluster).is_none() {
        return Err(format!(
            "There is no context {cluster} in your kubeconfigs."
        ));
    }
    let proxy = match url.map(str::trim) {
        Some("") => None,
        Some(text) => Some(ClusterProxy {
            url: ProxyUrl::parse(text)?,
            local,
        }),
        None => match sources.proxy(cluster) {
            Some(p) => Some(ClusterProxy { local, ..p }),
            None => return Err(format!("No proxy is set for {cluster}.")),
        },
    };
    sources.set_proxy(cluster, proxy)
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
        Some(p) if p.local || !server_local => format!("Connects through {}.", p.url),
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
        assert!(set(&sources, "", Some("http://p:1"), false).is_err());
        let e = set(
            &sources,
            "nauvi-329-no-such-context",
            Some("http://p:1"),
            false,
        )
        .unwrap_err();
        assert!(e.contains("no context"), "{e}");
    }
}
