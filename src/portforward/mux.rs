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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::WebSocketStream;

/// The WebSocket subprotocol of tunnelled SPDY port-forwarding.
const WS_PROTOCOL: &str = "SPDY/3.1+portforward.k8s.io";
const SPDY_PROTOCOL: &str = "portforward.k8s.io";

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

pub(crate) struct Mux {
    client: Client,
    namespace: String,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Session>>>,
    /// One upgrade per connection from now on.
    per_connection: AtomicBool,
    transport: AtomicU8,
    warmer: Warmer,
}

impl Mux {
    pub(crate) fn new(client: Client, namespace: String, mode: Multiplex) -> Self {
        Self {
            warmer: Warmer::new(warm::version_of(client.clone())),
            client,
            namespace,
            sessions: Default::default(),
            per_connection: AtomicBool::new(mode == Multiplex::Off),
            transport: AtomicU8::new(match mode {
                Multiplex::PlainSpdy => Transport::Spdy,
                _ => Transport::WebSocket,
            } as u8),
        }
    }

    /// A forwarded connection to `port` of `pod`.
    pub(crate) async fn tunnel(&self, pod: &str, port: u16) -> kube::Result<Tunnel> {
        let why = if self.per_connection.load(Ordering::Relaxed) {
            None
        } else {
            match self.stream(pod, port).await {
                Ok(t) => return Ok(t),
                Err(e) => Some(e),
            }
        };
        let tunnel = Tunnel::open(&self.client, &self.namespace, pod, port).await;
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

    /// A stream pair on the pod's session, opening the session if needed;
    /// one more try on a fresh session when a reused one just failed.
    async fn stream(&self, pod: &str, port: u16) -> Result<Tunnel, String> {
        for _ in 0..2 {
            let (session, fresh) = self.session(pod).await?;
            match session.open(port).await {
                Ok(t) => return Ok(t),
                Err(e) if fresh => return Err(e),
                Err(e) => {
                    tracing::debug!("port-forward: pod {pod}: {e}; opening a new session");
                    let mut sessions = self.sessions.lock().await;
                    if sessions.get(pod).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                        sessions.remove(pod);
                    }
                }
            }
        }
        Err("cannot open a stream".into())
    }

    /// The pod's open session, or a new one (`true`).
    async fn session(&self, pod: &str) -> Result<(Arc<Session>, bool), String> {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, s| !s.is_closed());
        if let Some(s) = sessions.get(pod) {
            return Ok((s.clone(), false));
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
            match upgrade(&self.client, &self.namespace, pod, transport).await {
                Ok(s) => {
                    self.transport.store(transport as u8, Ordering::Relaxed);
                    let s = Arc::new(s);
                    sessions.insert(pod.to_string(), s.clone());
                    return Ok((s, true));
                }
                Err(e) => errors.push(e),
            }
        }
        Err(errors.join("; "))
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
    use tungstenite::protocol::Role;

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
