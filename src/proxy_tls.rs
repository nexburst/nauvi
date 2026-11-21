//! The TLS connection to an `https://` proxy (#362).
//!
//! kube makes the TLS handshake with an `https://` proxy using the
//! cluster's TLS settings: its certificate authority, tls-server-name,
//! insecure-skip-tls-verify and client certificate. A kubeconfig could then
//! make nauvi trust a host that impersonates the proxy, which would get the
//! proxy's password and see the client certificate. So every client with an
//! `https://` proxy (the app's setting or a kubeconfig's proxy-url) gets
//! the connection to the proxy from here instead:
//!
//! - the proxy's certificate is checked against the system's trust store
//!   (the platform verifier, as kube uses for a cluster without a CA), plus
//!   the CA file set with the proxy, if any ([`ProxyTrust`]);
//! - the name checked is the proxy's host;
//! - no client certificate is sent;
//! - never the cluster's CA, tls-server-name or insecure-skip-tls-verify.
//!
//! Inside the CONNECT tunnel the TLS to the API server is the cluster's own,
//! end to end, as through an `http://` proxy (see `forward_client`).

use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use tower::util::MapErr;
use tower::{BoxError, ServiceExt as _};

/// Start of the error of a failed TLS handshake with the proxy (its
/// certificate refused, or no TLS at all): `crate::auth` tells it from a
/// certificate problem of the cluster by it.
pub const PROXY_TLS_FAILED: &str = "TLS with the proxy failed";

/// The largest CA file read (a bundle of a few hundred certificates).
const MAX_CA_FILE: u64 = 1024 * 1024;

/// What a proxy's certificate is checked against: the system's trust store
/// and these extra roots (the proxy's CA file).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ProxyTrust {
    extra_roots: Vec<CertificateDer<'static>>,
}

impl fmt::Debug for ProxyTrust {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ProxyTrust({} extra roots)", self.extra_roots.len())
    }
}

impl ProxyTrust {
    /// The system's trust store only.
    pub fn system() -> Self {
        Self::default()
    }

    /// The system's trust store and the certificates of the PEM file at
    /// `path` (at least one).
    pub fn from_ca_file(path: &Path) -> Result<Self, String> {
        let shown = path.display();
        if !path.is_absolute() {
            return Err(format!(
                "Give the full path of the proxy's CA file, not {shown}."
            ));
        }
        let meta = std::fs::metadata(path)
            .map_err(|e| format!("Cannot read the proxy's CA file {shown}: {e}."))?;
        if !meta.is_file() {
            return Err(format!("The proxy's CA file {shown} is not a file."));
        }
        if meta.len() > MAX_CA_FILE {
            return Err(format!(
                "The proxy's CA file {shown} is too big for a certificate file."
            ));
        }
        let pem = std::fs::read(path)
            .map_err(|e| format!("Cannot read the proxy's CA file {shown}: {e}."))?;
        Self::from_pem(&pem).map_err(|e| format!("The proxy's CA file {shown} {e}."))
    }

    /// The system's trust store and the certificates in `pem`.
    fn from_pem(pem: &[u8]) -> Result<Self, String> {
        let mut extra_roots = Vec::new();
        for cert in CertificateDer::pem_slice_iter(pem) {
            extra_roots.push(cert.map_err(|e| format!("is not valid PEM ({e})"))?);
        }
        if extra_roots.is_empty() {
            return Err("has no PEM certificate (-----BEGIN CERTIFICATE-----)".into());
        }
        // A certificate the verifier cannot use as a root is refused now,
        // not at the first connection.
        let mut store = rustls::RootCertStore::empty();
        for cert in &extra_roots {
            store
                .add(cert.clone())
                .map_err(|e| format!("has a certificate that cannot be a CA ({e})"))?;
        }
        Ok(Self { extra_roots })
    }

    /// How many certificates the CA file added.
    pub fn extra_roots(&self) -> usize {
        self.extra_roots.len()
    }

    /// The TLS client settings for the proxy: the platform verifier with
    /// the extra roots, and no client certificate.
    pub fn client_config(&self) -> Result<rustls::ClientConfig, rustls::Error> {
        let builder = rustls::ClientConfig::builder();
        let provider = builder.crypto_provider().clone();
        let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(
            self.extra_roots.iter().cloned(),
            provider,
        )?;
        Ok(builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth())
    }
}

/// A failed TLS handshake with the proxy.
#[derive(Debug)]
pub struct ProxyTlsError(BoxError);

impl fmt::Display for ProxyTlsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{PROXY_TLS_FAILED}: {}", self.0)
    }
}

impl std::error::Error for ProxyTlsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.0)
    }
}

/// A failed TCP connection to the proxy, as it was: told apart from a TLS
/// failure by its type.
#[derive(Debug)]
pub(crate) struct ProxyTcpError(BoxError);

impl fmt::Display for ProxyTcpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for ProxyTcpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source()
    }
}

type TcpError = <HttpConnector as tower::Service<http::Uri>>::Error;
type Tcp = MapErr<HttpConnector, fn(TcpError) -> ProxyTcpError>;

/// The connector to an `https://` proxy: TCP over `http`, then TLS as the
/// module docs say. The proxy's URI is what it is called with.
pub(crate) type ProxyConnector = MapErr<HttpsConnector<Tcp>, fn(BoxError) -> BoxError>;

fn tcp_error(e: TcpError) -> ProxyTcpError {
    ProxyTcpError(Box::new(e))
}

fn classify(e: BoxError) -> BoxError {
    match e.downcast::<ProxyTcpError>() {
        Ok(tcp) => tcp.0,
        Err(e) => Box::new(ProxyTlsError(e)),
    }
}

/// [`ProxyConnector`] over `http` (TCP), trusting `trust`.
pub(crate) fn connector(
    http: HttpConnector,
    trust: &ProxyTrust,
) -> Result<ProxyConnector, kube::Error> {
    let tls = trust
        .client_config()
        .map_err(|e| kube::Error::Service(Box::new(ProxyTlsError(Box::new(e)))))?;
    let tcp: Tcp = http.map_err(tcp_error as fn(_) -> _);
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls)
        .https_only()
        .enable_http1()
        .wrap_connector(tcp);
    Ok(https.map_err(classify as fn(_) -> _))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ca_pem() -> String {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.self_signed(&key).unwrap().pem()
    }

    fn temp(name: &str, body: &[u8]) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nauvi-362-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn reads_a_ca_file_and_says_what_is_wrong_with_one() {
        let good = temp("ca.pem", format!("{}{}", ca_pem(), ca_pem()).as_bytes());
        assert_eq!(ProxyTrust::from_ca_file(&good).unwrap().extra_roots(), 2);

        let e = ProxyTrust::from_ca_file(Path::new("ca.pem")).unwrap_err();
        assert!(e.contains("full path"), "{e}");
        let missing = good.with_file_name("missing.pem");
        let e = ProxyTrust::from_ca_file(&missing).unwrap_err();
        assert!(e.starts_with("Cannot read the proxy's CA file"), "{e}");
        let e = ProxyTrust::from_ca_file(good.parent().unwrap()).unwrap_err();
        assert!(e.contains("is not a file"), "{e}");
        let empty = temp("empty.pem", b"not a certificate\n");
        let e = ProxyTrust::from_ca_file(&empty).unwrap_err();
        assert!(e.contains("has no PEM certificate"), "{e}");
        let bad = temp(
            "bad.pem",
            b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        );
        let e = ProxyTrust::from_ca_file(&bad).unwrap_err();
        assert!(e.contains("cannot be a CA"), "{e}");
    }

    #[test]
    fn the_proxy_never_gets_a_client_certificate() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let trust = ProxyTrust::from_pem(ca_pem().as_bytes()).unwrap();
        for t in [ProxyTrust::system(), trust] {
            let config = t.client_config().unwrap();
            assert!(!config.client_auth_cert_resolver.has_certs());
        }
    }

    #[test]
    fn tcp_and_tls_failures_are_told_apart() {
        let tcp: BoxError = Box::new(ProxyTcpError("connection refused".into()));
        let e = classify(tcp);
        assert_eq!(e.to_string(), "connection refused");
        assert!(e.downcast_ref::<ProxyTlsError>().is_none());
        let tls = classify("invalid peer certificate: UnknownIssuer".into());
        assert_eq!(
            tls.to_string(),
            format!("{PROXY_TLS_FAILED}: invalid peer certificate: UnknownIssuer")
        );
    }
}
