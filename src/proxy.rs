//! A proxy set for one cluster in the app (#329), as Lens has: an
//! `http://`, `https://` or `socks5://` URL the client (and so every
//! request, watch, exec and port-forward, which all go through it) connects
//! through. It is never written to a kubeconfig.
//!
//! A proxy URL may carry a user and password (`http://user:pass@host:3128`).
//! They only ever reach the client: [`ProxyUrl`]'s `Debug` and `Display`
//! hide them, [`redact_credentials`] masks any URL's user and password in a
//! message, and every client error is passed through it.
//!
//! A cluster on this machine (`localhost`, `127.0.0.1`, `::1`) is reached
//! directly unless the setting asks for the proxy there too
//! ([`ClusterProxy::local`]): a proxy is for leaving the machine, and kind
//! or minikube behind a company proxy would otherwise break.

use std::fmt;
use std::net::IpAddr;

/// What replaces a URL's user and password.
pub const CREDENTIALS_MASK: &str = "[redacted]";

/// The schemes a proxy URL may have (what kube's client supports).
pub const PROXY_SCHEMES: [&str; 3] = ["http", "https", "socks5"];

/// A checked proxy URL. Always has a host and a port.
#[derive(Clone, PartialEq, Eq)]
pub struct ProxyUrl {
    uri: http::Uri,
}

impl ProxyUrl {
    /// Check `text` (surrounding spaces ignored) and add the scheme's
    /// default port if it has none. The error never repeats the user or
    /// password.
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Type a proxy URL, for example http://proxy.example:3128.".into());
        }
        let Some((scheme, rest)) = text.split_once("://") else {
            // Not repeated: without a scheme a password is not recognised.
            return Err(
                "Start the proxy URL with http://, https:// or socks5://, for example \
                 http://proxy.example:3128."
                    .into(),
            );
        };
        let shown = redact_credentials(text);
        let scheme = scheme.to_ascii_lowercase();
        if !PROXY_SCHEMES.contains(&scheme.as_str()) {
            return Err(format!(
                "A proxy URL starts with http://, https:// or socks5://, not {}://.",
                redact_credentials(&scheme)
            ));
        }
        if text.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(format!("A proxy URL has no spaces ({shown})."));
        }
        let (authority, tail) = match rest.find(['/', '?', '#']) {
            Some(i) => rest.split_at(i),
            None => (rest, ""),
        };
        if !(tail.is_empty() || tail == "/") {
            return Err(format!(
                "A proxy URL is only a scheme, host and port, with no path or query ({shown})."
            ));
        }
        let (userinfo, hostport) = match authority.rsplit_once('@') {
            Some((u, h)) => (Some(u), h),
            None => (None, authority),
        };
        if userinfo.is_some() && scheme == "socks5" {
            return Err(
                "A user name and password are not supported for SOCKS5 proxies; use an HTTP proxy \
                 for that, or a SOCKS5 proxy without them."
                    .into(),
            );
        }
        if userinfo.is_some_and(str::is_empty) {
            return Err(format!("The proxy URL has an empty user name ({shown})."));
        }
        let default_port = match scheme.as_str() {
            "http" => 80,
            "https" => 443,
            _ => 1080,
        };
        // `[v6]:port` or `host:port`, the port optional.
        let (host, port) = match hostport.rfind(':') {
            Some(i) if !hostport[i..].contains(']') => (&hostport[..i], Some(&hostport[i + 1..])),
            _ => (hostport, None),
        };
        let valid_host = !host.is_empty()
            && host
                .parse::<http::uri::Authority>()
                .is_ok_and(|a| a.as_str() == host && a.port().is_none());
        if host.is_empty() {
            return Err(format!("The proxy URL has no host ({shown})."));
        }
        if !valid_host {
            return Err(format!("Not a valid proxy host: {shown}."));
        }
        let port = match port.map(str::parse::<u16>) {
            Some(Ok(0)) => return Err(format!("The proxy port must not be 0 ({shown}).")),
            Some(Ok(p)) => p,
            Some(Err(_)) if port == Some("") => {
                return Err(format!("The proxy URL has an empty port ({shown})."))
            }
            Some(Err(_)) => return Err(format!("Not a valid proxy port: {shown}.")),
            None => default_port,
        };
        let user = userinfo.map(|u| format!("{u}@")).unwrap_or_default();
        let uri: http::Uri = format!("{scheme}://{user}{host}:{port}")
            .parse()
            .map_err(|_| format!("Not a valid proxy URL: {shown}."))?;
        Ok(Self { uri })
    }

    /// The URL the client connects through, credentials included.
    pub fn uri(&self) -> &http::Uri {
        &self.uri
    }

    /// The full URL, credentials included, for saving the setting. Never
    /// show or log it: use [`Self::redacted`].
    pub fn secret_text(&self) -> String {
        let s = self.uri.to_string();
        // `Uri` adds a "/" path to an authority-only URL.
        s.strip_suffix('/').unwrap_or(&s).to_string()
    }

    /// The URL with its user and password masked.
    pub fn redacted(&self) -> String {
        redact_credentials(&self.secret_text())
    }

    pub fn scheme(&self) -> &str {
        self.uri.scheme_str().unwrap_or_default()
    }

    /// Whether the URL has a user (and password).
    pub fn has_credentials(&self) -> bool {
        self.uri
            .authority()
            .is_some_and(|a| a.as_str().contains('@'))
    }
}

impl fmt::Debug for ProxyUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ProxyUrl({})", self.redacted())
    }
}

impl fmt::Display for ProxyUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.redacted())
    }
}

/// A cluster's proxy setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterProxy {
    pub url: ProxyUrl,
    /// Use the proxy for a cluster on this machine too (else such a cluster
    /// is reached directly).
    pub local: bool,
}

/// How a client reaches its cluster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyRoute {
    /// Directly (an environment proxy, `HTTPS_PROXY`, is never used).
    Direct,
    /// Through the proxy-url of the kubeconfig's cluster entry.
    Kubeconfig,
    /// Through the cluster's proxy setting.
    Setting(ProxyUrl),
    /// Directly, though a proxy is set: the cluster is on this machine and
    /// the setting does not ask for the proxy there.
    LocalDirect,
}

/// Whether `uri`'s host is this machine: `localhost` (or a name under it)
/// or a loopback address.
pub fn is_local_server(uri: &http::Uri) -> bool {
    let Some(host) = uri.host() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    })
}

/// Set `config.proxy_url` for the cluster: the setting's proxy (unless the
/// cluster is on this machine and the setting does not ask for it there),
/// else the kubeconfig's own proxy-url if it has one, else none.
///
/// kube takes `HTTPS_PROXY` from the environment as the proxy and has no
/// no_proxy support, so on a machine with a proxy configured it would
/// tunnel even local cluster addresses through it and fail. So only a proxy
/// set for this cluster (in the kubeconfig or the app) is used.
pub fn apply_proxy(
    config: &mut kube::Config,
    kubeconfig_has_proxy: bool,
    setting: Option<&ClusterProxy>,
) -> ProxyRoute {
    let local = is_local_server(&config.cluster_url);
    if let Some(s) = setting {
        if s.local || !local {
            config.proxy_url = Some(s.url.uri().clone());
            return ProxyRoute::Setting(s.url.clone());
        }
    }
    // (kube drops the kubeconfig's proxy-url for a server NO_PROXY names.)
    if kubeconfig_has_proxy && config.proxy_url.is_some() {
        return ProxyRoute::Kubeconfig;
    }
    config.proxy_url = None;
    if setting.is_some() {
        ProxyRoute::LocalDirect
    } else {
        ProxyRoute::Direct
    }
}

/// `text` with the user and password of every URL in it masked
/// (`http://user:pass@host` -> `http://[redacted]@host`).
pub fn redact_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        // The authority ends at a path, query, fragment, space or quote.
        let end = tail
            .find(|c: char| {
                matches!(
                    c,
                    '/' | '?' | '#' | '"' | '\'' | '`' | '<' | '>' | ',' | ';'
                ) || c.is_whitespace()
            })
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(CREDENTIALS_MASK);
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(text: &str) -> ProxyUrl {
        ProxyUrl::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    fn err(text: &str) -> String {
        ProxyUrl::parse(text).expect_err(text)
    }

    #[test]
    fn parses_the_supported_schemes_and_adds_default_ports() {
        assert_eq!(
            ok("http://proxy.example:3128").secret_text(),
            "http://proxy.example:3128"
        );
        assert_eq!(
            ok(" http://proxy.example ").secret_text(),
            "http://proxy.example:80"
        );
        assert_eq!(
            ok("https://proxy.example/").secret_text(),
            "https://proxy.example:443"
        );
        assert_eq!(
            ok("SOCKS5://10.0.0.1").secret_text(),
            "socks5://10.0.0.1:1080"
        );
        assert_eq!(ok("http://[::1]:8080").secret_text(), "http://[::1]:8080");
        let u = ok("http://me:p%40ss@proxy.example:3128");
        assert_eq!(u.secret_text(), "http://me:p%40ss@proxy.example:3128");
        assert!(u.has_credentials());
        assert_eq!(u.scheme(), "http");
        assert!(!ok("http://proxy.example").has_credentials());
    }

    #[test]
    fn rejects_what_is_not_a_proxy_url() {
        assert!(err("").contains("Type a proxy URL"));
        assert!(err("proxy.example:3128").contains("Start the proxy URL with"));
        assert!(err("ftp://proxy.example").contains("not ftp://"));
        assert!(err("socks4://proxy.example").contains("not socks4://"));
        assert!(err("file:///etc/passwd").contains("not file://"));
        assert!(err("http://").contains("proxy"));
        assert!(err("http://proxy.example:3128/path").contains("no path"));
        assert!(err("http://proxy.example:3128?x=1").contains("no path"));
        assert!(err("http://proxy .example").contains("no spaces"));
        assert!(err("http://proxy.example:99999").contains("Not a valid proxy port"));
        assert!(err("http://proxy.example:12ab").contains("Not a valid proxy port"));
        assert!(err("http://pro%xy:1").contains("Not a valid proxy host"));
        assert!(err("http://proxy.example:0").contains("must not be 0"));
        assert!(err("http://proxy.example:").contains("empty port"));
        assert!(err("http://@proxy.example").contains("empty user"));
        assert!(err("socks5://me:pw@proxy.example").contains("not supported for SOCKS5"));
    }

    #[test]
    fn errors_never_repeat_the_password() {
        for bad in [
            "http://me:hunter2@proxy.example:3128/path",
            "http://me:hunter2@proxy .example",
            "http://me:hunter2@proxy.example:99999",
            "socks5://me:hunter2@proxy.example",
            "ftp://me:hunter2@proxy.example",
            "me:hunter2@proxy.example",
        ] {
            let e = err(bad);
            assert!(!e.contains("hunter2"), "{bad}: {e}");
        }
    }

    #[test]
    fn debug_and_display_hide_credentials() {
        let u = ok("http://me:hunter2@proxy.example:3128");
        assert_eq!(u.redacted(), "http://[redacted]@proxy.example:3128");
        assert_eq!(u.to_string(), "http://[redacted]@proxy.example:3128");
        let p = ClusterProxy {
            url: u,
            local: false,
        };
        assert!(!format!("{p:?}").contains("hunter2"));
    }

    #[test]
    fn redacts_credentials_in_any_text() {
        assert_eq!(
            redact_credentials("tunnel to http://me:pw@proxy:3128 failed"),
            "tunnel to http://[redacted]@proxy:3128 failed"
        );
        assert_eq!(
            redact_credentials("a https://u:p@a/x?y and socks5://u@b, c"),
            "a https://[redacted]@a/x?y and socks5://[redacted]@b, c"
        );
        // A password with an @ in it: everything up to the last @ goes.
        assert_eq!(
            redact_credentials("http://u:p@ss@host:1"),
            "http://[redacted]@host:1"
        );
        assert_eq!(
            redact_credentials("\"http://u:p@h\""),
            "\"http://[redacted]@h\""
        );
        assert_eq!(
            redact_credentials("no url, https://host:443/path, me@example.com"),
            "no url, https://host:443/path, me@example.com"
        );
        assert_eq!(redact_credentials("ends with ://"), "ends with ://");
    }

    #[test]
    fn knows_servers_on_this_machine() {
        let local = |s: &str| is_local_server(&s.parse().unwrap());
        assert!(local("https://127.0.0.1:6443"));
        assert!(local("https://127.1.2.3:6443"));
        assert!(local("https://localhost:6443"));
        assert!(local("https://LOCALHOST.:6443"));
        assert!(local("https://kind.localhost"));
        assert!(local("https://[::1]:6443"));
        assert!(local("https://[::ffff:127.0.0.1]:6443"));
        assert!(!local("https://10.0.0.1:6443"));
        assert!(!local("https://localhost.example.com"));
        assert!(!local("https://k8s.example.com"));
    }

    fn config(server: &str) -> kube::Config {
        let mut c = kube::Config::new(server.parse().unwrap());
        c.proxy_url = Some("http://from-env:3128".parse().unwrap());
        c
    }

    #[test]
    fn applies_the_setting_but_not_to_this_machine_unless_asked() {
        let setting = |local| ClusterProxy {
            url: ok("http://proxy.example:3128"),
            local,
        };
        let proxied = Some("http://proxy.example:3128/".parse::<http::Uri>().unwrap());

        let mut c = config("https://k8s.example.com");
        let route = apply_proxy(&mut c, false, Some(&setting(false)));
        assert!(matches!(route, ProxyRoute::Setting(_)));
        assert_eq!(c.proxy_url, proxied);

        let mut c = config("https://127.0.0.1:6443");
        assert_eq!(
            apply_proxy(&mut c, false, Some(&setting(false))),
            ProxyRoute::LocalDirect
        );
        assert_eq!(c.proxy_url, None);

        let mut c = config("https://127.0.0.1:6443");
        assert!(matches!(
            apply_proxy(&mut c, false, Some(&setting(true))),
            ProxyRoute::Setting(_)
        ));
        assert_eq!(c.proxy_url, proxied);

        // The setting wins over the kubeconfig's proxy-url.
        let mut c = config("https://k8s.example.com");
        apply_proxy(&mut c, true, Some(&setting(false)));
        assert_eq!(c.proxy_url, proxied);
    }

    #[test]
    fn without_a_setting_only_the_kubeconfigs_proxy_is_used() {
        let mut c = config("https://k8s.example.com");
        assert_eq!(apply_proxy(&mut c, false, None), ProxyRoute::Direct);
        assert_eq!(c.proxy_url, None);
        let mut c = config("https://k8s.example.com");
        assert_eq!(apply_proxy(&mut c, true, None), ProxyRoute::Kubeconfig);
        assert!(c.proxy_url.is_some());
    }
}
