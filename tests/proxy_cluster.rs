//! The per-cluster proxy setting (#329) against the kind cluster, through
//! small HTTP CONNECT, HTTPS CONNECT (#362) and SOCKS5 proxies started in
//! the test on 127.0.0.1.
//! `#[ignore]`d like `cluster.rs`; run with
//! `cargo test --test proxy_cluster -- --ignored`. Only reads the demo
//! objects (a list, a watch, an `echo` in a demo/web pod, a port-forward
//! to demo/web).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use futures::StreamExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::runtime::watcher;
use kube::Client;
use nauvi::proxy::{ClusterProxy, ProxyUrl};
use nauvi::{
    client_for_context_via, exec_command, ForwardKind, ForwardTarget, LocalPort, PortForward,
    RemotePort,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TIMEOUT: Duration = Duration::from_secs(60);

fn context() -> String {
    std::env::var("NAUVI_TEST_CONTEXT").unwrap_or_else(|_| "kind-nauvi-test".to_string())
}

/// What a test proxy saw: the targets it tunnelled to, and the requests it
/// turned away. [`Seen::stop`] stops the proxy and cuts its tunnels.
struct Seen {
    tunnels: Mutex<Vec<String>>,
    refused: AtomicUsize,
    stopped: tokio::sync::watch::Sender<bool>,
}

impl Seen {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            tunnels: Mutex::default(),
            refused: AtomicUsize::new(0),
            stopped: tokio::sync::watch::channel(false).0,
        })
    }

    fn tunnels(&self) -> Vec<String> {
        self.tunnels.lock().unwrap().clone()
    }

    fn stop(&self) {
        self.stopped.send_replace(true);
    }

    /// Resolves once [`Self::stop`] was called.
    fn stopped(&self) -> impl std::future::Future<Output = ()> {
        let mut rx = self.stopped.subscribe();
        async move {
            let _ = rx.wait_for(|s| *s).await;
        }
    }
}

/// Accept connections until the proxy is stopped, each served by `serve`.
fn serve<F, Fut>(listener: TcpListener, seen: Arc<Seen>, serve: F)
where
    F: Fn(TcpStream, Arc<Seen>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            let conn = tokio::select! {
                c = listener.accept() => c,
                () = seen.stopped() => return,
            };
            let Ok((conn, _)) = conn else { return };
            let s = seen.clone();
            let work = serve(conn, s.clone());
            tokio::spawn(async move {
                tokio::select! {
                    _ = work => {}
                    () = s.stopped() => {}
                }
            });
        }
    });
}

/// An HTTP CONNECT proxy on a random port of 127.0.0.1. With `auth`, it
/// wants `Proxy-Authorization: Basic <auth>` and answers 407 otherwise.
async fn http_proxy(auth: Option<&str>) -> Result<(u16, Arc<Seen>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let seen = Seen::new();
    let want = auth.map(str::to_string);
    serve(listener, seen.clone(), move |conn, s| {
        let want = want.clone();
        async move { http_tunnel(conn, &s, want.as_deref()).await }
    });
    Ok((port, seen))
}

async fn http_tunnel<S>(mut conn: S, seen: &Seen, want: Option<&str>) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if conn.read(&mut byte).await? == 0 || head.len() > 16 * 1024 {
            return Ok(());
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let mut lines = head.lines();
    let request = lines.next().unwrap_or_default();
    let mut parts = request.split_whitespace();
    let (Some("CONNECT"), Some(target)) = (parts.next(), parts.next()) else {
        conn.write_all(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            .await?;
        return Ok(());
    };
    // `Basic <credentials>`: the scheme in any case, the credentials exact.
    let credentials = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("proxy-authorization"))
        .and_then(|(_, v)| v.trim().split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("basic"))
        .map(|(_, c)| c.trim().to_string());
    if let Some(want) = want {
        if credentials.as_deref() != Some(want) {
            seen.refused.fetch_add(1, Ordering::SeqCst);
            conn.write_all(
                b"HTTP/1.1 407 Proxy Authentication Required\r\n\
                  Proxy-Authenticate: Basic realm=\"test\"\r\ncontent-length: 0\r\n\r\n",
            )
            .await?;
            return Ok(());
        }
    }
    let mut upstream = TcpStream::connect(target).await?;
    seen.tunnels.lock().unwrap().push(target.to_string());
    conn.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    tokio::io::copy_bidirectional(&mut conn, &mut upstream).await?;
    Ok(())
}

/// A SOCKS5 proxy (no authentication, CONNECT only) on 127.0.0.1.
async fn socks5_proxy() -> Result<(u16, Arc<Seen>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let seen = Seen::new();
    serve(listener, seen.clone(), |conn, s| async move {
        socks5_tunnel(conn, &s).await
    });
    Ok((port, seen))
}

async fn socks5_tunnel(mut conn: TcpStream, seen: &Seen) -> Result<()> {
    let mut hello = [0u8; 2];
    conn.read_exact(&mut hello).await?;
    let mut methods = vec![0u8; hello[1] as usize];
    conn.read_exact(&mut methods).await?;
    ensure!(
        hello[0] == 5 && methods.contains(&0),
        "not a SOCKS5 no-auth hello"
    );
    conn.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    conn.read_exact(&mut req).await?;
    ensure!(req[0] == 5 && req[1] == 1, "not a CONNECT");
    let host = match req[3] {
        1 => {
            let mut ip = [0u8; 4];
            conn.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            conn.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            conn.read_exact(&mut name).await?;
            String::from_utf8(name)?
        }
        4 => {
            let mut ip = [0u8; 16];
            conn.read_exact(&mut ip).await?;
            format!("[{}]", std::net::Ipv6Addr::from(ip))
        }
        other => bail!("address type {other}"),
    };
    let mut port = [0u8; 2];
    conn.read_exact(&mut port).await?;
    let target = format!("{host}:{}", u16::from_be_bytes(port));
    let mut upstream = TcpStream::connect(&target).await?;
    seen.tunnels.lock().unwrap().push(target);
    conn.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    tokio::io::copy_bidirectional(&mut conn, &mut upstream).await?;
    Ok(())
}

async fn client_via(url: &str, local: bool) -> Result<Client> {
    let proxy = ClusterProxy {
        url: ProxyUrl::parse(url).map_err(anyhow::Error::msg)?,
        local,
        ca_file: None,
    };
    let ctx = context();
    tokio::time::timeout(
        Duration::from_secs(20),
        client_for_context_via(Some(&ctx), false, Some(&proxy)),
    )
    .await
    .context("timed out building client")?
}

/// The API server's `host:port`, as a CONNECT names it.
fn server_authority(client: &Client) -> String {
    let _ = client;
    let kc = kube::config::Kubeconfig::read().expect("kubeconfig");
    let ctx = context();
    let cluster = kc
        .contexts
        .iter()
        .find(|c| c.name == ctx)
        .and_then(|c| c.context.as_ref())
        .map(|c| c.cluster.clone())
        .expect("context");
    let server = kc
        .clusters
        .iter()
        .find(|c| c.name == cluster)
        .and_then(|c| c.cluster.as_ref())
        .and_then(|c| c.server.clone())
        .expect("server");
    let uri: http::Uri = server.parse().expect("server URL");
    let port = uri.port_u16().unwrap_or(443);
    format!("{}:{port}", uri.host().unwrap_or_default())
}

async fn http_get(port: u16) -> Result<String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await?;
    s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await?;
    let mut body = String::new();
    s.read_to_string(&mut body).await?;
    Ok(body)
}

#[tokio::test]
#[ignore]
async fn the_proxy_carries_requests_watches_exec_and_forwards() -> Result<()> {
    // user "me", password "p@ss:word" (percent-encoded in the URL).
    let basic = "bWU6cEBzczp3b3Jk";
    let (port, seen) = http_proxy(Some(basic)).await?;
    let url = format!("http://me:p%40ss%3Aword@127.0.0.1:{port}");
    let client = client_via(&url, true).await?;
    let server = server_authority(&client);
    ensure!(
        !seen.tunnels().is_empty(),
        "building the client used no tunnel"
    );

    tokio::time::timeout(TIMEOUT, async {
        // A list.
        let pods: Api<Pod> = Api::namespaced(client.clone(), "demo");
        let list = pods.list(&ListParams::default().labels("app=web")).await?;
        let web = list
            .items
            .iter()
            .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
            .and_then(|p| p.metadata.name.clone())
            .context("no running demo/web pod")?;

        // A watch: its first event.
        let mut events = watcher(pods.clone(), watcher::Config::default()).boxed();
        events.next().await.context("watch ended")??;

        // An exec.
        let out = exec_command(
            &client,
            "demo",
            &web,
            None,
            &["sh".into(), "-c".into(), "echo through-the-proxy".into()],
        )
        .await?;
        ensure!(
            out.stdout.contains("through-the-proxy"),
            "{} {}",
            out.stdout,
            out.stderr
        );

        // A port-forward, with its own client (Nagle off, #374): through
        // the same proxy, with the same percent-decoded credentials.
        let before = seen.tunnels().len();
        let forward_client = nauvi::for_port_forwards(client_via(&url, true)).await?;
        ensure!(
            seen.tunnels().len() > before,
            "the forward client went around the proxy"
        );
        let fwd = PortForward::start(
            &forward_client,
            ForwardTarget {
                kind: ForwardKind::Deployment,
                namespace: "demo".into(),
                name: "web".into(),
            },
            RemotePort::Number(80),
            LocalPort::Random,
        )
        .await?;
        let body = http_get(fwd.local_port).await?;
        ensure!(body.contains("Welcome to nginx"), "{body}");
        drop(fwd);

        // Every connection went through the proxy: without it, nothing
        // works any more.
        seen.stop();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let cut = exec_command(&client, "demo", &web, None, &["true".into()]).await;
        ensure!(
            cut.as_ref().map(|r| !r.success).unwrap_or(true),
            "an exec worked without the proxy"
        );
        ensure!(
            pods.list(&ListParams::default()).await.is_err(),
            "a list worked without the proxy"
        );
        anyhow::Ok(())
    })
    .await
    .context("timed out")??;

    let tunnels = seen.tunnels();
    ensure!(
        tunnels.iter().all(|t| *t == server),
        "tunnelled somewhere else than {server}: {tunnels:?}"
    );
    ensure!(seen.refused.load(Ordering::SeqCst) == 0);
    Ok(())
}

#[tokio::test]
#[ignore]
async fn a_cluster_on_this_machine_skips_the_proxy_unless_asked() -> Result<()> {
    let (port, seen) = http_proxy(None).await?;
    let client = client_via(&format!("http://127.0.0.1:{port}"), false).await?;
    let pods: Api<Pod> = Api::namespaced(client, "demo");
    tokio::time::timeout(TIMEOUT, pods.list(&ListParams::default()))
        .await
        .context("timed out")??;
    // kind's server is on 127.0.0.1.
    ensure!(seen.tunnels().is_empty(), "{:?}", seen.tunnels());
    Ok(())
}

#[tokio::test]
#[ignore]
async fn rejected_proxy_credentials_fail_without_showing_them() -> Result<()> {
    let (port, seen) = http_proxy(Some("bWU6cmlnaHQ=")).await?; // me:right
    let url = format!("http://me:wrong-secret@127.0.0.1:{port}");
    let err = match client_via(&url, true).await {
        Ok(_) => bail!("the proxy should have refused the credentials"),
        Err(e) => nauvi::error_text(&e),
    };
    eprintln!("{err}");
    ensure!(
        seen.refused.load(Ordering::SeqCst) > 0,
        "the proxy saw nothing"
    );
    ensure!(!err.contains("wrong-secret"), "{err}");
    ensure!(err.contains("user name and password"), "{err}");
    ensure!(
        err.contains(&format!("http://[redacted]@127.0.0.1:{port}")),
        "{err}"
    );
    Ok(())
}

#[tokio::test]
#[ignore]
async fn a_proxy_that_is_down_says_which_one() -> Result<()> {
    // A port nothing listens on any more.
    let port = TcpListener::bind("127.0.0.1:0").await?.local_addr()?.port();
    let err = match client_via(&format!("http://me:hunter2@127.0.0.1:{port}"), true).await {
        Ok(_) => bail!("connected through a proxy that is not running"),
        Err(e) => nauvi::error_text(&e),
    };
    eprintln!("{err}");
    ensure!(!err.contains("hunter2"), "{err}");
    ensure!(err.contains("through the proxy"), "{err}");
    Ok(())
}

#[tokio::test]
#[ignore]
async fn a_socks5_proxy_works_too() -> Result<()> {
    let (port, seen) = socks5_proxy().await?;
    let client = client_via(&format!("socks5://127.0.0.1:{port}"), true).await?;
    let server = server_authority(&client);
    let pods: Api<Pod> = Api::namespaced(client, "demo");
    tokio::time::timeout(TIMEOUT, pods.list(&ListParams::default()))
        .await
        .context("timed out")??;
    let tunnels = seen.tunnels();
    ensure!(!tunnels.is_empty(), "the SOCKS5 proxy saw nothing");
    ensure!(tunnels.iter().all(|t| *t == server), "{tunnels:?}");
    // The port-forward client (#374) too.
    let before = tunnels.len();
    let forward_client =
        nauvi::for_port_forwards(client_via(&format!("socks5://127.0.0.1:{port}"), true)).await?;
    forward_client.apiserver_version().await?;
    ensure!(
        seen.tunnels().len() > before,
        "the forward client went around the SOCKS5 proxy"
    );
    Ok(())
}

// HTTPS proxies (#362).

/// A CA, and a certificate for 127.0.0.1 it signed: an HTTPS proxy's.
struct ProxyCert {
    ca_pem: String,
    cert: rustls::pki_types::CertificateDer<'static>,
    key: rustls::pki_types::PrivateKeyDer<'static>,
}

fn proxy_cert() -> Result<ProxyCert> {
    proxy_cert_for("127.0.0.1")
}

/// A CA, and a certificate for `name` it signed.
fn proxy_cert_for(name: &str) -> Result<ProxyCert> {
    let ca_key = rcgen::KeyPair::generate()?;
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new())?;
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "nauvi-362 test proxy CA");
    let ca = rcgen::CertifiedIssuer::self_signed(ca_params, ca_key)?;
    let key = rcgen::KeyPair::generate()?;
    let params = rcgen::CertificateParams::new(vec![name.to_string()])?;
    let cert = params.signed_by(&key, &ca)?;
    Ok(ProxyCert {
        ca_pem: ca.pem(),
        cert: cert.der().clone(),
        key: rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    })
}

/// Asks every client for a certificate (none required) and counts those
/// that send one: a client must never show the proxy the cluster's.
#[derive(Debug)]
struct CountClientCerts {
    seen: Arc<AtomicUsize>,
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::server::danger::ClientCertVerifier for CountClientCerts {
    fn offer_client_auth(&self) -> bool {
        true
    }
    fn client_auth_mandatory(&self) -> bool {
        false
    }
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::server::danger::ClientCertVerified, rustls::Error> {
        self.seen.fetch_add(1, Ordering::SeqCst);
        Ok(rustls::server::danger::ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// What an HTTPS proxy saw besides [`Seen`]: finished TLS handshakes,
/// failed ones, and client certificates it was shown.
#[derive(Default)]
struct TlsSeen {
    handshakes: AtomicUsize,
    failed: AtomicUsize,
    client_certs: Arc<AtomicUsize>,
}

/// An HTTPS CONNECT proxy on 127.0.0.1 with the certificate of `cert`,
/// wanting `Proxy-Authorization: Basic <auth>` if `auth` is set.
async fn https_proxy(
    cert: &ProxyCert,
    auth: Option<&str>,
) -> Result<(u16, Arc<Seen>, Arc<TlsSeen>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls_seen = Arc::new(TlsSeen::default());
    let verifier = Arc::new(CountClientCerts {
        seen: tls_seen.client_certs.clone(),
        algorithms: provider.signature_verification_algorithms,
    });
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_client_cert_verifier(verifier)
        .with_single_cert(vec![cert.cert.clone()], cert.key.clone_key())?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let seen = Seen::new();
    let want = auth.map(str::to_string);
    let ts = tls_seen.clone();
    serve(listener, seen.clone(), move |conn, s| {
        let (acceptor, want, ts) = (acceptor.clone(), want.clone(), ts.clone());
        async move {
            let tls = match acceptor.accept(conn).await {
                Ok(tls) => tls,
                Err(e) => {
                    ts.failed.fetch_add(1, Ordering::SeqCst);
                    return Err(e.into());
                }
            };
            ts.handshakes.fetch_add(1, Ordering::SeqCst);
            http_tunnel(tls, &s, want.as_deref()).await
        }
    });
    Ok((port, seen, tls_seen))
}

/// The test context's kubeconfig, its cluster entry changed by `change`.
fn kubeconfig_with(change: impl FnOnce(&mut kube::config::Cluster)) -> kube::config::Kubeconfig {
    let mut kc = kube::config::Kubeconfig::read().expect("kubeconfig");
    let ctx = context();
    let cluster = kc
        .contexts
        .iter()
        .find(|c| c.name == ctx)
        .and_then(|c| c.context.as_ref())
        .map(|c| c.cluster.clone())
        .expect("context");
    let entry = kc
        .clusters
        .iter_mut()
        .find(|c| c.name == cluster)
        .and_then(|c| c.cluster.as_mut())
        .expect("cluster");
    change(entry);
    kc
}

/// `pem` in a file of its own under the temp directory.
fn write_ca(pem: &str) -> Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("nauvi-362-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let path = dir.join(format!("ca-{nanos}.pem"));
    std::fs::write(&path, pem)?;
    Ok(path)
}

async fn client_through(
    kubeconfig: kube::config::Kubeconfig,
    proxy: &ClusterProxy,
) -> Result<Client> {
    let ctx = context();
    tokio::time::timeout(
        Duration::from_secs(20),
        nauvi::client_from_kubeconfig_via(kubeconfig, Some(&ctx), false, Some(proxy)),
    )
    .await
    .context("timed out building client")?
}

#[tokio::test]
#[ignore]
async fn an_https_proxy_with_its_own_ca_carries_requests_exec_and_forwards() -> Result<()> {
    let cert = proxy_cert()?;
    let basic = "bWU6cEBzczp3b3Jk"; // me:p@ss:word
    let (port, seen, tls) = https_proxy(&cert, Some(basic)).await?;
    let proxy = ClusterProxy {
        url: ProxyUrl::parse(&format!("https://me:p%40ss%3Aword@127.0.0.1:{port}"))
            .map_err(anyhow::Error::msg)?,
        local: true,
        ca_file: Some(write_ca(&cert.ca_pem)?),
    };
    let kc = kube::config::Kubeconfig::read()?;
    // kind logs in with a client certificate: it is for the API server only.
    let client = client_through(kc.clone(), &proxy).await?;
    let server = server_authority(&client);

    tokio::time::timeout(TIMEOUT, async {
        let pods: Api<Pod> = Api::namespaced(client.clone(), "demo");
        let list = pods.list(&ListParams::default().labels("app=web")).await?;
        let web = list
            .items
            .iter()
            .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
            .and_then(|p| p.metadata.name.clone())
            .context("no running demo/web pod")?;
        let mut events = watcher(pods.clone(), watcher::Config::default()).boxed();
        events.next().await.context("watch ended")??;
        let out = exec_command(
            &client,
            "demo",
            &web,
            None,
            &["sh".into(), "-c".into(), "echo through-tls".into()],
        )
        .await?;
        ensure!(out.stdout.contains("through-tls"), "{}", out.stderr);

        // The port-forward client (#374, #418) too.
        let before = seen.tunnels().len();
        let forward_client = nauvi::for_port_forwards(client_through(kc.clone(), &proxy)).await?;
        ensure!(
            seen.tunnels().len() > before,
            "the forward client went around the proxy"
        );
        let fwd = PortForward::start(
            &forward_client,
            ForwardTarget {
                kind: ForwardKind::Deployment,
                namespace: "demo".into(),
                name: "web".into(),
            },
            RemotePort::Number(80),
            LocalPort::Random,
        )
        .await?;
        let body = http_get(fwd.local_port).await?;
        ensure!(body.contains("Welcome to nginx"), "{body}");
        drop(fwd);
        anyhow::Ok(())
    })
    .await
    .context("timed out")??;

    let tunnels = seen.tunnels();
    ensure!(!tunnels.is_empty(), "the HTTPS proxy saw nothing");
    ensure!(tunnels.iter().all(|t| *t == server), "{tunnels:?}");
    ensure!(
        seen.refused.load(Ordering::SeqCst) == 0,
        "credentials refused"
    );
    ensure!(tls.handshakes.load(Ordering::SeqCst) > 0);
    ensure!(
        tls.client_certs.load(Ordering::SeqCst) == 0,
        "the proxy was shown a client certificate"
    );
    Ok(())
}

#[tokio::test]
#[ignore]
async fn an_https_proxy_the_trust_store_does_not_accept_is_refused() -> Result<()> {
    use base64::Engine as _;
    let cert = proxy_cert()?;
    let (port, seen, tls) = https_proxy(&cert, None).await?;
    let url = format!("https://me:hunter2@127.0.0.1:{port}");
    let setting = |ca_file| -> Result<ClusterProxy> {
        Ok(ClusterProxy {
            url: ProxyUrl::parse(&url).map_err(anyhow::Error::msg)?,
            local: true,
            ca_file,
        })
    };
    let b64 = base64::engine::general_purpose::STANDARD;
    let other_ca = write_ca(&proxy_cert()?.ca_pem)?;

    // What the kubeconfig says about the cluster's TLS never applies to the
    // proxy: not skip-verify, not a CA bundle with the proxy's CA in it.
    let skip_verify = kubeconfig_with(|c| {
        c.insecure_skip_tls_verify = Some(true);
        c.certificate_authority_data = None;
        c.certificate_authority = None;
    });
    let proxy_ca = cert.ca_pem.clone();
    let bundle = kubeconfig_with(move |c| {
        let kind_ca = c
            .certificate_authority_data
            .as_deref()
            .and_then(|d| b64.decode(d).ok())
            .expect("kind's CA data");
        let mut pem = String::from_utf8(kind_ca).expect("PEM");
        pem.push_str(&proxy_ca);
        c.certificate_authority_data = Some(b64.encode(pem));
    });
    let plain = kube::config::Kubeconfig::read()?;
    let cases = [
        ("skip-verify kubeconfig", skip_verify, setting(None)?),
        ("the proxy's CA in the cluster's", bundle, setting(None)?),
        ("another CA file", plain.clone(), setting(Some(other_ca))?),
    ];
    for (name, kc, proxy) in cases {
        for forwards in [false, true] {
            let build = client_through(kc.clone(), &proxy);
            let result = if forwards {
                nauvi::for_port_forwards(build).await
            } else {
                build.await
            };
            let err = match result {
                Ok(_) => bail!("{name}: connected through an untrusted proxy"),
                Err(e) => nauvi::error_text(&e),
            };
            eprintln!("{name}: {err}");
            ensure!(
                err.contains("Certificate problem with the proxy"),
                "{name}: {err}"
            );
            ensure!(
                err.contains(&format!("https://[redacted]@127.0.0.1:{port}")),
                "{err}"
            );
            ensure!(!err.contains("hunter2"), "{name}: {err}");
        }
    }
    ensure!(
        tls.failed.load(Ordering::SeqCst) > 0,
        "no handshake was tried"
    );
    ensure!(
        tls.handshakes.load(Ordering::SeqCst) == 0,
        "a handshake with the untrusted proxy finished"
    );
    ensure!(seen.tunnels().is_empty(), "{:?}", seen.tunnels());
    ensure!(tls.client_certs.load(Ordering::SeqCst) == 0);

    // A CA file that is not there says so before anything connects.
    let missing = setting(Some("/nonexistent/nauvi-362-ca.pem".into()))?;
    let err = match client_through(plain, &missing).await {
        Ok(_) => bail!("connected without the proxy's CA file"),
        Err(e) => nauvi::error_text(&e),
    };
    ensure!(err.contains("Cannot read the proxy's CA file"), "{err}");
    ensure!(!err.contains("hunter2"), "{err}");
    Ok(())
}

#[tokio::test]
#[ignore]
async fn an_https_proxy_with_a_certificate_for_another_host_is_refused() -> Result<()> {
    // Signed by the CA set with the proxy, but for another name: the name
    // checked is the proxy's host, so a trusted CA alone is not enough.
    let cases = [
        (
            "a certificate for another host",
            "proxy.nauvi.invalid",
            "127.0.0.1",
        ),
        (
            "a certificate for 127.0.0.1, reached as localhost",
            "127.0.0.1",
            "localhost",
        ),
    ];
    for (name, cert_for, host) in cases {
        let cert = proxy_cert_for(cert_for)?;
        let (port, seen, tls) = https_proxy(&cert, None).await?;
        let proxy = ClusterProxy {
            url: ProxyUrl::parse(&format!("https://me:hunter2@{host}:{port}"))
                .map_err(anyhow::Error::msg)?,
            local: true,
            ca_file: Some(write_ca(&cert.ca_pem)?),
        };
        for forwards in [false, true] {
            let build = client_through(kube::config::Kubeconfig::read()?, &proxy);
            let result = if forwards {
                nauvi::for_port_forwards(build).await
            } else {
                build.await
            };
            let err = match result {
                Ok(_) => bail!("{name}: connected through a proxy with the wrong name"),
                Err(e) => nauvi::error_text(&e),
            };
            eprintln!("{name}: {err}");
            ensure!(
                err.contains("Certificate problem with the proxy"),
                "{name}: {err}"
            );
            ensure!(!err.contains("hunter2"), "{name}: {err}");
        }
        ensure!(
            tls.failed.load(Ordering::SeqCst) > 0,
            "{name}: no handshake was tried"
        );
        ensure!(
            tls.handshakes.load(Ordering::SeqCst) == 0,
            "{name}: a handshake finished"
        );
        ensure!(seen.tunnels().is_empty(), "{name}: {:?}", seen.tunnels());
    }
    Ok(())
}
