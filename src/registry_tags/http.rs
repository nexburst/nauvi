//! The HTTPS client of the registry requests.
//!
//! - HTTPS only (the connector refuses `http://`), the certificate checked
//!   against the system's trust store (the platform verifier, as for a
//!   cluster without a CA of its own); no client certificate.
//! - Every host is checked with [`check_host`] before the connection, and
//!   every address its name resolves to with [`ip_refused`] ([`Guarded`]):
//!   a name that resolves to this machine or a link-local address (DNS
//!   rebinding) is not connected to.
//! - Redirects are followed only to the same host and port, at most
//!   [`MAX_REDIRECTS`] times; any other is refused.
//! - Each request, its body included, has [`REQUEST_TIMEOUT`]; bodies are
//!   read up to a cap the caller gives, and a longer one is an error.
//! - No proxy: proxy environment variables are not read (the cluster's
//!   proxy setting is for the cluster, not the registries).

use super::reference::{check_host, ip_refused};
use bytes::Bytes;
use http::header::{HeaderMap, HeaderName, HeaderValue, LOCATION, USER_AGENT};
use http::{Method, Request, StatusCode, Uri};
use http_body_util::{BodyExt as _, Empty, Limited};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::dns::Name;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use rustls::pki_types::CertificateDer;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

/// How long one request (connection, answer and body) may take.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the TCP connection may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Redirects followed (same host only).
pub(crate) const MAX_REDIRECTS: usize = 3;

/// One answer: status, headers, the body (capped).
#[derive(Debug)]
pub(crate) struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
    /// The URL that answered (after redirects).
    pub uri: Uri,
}

impl Reply {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// The client: one connection pool for the requests of one look-up.
#[derive(Clone)]
pub(crate) struct Https {
    client: Client<HttpsConnector<HttpConnector<Guarded>>, Empty<Bytes>>,
    allow_loopback: bool,
}

impl Https {
    /// A client trusting the system's roots and `extra_roots` (the QA
    /// scenario's test CA, debug builds only).
    pub(crate) fn new(
        extra_roots: Vec<CertificateDer<'static>>,
        allow_loopback: bool,
    ) -> Result<Self, String> {
        let builder = rustls::ClientConfig::builder();
        let provider = builder.crypto_provider().clone();
        let verifier =
            rustls_platform_verifier::Verifier::new_with_extra_roots(extra_roots, provider)
                .map_err(|e| format!("Cannot set up TLS: {e}"))?;
        let tls = builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        let mut tcp = HttpConnector::new_with_resolver(Guarded { allow_loopback });
        tcp.enforce_http(false);
        tcp.set_connect_timeout(Some(CONNECT_TIMEOUT));
        tcp.set_nodelay(true);
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_only()
            .enable_http1()
            .wrap_connector(tcp);
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(30))
            .build(https);
        Ok(Self {
            client,
            allow_loopback,
        })
    }

    /// `uri` checked: `https`, a host [`check_host`] allows.
    pub(crate) fn check(&self, uri: &Uri) -> Result<(), String> {
        if uri.scheme_str() != Some("https") {
            return Err(format!(
                "nauvi only contacts registries over HTTPS, not {}",
                shown_uri(uri)
            ));
        }
        let authority = uri
            .authority()
            .ok_or_else(|| format!("{} has no host", shown_uri(uri)))?;
        check_host(authority.as_str(), self.allow_loopback)
    }

    /// `method uri` with `headers`, following same-host redirects, the body
    /// read up to `cap` bytes.
    pub(crate) async fn send(
        &self,
        method: Method,
        uri: Uri,
        headers: &[(HeaderName, HeaderValue)],
        cap: usize,
    ) -> Result<Reply, String> {
        let host = host_of(&uri);
        match tokio::time::timeout(REQUEST_TIMEOUT, self.follow(method, uri, headers, cap)).await {
            Ok(r) => r,
            Err(_) => Err(format!(
                "{host} did not answer within {} s",
                REQUEST_TIMEOUT.as_secs()
            )),
        }
    }

    async fn follow(
        &self,
        method: Method,
        mut uri: Uri,
        headers: &[(HeaderName, HeaderValue)],
        cap: usize,
    ) -> Result<Reply, String> {
        let first = uri.authority().cloned();
        for _ in 0..=MAX_REDIRECTS {
            self.check(&uri)?;
            let reply = self.once(method.clone(), uri.clone(), headers, cap).await?;
            if !reply.status.is_redirection() {
                return Ok(reply);
            }
            let Some(next) = reply
                .header(LOCATION.as_str())
                .and_then(|l| resolve(&uri, l))
            else {
                return Err(format!(
                    "{} answered with a redirect nauvi cannot follow",
                    host_of(&uri)
                ));
            };
            if next.authority() != first.as_ref() || next.scheme_str() != Some("https") {
                return Err(format!(
                    "{} redirected to {}: nauvi follows redirects only on the same host",
                    host_of(&uri),
                    shown_uri(&next)
                ));
            }
            uri = next;
        }
        Err(format!("{} redirected too many times", host_of(&uri)))
    }

    async fn once(
        &self,
        method: Method,
        uri: Uri,
        headers: &[(HeaderName, HeaderValue)],
        cap: usize,
    ) -> Result<Reply, String> {
        let mut req = Request::builder().method(method).uri(uri.clone());
        req = req.header(USER_AGENT, concat!("nauvi/", env!("CARGO_PKG_VERSION")));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let req = req
            .body(Empty::<Bytes>::new())
            .map_err(|e| format!("Cannot build the request: {e}"))?;
        let host = host_of(&uri);
        let res = self
            .client
            .request(req)
            .await
            .map_err(|e| format!("Cannot reach {host}: {}", error_chain(&e)))?;
        let (parts, body) = res.into_parts();
        let body = Limited::new(body, cap)
            .collect()
            .await
            .map_err(|e| {
                if e.downcast_ref::<http_body_util::LengthLimitError>()
                    .is_some()
                {
                    format!(
                        "{host} sent more than {} KB, more than nauvi reads",
                        cap / 1024
                    )
                } else {
                    format!("{host} broke off its answer: {e}")
                }
            })?
            .to_bytes();
        Ok(Reply {
            status: parts.status,
            headers: parts.headers,
            body,
            uri,
        })
    }
}

/// The system resolver, keeping only the addresses [`ip_refused`] allows;
/// none left is an error that says why.
#[derive(Clone, Copy)]
pub(crate) struct Guarded {
    allow_loopback: bool,
}

type Addrs = std::vec::IntoIter<SocketAddr>;

impl tower::Service<Name> for Guarded {
    type Response = Addrs;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Addrs, std::io::Error>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, name: Name) -> Self::Future {
        let allow = self.allow_loopback;
        Box::pin(async move {
            let host = name.as_str().to_string();
            let all: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let (ok, refused) = keep_allowed(all, allow);
            match (ok.is_empty(), refused) {
                (false, _) => Ok(ok.into_iter()),
                (true, Some(why)) => Err(std::io::Error::other(format!(
                    "nauvi does not connect to {host}: it resolves to {why}"
                ))),
                (true, None) => Err(std::io::Error::other(format!("{host} has no address"))),
            }
        })
    }
}

/// The addresses nauvi may connect to, and why one was refused.
fn keep_allowed(
    all: Vec<SocketAddr>,
    allow_loopback: bool,
) -> (Vec<SocketAddr>, Option<&'static str>) {
    let mut why = None;
    let ok = all
        .into_iter()
        .filter(|a| match ip_refused(a.ip(), allow_loopback) {
            Some(w) => {
                why = Some(w);
                false
            }
            None => true,
        })
        .collect();
    (ok, why)
}

/// `location` (absolute, or a path on `base`'s host) as a URI.
pub(crate) fn resolve(base: &Uri, location: &str) -> Option<Uri> {
    if location.starts_with('/') && !location.starts_with("//") {
        let authority = base.authority()?;
        return format!("https://{authority}{location}").parse().ok();
    }
    let uri: Uri = location.parse().ok()?;
    uri.scheme()?;
    uri.authority()?;
    Some(uri)
}

/// The host of `uri` for messages.
pub(crate) fn host_of(uri: &Uri) -> String {
    uri.authority()
        .map(|a| a.as_str().to_string())
        .unwrap_or_else(|| "the registry".into())
}

/// `uri` without its query (which may hold a token's scope) for messages.
fn shown_uri(uri: &Uri) -> String {
    let scheme = uri.scheme_str().unwrap_or("");
    let path = uri.path();
    match uri.authority() {
        Some(a) => format!("{scheme}://{a}{path}"),
        None => path.to_string(),
    }
}

/// The error and its sources, `: `-joined (hyper's own says only "client
/// error (Connect)").
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let t = s.to_string();
        if !out.contains(&t) {
            out.push_str(": ");
            out.push_str(&t);
        }
        src = s.source();
    }
    out
}

/// `s` percent-encoded for a query value.
pub(crate) fn query_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_and_absolute_locations() {
        let base: Uri = "https://ghcr.io/v2/a/tags/list".parse().unwrap();
        assert_eq!(
            resolve(&base, "/v2/a/tags/list?last=x")
                .unwrap()
                .to_string(),
            "https://ghcr.io/v2/a/tags/list?last=x"
        );
        assert_eq!(
            resolve(&base, "https://evil.com/x")
                .unwrap()
                .authority()
                .unwrap()
                .as_str(),
            "evil.com"
        );
        assert!(resolve(&base, "//evil.com/x").is_none());
        assert!(resolve(&base, "x/y").is_none());
    }

    #[test]
    fn resolved_addresses_are_checked_too() {
        let a = |s: &str| s.parse::<SocketAddr>().unwrap();
        let (ok, why) = keep_allowed(vec![a("127.0.0.1:0"), a("140.82.112.3:0")], false);
        assert_eq!(ok, vec![a("140.82.112.3:0")]);
        assert!(why.unwrap().contains("loopback"));
        let (ok, why) = keep_allowed(vec![a("169.254.169.254:0"), a("[fe80::1]:0")], true);
        assert!(ok.is_empty());
        assert!(why.unwrap().contains("link-local"));
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_this_machine_is_not_connected_to() {
        use tower::ServiceExt as _;
        let name: Name = "localhost".parse().unwrap();
        let e = Guarded {
            allow_loopback: false,
        }
        .oneshot(name)
        .await
        .unwrap_err();
        assert!(e.to_string().contains("resolves to this machine"), "{e}");
    }

    #[test]
    fn escapes_query_values() {
        assert_eq!(
            query_escape("repository:library/mongo:pull"),
            "repository%3Alibrary%2Fmongo%3Apull"
        );
        assert_eq!(query_escape("a b&c=d"), "a%20b%26c%3Dd");
    }

    #[test]
    fn refuses_plain_http_and_hosts_it_must_not_contact() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let h = Https::new(Vec::new(), false).unwrap();
        let e = h.check(&"http://ghcr.io/v2/".parse().unwrap()).unwrap_err();
        assert!(e.contains("only contacts registries over HTTPS"), "{e}");
        assert!(h
            .check(&"https://169.254.169.254/".parse().unwrap())
            .is_err());
        assert!(h
            .check(&"https://localhost:5000/".parse().unwrap())
            .is_err());
        assert!(h.check(&"https://ghcr.io/v2/".parse().unwrap()).is_ok());
    }
}
