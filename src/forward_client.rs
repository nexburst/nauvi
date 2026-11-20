//! The client port-forwards open their tunnels with (#374).
//!
//! kube builds its connections with `TCP_NODELAY` off. rustls sends the
//! TLS Finished and the HTTP request as two writes, so Nagle holds the
//! request until the API server ACKs the first one, and its delayed ACK
//! takes about 40 ms. Every port-forward tunnel is a new connection (the
//! upgraded connection leaves hyper's pool), so each one paid that. kubectl
//! (Go) turns Nagle off.
//!
//! [`for_port_forwards`] builds a client through the usual path
//! ([`crate::client`]: kubeconfig, the cluster's proxy setting, the exec
//! credential cache, the first `/version` request), but with the same stack
//! as kube's own `ClientBuilder::try_from` over a connector with
//! `TCP_NODELAY` on. Other clients keep kube's stack as it is.

use http::{Request, Response};
use hyper_util::client::legacy::connect::{proxy, HttpConnector};
use hyper_util::rt::TokioExecutor;
use kube::client::{Body, ClientBuilder, ConfigExt, DynBody};
use std::future::Future;
use tower::util::BoxService;
use tower::{BoxError, ServiceBuilder, ServiceExt as _};
use tower_http::ServiceExt as _;

tokio::task_local! {
    static FOR_FORWARDS: ();
}

/// The service a [`ClientBuilder`] from kube's own `try_from` has.
type Stack = BoxService<Request<Body>, Response<Box<DynBody>>, BoxError>;

/// Run `build` (one of the `client_*` functions) so that the client it
/// builds is one for port-forwards: `TCP_NODELAY` on.
pub async fn for_port_forwards<F: Future>(build: F) -> F::Output {
    FOR_FORWARDS.scope((), build).await
}

/// kube's `ClientBuilder::try_from(config)`, or inside
/// [`for_port_forwards`] the same stack with `TCP_NODELAY` on.
pub(crate) fn builder(config: kube::Config) -> Result<ClientBuilder<Stack>, kube::Error> {
    if FOR_FORWARDS.try_with(|_| ()).is_ok() {
        nodelay_builder(config)
    } else {
        ClientBuilder::try_from(config)
    }
}

/// kube's `ClientBuilder::try_from`, with `TCP_NODELAY` on and without its
/// tracing layer.
fn nodelay_builder(config: kube::Config) -> Result<ClientBuilder<Stack>, kube::Error> {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_nodelay(true);
    match config.proxy_url.clone() {
        Some(url) if url.scheme_str() == Some("socks5") => {
            stack(proxy::SocksV5::new(url, http), config)
        }
        Some(url) if url.scheme_str() == Some("http") => {
            let tunnel = with_basic_auth(&url, proxy::Tunnel::new(url.clone(), http));
            stack(tunnel, config)
        }
        Some(url) if url.scheme_str() == Some("https") => {
            let to_proxy = config.rustls_https_connector_with_connector(http)?;
            let tunnel = with_basic_auth(&url, proxy::Tunnel::new(url.clone(), to_proxy));
            stack(tunnel, config)
        }
        Some(url) => Err(kube::Error::ProxyProtocolUnsupported {
            proxy_url: Box::new(url),
        }),
        None => stack(http, config),
    }
}

/// kube's `make_generic_builder`: TLS, timeouts, then the base URI,
/// decompression, retry, auth and extra headers layers.
fn stack<C>(connector: C, config: kube::Config) -> Result<ClientBuilder<Stack>, kube::Error>
where
    C: tower::Service<http::Uri> + Clone + Send + Sync + 'static,
    C::Response: hyper_util::client::legacy::connect::Connection
        + hyper::rt::Read
        + hyper::rt::Write
        + Send
        + Unpin
        + 'static,
    C::Future: Send + 'static,
    C::Error: Into<BoxError> + Send + Sync + std::error::Error + 'static,
{
    let tls = config.rustls_https_connector_with_connector(connector)?;
    let mut connector = hyper_timeout::TimeoutConnector::new(tls);
    connector.set_connect_timeout(config.connect_timeout);
    connector.set_read_timeout(config.read_timeout);
    connector.set_write_timeout(config.write_timeout);
    connector.set_reset_reader_on_write(config.reset_reader_on_write);
    let client: hyper_util::client::legacy::Client<_, Body> =
        hyper_util::client::legacy::Builder::new(TokioExecutor::new()).build(connector);

    let decompression = tower_http::decompression::DecompressionLayer::new()
        .no_br()
        .no_deflate()
        .no_zstd()
        .gzip(!config.disable_compression);
    let service = ServiceBuilder::new()
        .layer(config.base_uri_layer())
        .layer(decompression)
        .option_layer(config.default_retry.then(|| {
            tower::retry::RetryLayer::new(kube::client::retry::RetryPolicy::server_retry())
        }))
        .option_layer(config.auth_layer()?)
        .layer(config.extra_headers_layer()?)
        .map_err(BoxError::from)
        .service(client);
    let service = service
        .map_response_body(|body| {
            Box::new(http_body_util::BodyExt::map_err(body, BoxError::from)) as Box<DynBody>
        })
        .boxed();
    Ok(ClientBuilder::new(
        service,
        config.default_namespace.clone(),
    ))
}

/// `Proxy-Authorization: Basic` from the proxy URL's user and password, as
/// kube does (percent-escapes decoded first).
fn with_basic_auth<C>(url: &http::Uri, tunnel: proxy::Tunnel<C>) -> proxy::Tunnel<C> {
    use base64::Engine;
    let Some((userinfo, _)) = url.authority().and_then(|a| a.as_str().split_once('@')) else {
        return tunnel;
    };
    let decoded = percent_decode(userinfo);
    let value = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(decoded)
    );
    match http::HeaderValue::from_str(&value) {
        Ok(header) => tunnel.with_auth(header),
        Err(_) => tunnel,
    }
}

/// `%XX` escapes decoded; anything malformed is kept as it is.
fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_credentials_are_percent_decoded() {
        assert_eq!(percent_decode("us%40er:p%3Ass%25"), b"us@er:p:ss%");
        assert_eq!(percent_decode("plain:pw"), b"plain:pw");
        assert_eq!(percent_decode("bad%zz%4"), b"bad%zz%4");
    }

    #[tokio::test]
    async fn only_clients_built_for_forwards_turn_nagle_off() {
        let config = kube::Config::new("https://127.0.0.1:6443".parse().unwrap());
        assert!(FOR_FORWARDS.try_with(|_| ()).is_err());
        assert!(builder(config.clone()).is_ok());
        let inside = for_port_forwards(async { FOR_FORWARDS.try_with(|_| ()).is_ok() }).await;
        assert!(inside);
        for_port_forwards(async { builder(config).map(|_| ()) })
            .await
            .unwrap();
    }
}
