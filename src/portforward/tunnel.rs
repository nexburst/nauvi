//! One forwarded connection to one pod port, kept alive with pings (#304).
//!
//! kube-rs's `Portforwarder` sends no WebSocket pings, so a connection that
//! carries no data for [`crate::client::READ_TIMEOUT`] (a database client
//! between queries, an idle keep-alive) is cut by the client's read timeout.
//! This is the same `v4.channel.k8s.io` protocol for a single port, plus a
//! ping every [`PING_EVERY`]: the API server's pong is a read, so the
//! timeout only fires when the server really stopped answering.
//!
//! The frames: every binary message starts with its channel, 0 for the
//! port's data and 1 for its error text. The first message on each channel
//! is the port number (2 bytes, little endian).

use futures::{SinkExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::Client;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::WebSocketStream;

/// How often an open connection pings the API server: well within the read
/// timeout, as kube-rs does for exec and attach.
pub const PING_EVERY: Duration = Duration::from_secs(60);

const DATA: u8 = 0;
const ERROR: u8 = 1;
/// The local side's buffer, as kube-rs uses.
const BUFFER: usize = 1024 * 1024;

/// A forwarded connection: `stream` reads and writes the pod's port, `error`
/// resolves with the pod's error text (or fails when the connection ends
/// without one). The connection stays open until the tunnel (or the
/// [`Closer`] from [`Tunnel::into_parts`]) is dropped, or a side closes it.
pub struct Tunnel {
    pub stream: DuplexStream,
    pub error: oneshot::Receiver<String>,
    task: Closer,
}

impl Tunnel {
    /// Open a port-forward to `port` of pod `namespace/pod`.
    pub async fn open(
        client: &Client,
        namespace: &str,
        pod: &str,
        port: u16,
    ) -> kube::Result<Self> {
        let path = <Pod as kube::Resource>::url_path(&(), Some(namespace));
        let request = kube::core::Request::new(path)
            .portforward(pod, &[port])
            .map_err(kube::Error::BuildRequest)?;
        let connection = client.connect(request).await?;
        Ok(Self::over(connection.into_stream(), port, PING_EVERY))
    }

    /// Run the protocol over an open WebSocket.
    fn over<S>(ws: WebSocketStream<S>, port: u16, ping_every: Duration) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (stream, local) = tokio::io::duplex(BUFFER);
        let (error_tx, error) = oneshot::channel();
        let task = tokio::spawn(async move {
            if let Err(e) = relay(ws, port, local, error_tx, ping_every).await {
                tracing::debug!("port-forward: port {port}: {e}");
            }
        });
        Self {
            stream,
            error,
            task: Closer(task),
        }
    }

    /// The stream, the error and a guard that closes the connection when
    /// dropped, to drop the stream first and still wait for the error.
    pub fn into_parts(self) -> (DuplexStream, oneshot::Receiver<String>, Closer) {
        (self.stream, self.error, self.task)
    }
}

/// Closes a [`Tunnel`]'s connection when dropped.
pub struct Closer(tokio::task::JoinHandle<()>);

impl Drop for Closer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Move bytes between the WebSocket and `local` until either side closes.
async fn relay<S>(
    ws: WebSocketStream<S>,
    port: u16,
    local: DuplexStream,
    error_tx: oneshot::Sender<String>,
    ping_every: Duration,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut source) = ws.split();
    let (mut from_local, mut to_local) = tokio::io::split(local);
    let mut error_tx = Some(error_tx);
    // Whether each channel sent its port number yet.
    let mut started = [false; 2];
    // The local side closed: we sent Close and wait for the server's.
    let mut closing = false;
    let mut buf = vec![0u8; 32 * 1024];
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            msg = source.next() => {
                let msg = match msg {
                    None => break,
                    Some(Ok(msg)) => msg,
                    Some(Err(e)) => return Err(format!("cannot read from the API server: {e}")),
                };
                let mut data = match msg {
                    Message::Binary(data) if !data.is_empty() => data,
                    Message::Close(_) => break,
                    // Pongs (and the pings tungstenite answers itself).
                    _ => continue,
                };
                let channel = data[0];
                let body = data.split_off(1);
                match channel {
                    DATA | ERROR if !started[channel as usize] => {
                        if body.len() != 2 || u16::from_le_bytes([body[0], body[1]]) != port {
                            return Err(format!("unexpected first frame on channel {channel}"));
                        }
                        started[channel as usize] = true;
                    }
                    DATA => to_local
                        .write_all(&body)
                        .await
                        .map_err(|e| format!("cannot pass data on: {e}"))?,
                    ERROR => {
                        if let Some(tx) = error_tx.take() {
                            let _ = tx.send(String::from_utf8_lossy(&body).into_owned());
                        }
                    }
                    other => return Err(format!("unexpected channel {other}")),
                }
            }
            read = from_local.read(&mut buf), if !closing => {
                let n = read.map_err(|e| format!("cannot read the local side: {e}"))?;
                if n == 0 {
                    // One port per connection: its end is the socket's end.
                    sink.send(Message::Close(None))
                        .await
                        .map_err(|e| format!("cannot close: {e}"))?;
                    closing = true;
                    continue;
                }
                let mut frame = Vec::with_capacity(n + 1);
                frame.push(DATA);
                frame.extend_from_slice(&buf[..n]);
                sink.send(Message::binary(frame))
                    .await
                    .map_err(|e| format!("cannot send to the API server: {e}"))?;
            }
            _ = ping.tick(), if !closing => {
                sink.send(Message::Ping(Bytes::new()))
                    .await
                    .map_err(|e| format!("cannot ping the API server: {e}"))?;
            }
        }
    }
    let _ = to_local.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::protocol::Role;

    /// A tunnel over an in-memory WebSocket, and the server's end of it.
    async fn pair(ping_every: Duration) -> (Tunnel, WebSocketStream<DuplexStream>) {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let client = WebSocketStream::from_raw_socket(a, Role::Client, None).await;
        let server = WebSocketStream::from_raw_socket(b, Role::Server, None).await;
        (Tunnel::over(client, 8080, ping_every), server)
    }

    fn frame(channel: u8, body: &[u8]) -> Message {
        let mut v = vec![channel];
        v.extend_from_slice(body);
        Message::binary(v)
    }

    #[tokio::test]
    async fn data_goes_both_ways_and_the_error_comes_through() {
        let (mut t, mut server) = pair(Duration::from_secs(3600)).await;
        let port = 8080u16.to_le_bytes();
        server.send(frame(DATA, &port)).await.unwrap();
        server.send(frame(ERROR, &port)).await.unwrap();
        server.send(frame(DATA, b"hello")).await.unwrap();
        let mut got = [0u8; 5];
        t.stream.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello");

        t.stream.write_all(b"ping?").await.unwrap();
        match server.next().await.unwrap().unwrap() {
            Message::Binary(b) => assert_eq!(&b[..], b"\0ping?"),
            m => panic!("{m:?}"),
        }

        server
            .send(frame(ERROR, b"connection refused"))
            .await
            .unwrap();
        assert_eq!((&mut t.error).await.unwrap(), "connection refused");
    }

    #[tokio::test]
    async fn an_idle_connection_pings() {
        let (t, mut server) = pair(Duration::from_millis(50)).await;
        for _ in 0..2 {
            let msg = tokio::time::timeout(Duration::from_secs(5), server.next())
                .await
                .expect("a ping within 5 s")
                .unwrap()
                .unwrap();
            assert!(matches!(msg, Message::Ping(_)), "{msg:?}");
        }
        drop(t);
    }

    #[tokio::test]
    async fn closing_the_local_side_closes_the_websocket() {
        let (mut t, mut server) = pair(Duration::from_secs(3600)).await;
        t.stream.shutdown().await.unwrap();
        let msg = server.next().await.unwrap().unwrap();
        assert!(msg.is_close(), "{msg:?}");
        // The server's close ends the tunnel: the local side reads EOF and
        // no error text came.
        // Reading on sends the server's queued reply to the close.
        let drain = tokio::spawn(async move { while server.next().await.is_some() {} });
        let mut rest = Vec::new();
        t.stream.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        assert!((&mut t.error).await.is_err());
        drain.abort();
    }

    #[tokio::test]
    async fn a_wrong_first_frame_ends_the_tunnel() {
        let (mut t, mut server) = pair(Duration::from_secs(3600)).await;
        server.send(frame(DATA, &9u16.to_le_bytes())).await.unwrap();
        let mut rest = Vec::new();
        t.stream.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    }
}
