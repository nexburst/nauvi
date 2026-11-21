//! How a forward reaches its pods: one SPDY session per pod with a stream
//! pair per local connection (#399), or one upgrade per connection.
//!
//! A session is opened on the first local connection to a pod (never ahead
//! of it), as kubectl does: first a WebSocket upgrade with the subprotocol
//! `SPDY/3.1+portforward.k8s.io` (the API server tunnels SPDY to the
//! kubelet, Kubernetes 1.31+), then a plain `Upgrade: SPDY/3.1`. An open
//! session with no streams does not connect to the pod: the kubelet dials
//! the port when a connection's two streams arrive.
//!
//! When no session can be opened but a `v4.channel.k8s.io` upgrade works,
//! the forward uses one upgrade per connection ([`Tunnel::open`]) from then
//! on, over the connection kept warm by [`Warmer`]. Setting
//! `NAUVI_PORT_FORWARD_MULTIPLEX=0` does that from the start (see
//! [`Multiplex`]).
//!
//! Every upgrade, a session's or a connection's, gets [`UPGRADE_TIMEOUT`]:
//! one that hangs fails that connection with a plain error and leaves no
//! session behind, so the next connection upgrades again (#422).

use super::resolve::Backend;
use super::session::Session;
use super::tunnel::{Tunnel, BUFFER, PING_EVERY};
use super::warm::{self, Warmer, IN_USE};
use futures::{SinkExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::client::Body;
use kube::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::WebSocketStream;

/// The WebSocket subprotocol of tunnelled SPDY port-forwarding.
const WS_PROTOCOL: &str = "SPDY/3.1+portforward.k8s.io";
const SPDY_PROTOCOL: &str = "portforward.k8s.io";
/// How long an upgrade may take, a session's or a connection's: the API
/// server answers one in well under a second, also through a slow kubelet.
pub(crate) const UPGRADE_TIMEOUT: Duration = Duration::from_secs(10);

/// The error of an upgrade that did not finish in time.
fn timed_out() -> String {
    format!(
        "the port-forward upgrade got no answer within {} s",
        UPGRADE_TIMEOUT.as_secs()
    )
}

/// Why no stream could be opened on a session.
enum NoStream {
    /// An upgrade hung: fail this connection, the next one tries again.
    TimedOut,
    /// Multiplexing does not work here: one upgrade per connection.
    Failed(String),
}

/// How a forward reaches its pods: an internal switch, for tests and for
/// a cluster where multiplexing misbehaves.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Multiplex {
    /// A session per pod, WebSocket-tunnelled SPDY first (the default).
    Auto,
    /// A session per pod, plain SPDY first.
    PlainSpdy,
    /// One upgrade per connection.
    Off,
}

impl Multiplex {
    /// From `NAUVI_PORT_FORWARD_MULTIPLEX`: `0`, `false` or `off` turn it
    /// off, `spdy` tries plain SPDY first, anything else is [`Auto`].
    ///
    /// [`Auto`]: Multiplex::Auto
    pub(crate) fn from_env() -> Self {
        static MODE: std::sync::OnceLock<Multiplex> = std::sync::OnceLock::new();
        *MODE.get_or_init(|| {
            let v = std::env::var("NAUVI_PORT_FORWARD_MULTIPLEX").unwrap_or_default();
            match v.trim().to_ascii_lowercase().as_str() {
                "0" | "false" | "off" => Self::Off,
                "spdy" => Self::PlainSpdy,
                _ => Self::Auto,
            }
        })
    }
}

/// Which upgrade opened a session last.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Transport {
    WebSocket = 0,
    Spdy = 1,
}

/// Opens a session to a pod with one upgrade.
type Opener = Arc<
    dyn Fn(String, Transport) -> futures::future::BoxFuture<'static, Result<Session, String>>
        + Send
        + Sync,
>;

/// One pod's session, or none yet: its own lock, so opening a session to
/// one pod never waits for another pod's upgrade.
type Slot = Arc<tokio::sync::Mutex<Option<Arc<Session>>>>;

pub(crate) struct Mux {
    client: Client,
    namespace: String,
    /// By pod name and UID: a pod recreated with the same name is another
    /// pod, and the old one's session would only answer with errors.
    sessions: std::sync::Mutex<HashMap<String, Slot>>,
    open: Opener,
    /// One upgrade per connection from now on.
    per_connection: AtomicBool,
    transport: AtomicU8,
    warmer: Warmer,
}

/// The key of a backend's session.
fn key(b: &Backend) -> String {
    format!("{}/{}", b.pod, b.uid)
}

impl Mux {
    pub(crate) fn new(client: Client, namespace: String, mode: Multiplex) -> Self {
        let (c, ns) = (client.clone(), namespace.clone());
        let open: Opener = Arc::new(move |pod, transport| {
            let (c, ns) = (c.clone(), ns.clone());
            Box::pin(async move { upgrade(&c, &ns, &pod, transport).await })
        });
        Self::with_opener(client, namespace, mode, open)
    }

    fn with_opener(client: Client, namespace: String, mode: Multiplex, open: Opener) -> Self {
        Self {
            warmer: Warmer::new(warm::version_of(client.clone())),
            client,
            namespace,
            sessions: Default::default(),
            open,
            per_connection: AtomicBool::new(mode == Multiplex::Off),
            transport: AtomicU8::new(match mode {
                Multiplex::PlainSpdy => Transport::Spdy,
                _ => Transport::WebSocket,
            } as u8),
        }
    }

    /// A forwarded connection to backend `b`.
    /// The error is plain text, for the forward's status.
    pub(crate) async fn tunnel(&self, b: &Backend) -> Result<Tunnel, String> {
        let why = if self.per_connection.load(Ordering::Relaxed) {
            None
        } else {
            match self.stream(b).await {
                Ok(t) => return Ok(t),
                Err(NoStream::TimedOut) => return Err(timed_out()),
                Err(NoStream::Failed(e)) => Some(e),
            }
        };
        let open = Tunnel::open(&self.client, &self.namespace, &b.pod, b.port);
        let tunnel = match tokio::time::timeout(UPGRADE_TIMEOUT, open).await {
            Ok(t) => t.map_err(|e| crate::actions::describe_error(&anyhow::Error::from(e))),
            Err(_) => Err(timed_out()),
        };
        // The tunnel took the pool's idle connection (or opened one).
        self.warmer.used();
        if let (Some(why), Ok(_)) = (why, &tunnel) {
            if !self.per_connection.swap(true, Ordering::Relaxed) {
                tracing::info!(
                    "port-forward: one upgrade per connection from now on: cannot multiplex: {why}"
                );
            }
        }
        tunnel
    }

    /// Forget `b`'s session: a connection through it got an error, and the
    /// next one gets a new session. Open connections keep theirs.
    pub(crate) fn forget(&self, b: &Backend) {
        self.sessions.lock().unwrap().remove(&key(b));
    }

    /// A stream pair on the pod's session, opening the session if needed;
    /// one more try on a fresh session when a reused one just failed.
    async fn stream(&self, b: &Backend) -> Result<Tunnel, NoStream> {
        for _ in 0..2 {
            let (slot, session, fresh) = self.session(b).await?;
            match session.open(b.port).await {
                Ok(t) => return Ok(t),
                Err(e) if fresh => return Err(NoStream::Failed(e)),
                Err(e) => {
                    tracing::debug!("port-forward: pod {}: {e}; opening a new session", b.pod);
                    let mut current = slot.lock().await;
                    if current.as_ref().is_some_and(|s| Arc::ptr_eq(s, &session)) {
                        *current = None;
                    }
                }
            }
        }
        Err(NoStream::Failed("cannot open a stream".into()))
    }

    /// The pod's open session, or a new one (`true`), and its slot. An
    /// upgrade that hangs leaves the slot empty and is not followed by the
    /// other transport: it would most likely hang too.
    async fn session(&self, b: &Backend) -> Result<(Slot, Arc<Session>, bool), NoStream> {
        let slot = {
            let mut sessions = self.sessions.lock().unwrap();
            // Drop the slots of closed sessions (not ones being opened).
            sessions.retain(|_, slot| {
                slot.try_lock()
                    .map_or(true, |s| s.as_ref().is_some_and(|s| !s.is_closed()))
            });
            sessions.entry(key(b)).or_default().clone()
        };
        let mut current = slot.lock().await;
        if let Some(s) = current.as_ref().filter(|s| !s.is_closed()) {
            return Ok((slot.clone(), s.clone(), false));
        }
        let first = match self.transport.load(Ordering::Relaxed) {
            1 => Transport::Spdy,
            _ => Transport::WebSocket,
        };
        let other = match first {
            Transport::WebSocket => Transport::Spdy,
            Transport::Spdy => Transport::WebSocket,
        };
        let mut errors = Vec::new();
        for transport in [first, other] {
            let upgrade = (self.open)(b.pod.clone(), transport);
            let Ok(result) = tokio::time::timeout(UPGRADE_TIMEOUT, upgrade).await else {
                tracing::debug!("port-forward: pod {}: {}", b.pod, timed_out());
                return Err(NoStream::TimedOut);
            };
            match result {
                Ok(s) => {
                    self.transport.store(transport as u8, Ordering::Relaxed);
                    let s = Arc::new(s);
                    *current = Some(s.clone());
                    drop(current);
                    return Ok((slot, s, true));
                }
                Err(e) => errors.push(e),
            }
        }
        Err(NoStream::Failed(errors.join("; ")))
    }
}

/// Open a session to `pod` with one upgrade.
async fn upgrade(
    client: &Client,
    namespace: &str,
    pod: &str,
    transport: Transport,
) -> Result<Session, String> {
    let path = format!(
        "{}/{pod}/portforward",
        <Pod as kube::Resource>::url_path(&(), Some(namespace))
    );
    let request = http::Request::builder()
        .uri(path)
        .header(http::header::CONNECTION, "Upgrade");
    let (request, what) = match transport {
        Transport::WebSocket => (
            request
                .method(http::Method::GET)
                .header(http::header::UPGRADE, "websocket")
                .header(http::header::SEC_WEBSOCKET_VERSION, "13")
                .header(
                    http::header::SEC_WEBSOCKET_KEY,
                    tungstenite::handshake::client::generate_key(),
                )
                .header(http::header::SEC_WEBSOCKET_PROTOCOL, WS_PROTOCOL),
            "WebSocket-tunnelled SPDY",
        ),
        Transport::Spdy => (
            request
                .method(http::Method::POST)
                .header(http::header::UPGRADE, "SPDY/3.1")
                .header("X-Stream-Protocol-Version", SPDY_PROTOCOL),
            "SPDY",
        ),
    };
    let request = request
        .body(Body::empty())
        .map_err(|e| format!("{what}: {e}"))?;
    let response = client
        .send(request)
        .await
        .map_err(|e| format!("{what}: {e}"))?;
    if response.status() != http::StatusCode::SWITCHING_PROTOCOLS {
        let status = response.status();
        let body = response
            .into_body()
            .collect_bytes()
            .await
            .unwrap_or_default();
        let text = String::from_utf8_lossy(&body[..body.len().min(500)]).into_owned();
        return Err(format!(
            "{what}: the API server answered {status}: {}",
            text.trim()
        ));
    }
    let (header, want) = match transport {
        Transport::WebSocket => (http::header::SEC_WEBSOCKET_PROTOCOL.as_str(), WS_PROTOCOL),
        Transport::Spdy => ("X-Stream-Protocol-Version", SPDY_PROTOCOL),
    };
    let got = response
        .headers()
        .get(header)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if got != want {
        return Err(format!("{what}: the API server chose protocol {got:?}"));
    }
    let upgraded = hyper::upgrade::on(response)
        .await
        .map_err(|e| format!("{what}: {e}"))?;
    let io = hyper_util::rt::TokioIo::new(upgraded);
    Ok(match transport {
        Transport::WebSocket => {
            let ws =
                WebSocketStream::from_raw_socket(io, tungstenite::protocol::Role::Client, None)
                    .await;
            Session::new(unwrap_websocket(ws), PING_EVERY, IN_USE)
        }
        Transport::Spdy => Session::new(io, PING_EVERY, IN_USE),
    })
}

/// The bytes inside a WebSocket's binary messages, as a stream: what the
/// API server's SPDY tunnel carries. Ends when either side ends.
fn unwrap_websocket<S>(ws: WebSocketStream<S>) -> tokio::io::DuplexStream
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (ours, theirs) = tokio::io::duplex(BUFFER);
    tokio::spawn(async move {
        let (mut sink, mut source) = ws.split();
        let (mut from_session, mut to_session) = tokio::io::split(theirs);
        let down = async {
            while let Some(Ok(msg)) = source.next().await {
                match msg {
                    Message::Binary(b) => {
                        if to_session.write_all(&b).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    // Pings (tungstenite queues the pong) and pongs.
                    _ => {}
                }
            }
            let _ = to_session.shutdown().await;
        };
        let up = async {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match from_session.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if sink.send(Message::binary(buf[..n].to_vec())).await.is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = sink.send(Message::Close(None)).await;
        };
        tokio::select! {
            _ = down => {}
            _ = up => {}
        }
    });
    ours
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tungstenite::protocol::Role;

    /// A client that never reaches a server: the sessions come from the
    /// test's opener.
    fn offline_client() -> Client {
        let svc = tower::service_fn(|_req: http::Request<Body>| async {
            Err::<http::Response<Body>, tower::BoxError>("offline".into())
        });
        Client::new(svc, "default")
    }

    fn backend(pod: &str, uid: &str) -> Backend {
        Backend {
            pod: pod.into(),
            port: 80,
            uid: uid.into(),
        }
    }

    /// Sessions over in-memory connections; the pod "slow" never answers
    /// its upgrade. Counts the upgrades.
    fn mux() -> (Mux, Arc<std::sync::atomic::AtomicUsize>) {
        let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = n.clone();
        let open: Opener = Arc::new(move |pod, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if pod == "slow" {
                    std::future::pending::<()>().await;
                }
                let (a, b) = tokio::io::duplex(1024);
                // Keep the server end open.
                std::mem::forget(b);
                Ok(Session::new(a, PING_EVERY, IN_USE))
            })
        });
        let m = Mux::with_opener(offline_client(), "ns".into(), Multiplex::Auto, open);
        (m, n)
    }

    #[tokio::test]
    async fn a_pod_whose_upgrade_hangs_does_not_hold_up_the_others() {
        let (m, _) = mux();
        let m = Arc::new(m);
        let slow = {
            let m = m.clone();
            tokio::spawn(async move { m.session(&backend("slow", "1")).await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        let fast = tokio::time::timeout(Duration::from_secs(5), m.session(&backend("fast", "2")))
            .await
            .expect("the other pod's session opens while one upgrade hangs");
        assert!(fast.is_ok());
        assert!(!slow.is_finished());
        slow.abort();
    }

    #[tokio::test]
    async fn sessions_are_per_pod_uid_and_forgotten_on_request() {
        let (m, n) = mux();
        let (_, a, fresh) = m.session(&backend("web-0", "1")).await.unwrap();
        assert!(fresh);
        let (_, again, fresh) = m.session(&backend("web-0", "1")).await.unwrap();
        assert!(!fresh && Arc::ptr_eq(&a, &again));
        // The same name with a new UID: a recreated pod, a new session.
        let (_, b, fresh) = m.session(&backend("web-0", "2")).await.unwrap();
        assert!(fresh && !Arc::ptr_eq(&a, &b));
        // After an error the next connection gets a new session.
        m.forget(&backend("web-0", "2"));
        let (_, c, fresh) = m.session(&backend("web-0", "2")).await.unwrap();
        assert!(fresh && !Arc::ptr_eq(&b, &c));
        assert_eq!(n.load(Ordering::SeqCst), 3);
    }

    /// A client whose requests never get an answer: a hung upgrade.
    fn hanging_client() -> Client {
        let svc = tower::service_fn(|_req: http::Request<Body>| async {
            std::future::pending::<Result<http::Response<Body>, tower::BoxError>>().await
        });
        Client::new(svc, "default")
    }

    #[tokio::test(start_paused = true)]
    async fn a_hung_session_upgrade_times_out_and_the_next_connection_tries_again() {
        let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = n.clone();
        // The first upgrade hangs, the next ones work.
        let open: Opener = Arc::new(move |_, _| {
            let first = count.fetch_add(1, Ordering::SeqCst) == 0;
            Box::pin(async move {
                if first {
                    std::future::pending::<()>().await;
                }
                let (a, b) = tokio::io::duplex(1024);
                std::mem::forget(b);
                Ok(Session::new(a, PING_EVERY, IN_USE))
            })
        });
        let m = Mux::with_opener(hanging_client(), "ns".into(), Multiplex::Auto, open);
        let b = backend("web-0", "1");
        let started = tokio::time::Instant::now();
        let err = m.tunnel(&b).await.err().expect("the hung upgrade fails");
        assert_eq!(err, "the port-forward upgrade got no answer within 10 s");
        assert_eq!(started.elapsed(), UPGRADE_TIMEOUT);
        // Neither the other transport nor one upgrade per connection was
        // tried, and multiplexing stays on.
        assert_eq!(n.load(Ordering::SeqCst), 1);
        assert!(!m.per_connection.load(Ordering::Relaxed));
        // No session was kept: the next connection upgrades again.
        let (_, _, fresh) = m.session(&b).await.ok().unwrap();
        assert!(fresh);
        assert_eq!(n.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_hung_per_connection_upgrade_times_out() {
        let open: Opener = Arc::new(|_, _| Box::pin(async { Err("unused".to_string()) }));
        let m = Mux::with_opener(hanging_client(), "ns".into(), Multiplex::Off, open);
        let started = tokio::time::Instant::now();
        let err = m.tunnel(&backend("web-0", "1")).await.err().unwrap();
        assert_eq!(err, "the port-forward upgrade got no answer within 10 s");
        assert_eq!(started.elapsed(), UPGRADE_TIMEOUT);
    }

    #[tokio::test]
    async fn the_websocket_carries_bytes_both_ways() {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let client = WebSocketStream::from_raw_socket(a, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(b, Role::Server, None).await;
        let mut io = unwrap_websocket(client);
        io.write_all(b"spdy bytes").await.unwrap();
        match server.next().await.unwrap().unwrap() {
            Message::Binary(b) => assert_eq!(&b[..], b"spdy bytes"),
            m => panic!("{m:?}"),
        }
        server
            .send(Message::binary(b"back".to_vec()))
            .await
            .unwrap();
        server
            .send(Message::binary(b" again".to_vec()))
            .await
            .unwrap();
        let mut got = [0u8; 10];
        io.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"back again");
        server.send(Message::Close(None)).await.unwrap();
        let mut rest = Vec::new();
        io.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    }
}
