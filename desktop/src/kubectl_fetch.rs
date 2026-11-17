//! The https fetcher of the kubectl download (#331, see
//! `nauvi::kubectl_download`).
//!
//! - https only (`https_only`), and redirects only to https on the
//!   download host (or `cdn.dl.k8s.io` for the official one).
//! - Through the cluster's proxy setting (#329) when one is set, else
//!   directly: like the cluster connection, proxy environment variables
//!   (`HTTPS_PROXY`) are not used. The proxy is used even for a cluster on
//!   this machine, since dl.k8s.io is not.
//! - Debug builds only: `NAUVI_KUBECTL_DOWNLOAD_BASE` points at another
//!   `https://` origin and `NAUVI_KUBECTL_DOWNLOAD_CA` (a PEM file) is
//!   then the only CA trusted, for the QA scenario's local HTTPS server.
//!   Release builds ignore both.

use nauvi::kubectl_download::{DownloadBase, Fetch, OFFICIAL_HOST};
use nauvi::proxy::{redact_credentials, ClusterProxy};
use std::time::Duration;

pub(crate) const BASE_ENV: &str = "NAUVI_KUBECTL_DOWNLOAD_BASE";
pub(crate) const CA_ENV: &str = "NAUVI_KUBECTL_DOWNLOAD_CA";

/// The CDN dl.k8s.io may redirect to.
const OFFICIAL_CDN: &str = "cdn.dl.k8s.io";

/// The download base: dl.k8s.io, or in a debug build `BASE_ENV`'s, with
/// `CA_ENV`'s CA.
pub(crate) fn download_base() -> Result<(DownloadBase, Option<Vec<u8>>), String> {
    base_from(
        cfg!(debug_assertions),
        std::env::var(BASE_ENV).ok(),
        std::env::var_os(CA_ENV),
    )
}

fn base_from(
    debug: bool,
    base: Option<String>,
    ca: Option<std::ffi::OsString>,
) -> Result<(DownloadBase, Option<Vec<u8>>), String> {
    let base = base.filter(|b| debug && !b.trim().is_empty());
    let Some(base) = base else {
        return Ok((DownloadBase::official(), None));
    };
    let base = DownloadBase::parse(&base).map_err(|e| format!("{BASE_ENV}: {e}"))?;
    let ca = match ca.filter(|c| !c.is_empty()) {
        Some(path) => Some(
            std::fs::read(&path)
                .map_err(|e| format!("{CA_ENV}: cannot read {}: {e}", path.to_string_lossy()))?,
        ),
        None => None,
    };
    Ok((base, ca))
}

/// GETs over https from one host.
pub(crate) struct HttpsFetch {
    client: reqwest::Client,
}

impl HttpsFetch {
    /// A client for `base`, through `proxy` if set, trusting only `ca`
    /// (PEM) if given.
    pub(crate) fn new(
        base: &DownloadBase,
        proxy: Option<&ClusterProxy>,
        ca: Option<&[u8]>,
    ) -> Result<Self, String> {
        // Like the updater: one crypto provider for rustls, process-wide.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let allowed: Vec<String> = if base.is_official() {
            vec![OFFICIAL_HOST.into(), OFFICIAL_CDN.into()]
        } else {
            vec![base.host().to_string()]
        };
        let redirects = reqwest::redirect::Policy::custom(move |attempt| {
            let url = attempt.url();
            let ok = url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|h| allowed.iter().any(|a| a == h));
            let shown = redact_credentials(url.as_str());
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if ok {
                attempt.follow()
            } else {
                attempt.error(format!("refused a redirect to {shown}"))
            }
        });
        let mut builder = reqwest::Client::builder()
            .https_only(true)
            .redirect(redirects)
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .user_agent(concat!("nauvi/", env!("CARGO_PKG_VERSION")));
        builder = match proxy {
            Some(p) => builder.proxy(
                reqwest::Proxy::all(p.url.secret_text())
                    .map_err(|e| redact_credentials(&format!("the cluster's proxy: {e}")))?,
            ),
            None => builder.no_proxy(),
        };
        if let Some(pem) = ca {
            let cert = reqwest::Certificate::from_pem(pem)
                .map_err(|e| format!("{CA_ENV} is not a PEM certificate: {e}"))?;
            builder = builder.tls_certs_only([cert]);
        }
        let client = builder
            .build()
            .map_err(|e| format!("cannot set up the download: {e}"))?;
        Ok(HttpsFetch { client })
    }
}

impl Fetch for HttpsFetch {
    async fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
        let fail = |e: reqwest::Error| {
            let mut text = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(s) = source {
                text = format!("{text}: {s}");
                source = s.source();
            }
            redact_credentials(&format!("Could not download {url}: {text}"))
        };
        let mut resp = self.client.get(url).send().await.map_err(fail)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!(
                "Could not download {url}: the server answered {status}."
            ));
        }
        if resp.content_length().is_some_and(|n| n > max) {
            return Err(format!(
                "{url} is larger than expected; it was not downloaded."
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(fail)? {
            if (body.len() + chunk.len()) as u64 > max {
                return Err(format!(
                    "{url} is larger than expected; it was not downloaded."
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_only_use_dl_k8s_io() {
        let (base, ca) = base_from(
            false,
            Some("https://127.0.0.1:8443".into()),
            Some("/nonexistent.pem".into()),
        )
        .unwrap();
        assert!(base.is_official());
        assert!(ca.is_none());
        let (base, _) = base_from(true, None, None).unwrap();
        assert!(base.is_official());
    }

    #[test]
    fn the_debug_override_is_https_only() {
        let (base, ca) = base_from(true, Some("https://127.0.0.1:8443".into()), None).unwrap();
        assert_eq!(base.host(), "127.0.0.1");
        assert!(ca.is_none());
        assert!(base_from(true, Some("http://127.0.0.1:8080".into()), None).is_err());
        let e = base_from(
            true,
            Some("https://127.0.0.1:8443".into()),
            Some("/nauvi-331-missing.pem".into()),
        )
        .unwrap_err();
        assert!(e.contains(CA_ENV), "{e}");
    }

    #[tokio::test]
    async fn plain_http_is_refused() {
        let fetch = HttpsFetch::new(&DownloadBase::official(), None, None).unwrap();
        // Refused before connecting: nothing listens there.
        let e = fetch
            .get(
                "http://127.0.0.1:9/release/v1.31.2/bin/linux/amd64/kubectl",
                10,
            )
            .await
            .unwrap_err();
        assert!(e.contains("Could not download"), "{e}");
        assert!(
            e.to_lowercase().contains("https") || e.contains("scheme"),
            "{e}"
        );
    }
}
