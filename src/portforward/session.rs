//! One SPDY session to a pod, with a pair of streams per local connection
//! (#399), as kubectl does.
//!
//! Three tasks run a session: the reader hands each frame to its stream,
//! the writer sends the frames everything else queues, and the keeper pings
//! every [`PING_EVERY`](super::tunnel::PING_EVERY) (the answer is a read, so
//! the client's read timeout only fires when the server stopped answering,
//! #304) and closes the session once it had no streams for a while.
//!
//! There is no flow control (see [`super::spdy`]): when a local client
//! reads slower than its pod sends, its stream's buffer fills and the
//! reader waits, which holds up the session's other streams too. kubectl
//! (spdystream) behaves the same.

use super::spdy::{self, Frame, Headers};
use super::tunnel::{Tunnel, BUFFER};
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

/// How long a new stream waits for the kubelet's SYN_REPLY.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// Frames queued for the writer.
const OUT_QUEUE: usize = 64;
/// Messages buffered per stream before the reader waits (each up to the
/// kubelet's 32 KiB writes): about [`BUFFER`] per stream.
const IN_QUEUE: usize = 32;
/// Stream ids are 31 bits: a session that used them up takes no new ones.
const LAST_STREAM_ID: u32 = 0x7fff_0000;

/// What the reader hands a stream.
#[derive(Debug)]
enum Inbound {
    Reply,
    Data(Bytes),
    /// The server closed its side (FIN).
    Fin,
    /// The server reset the stream.
    Reset,
}

struct Ids {
    next_stream: u32,
    next_request: u64,
    headers: Headers,
}

struct Inner {
    out: mpsc::Sender<Vec<u8>>,
    streams: Mutex<HashMap<u32, mpsc::Sender<Inbound>>>,
    ids: tokio::sync::Mutex<Ids>,
    /// No new streams: the connection ended, or the server said GOAWAY.
    closed: AtomicBool,
    /// Since when the session has no streams, `None` while it has some.
    idle_since: Mutex<Option<Instant>>,
    shutdown: watch::Sender<bool>,
}

impl Inner {
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Dropping the senders ends every stream.
        self.streams.lock().unwrap().clear();
        let _ = self.shutdown.send(true);
    }

    fn remove(&self, ids: &[u32]) {
        let mut streams = self.streams.lock().unwrap();
        for id in ids {
            streams.remove(id);
        }
        if streams.is_empty() {
            *self.idle_since.lock().unwrap() = Some(Instant::now());
        }
    }

    /// Queue a frame from a destructor: without waiting.
    fn send_later(&self, frame: Vec<u8>) {
        if let Err(mpsc::error::TrySendError::Full(frame)) = self.out.try_send(frame) {
            let out = self.out.clone();
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move { out.send(frame).await });
            }
        }
    }
}

/// A SPDY session. Dropping it stops its tasks and closes the connection;
/// open streams end.
pub(crate) struct Session {
    inner: Arc<Inner>,
    tasks: [tokio::task::JoinHandle<()>; 3],
}

impl Drop for Session {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Session {
    /// Run a session over `io`, an upgraded connection that speaks SPDY.
    pub(crate) fn new<S>(io: S, ping_every: Duration, idle_after: Duration) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (read, write) = tokio::io::split(io);
        let (out, out_rx) = mpsc::channel(OUT_QUEUE);
        let (shutdown, _) = watch::channel(false);
        let inner = Arc::new(Inner {
            out,
            streams: Mutex::new(HashMap::new()),
            ids: tokio::sync::Mutex::new(Ids {
                next_stream: 1,
                next_request: 0,
                headers: Headers::default(),
            }),
            closed: AtomicBool::new(false),
            idle_since: Mutex::new(Some(Instant::now())),
            shutdown,
        });
        let tasks = [
            tokio::spawn(read_frames(inner.clone(), read)),
            tokio::spawn(write_frames(inner.clone(), write, out_rx)),
            tokio::spawn(keep(inner.clone(), ping_every, idle_after)),
        ];
        Self { inner, tasks }
    }

    /// Whether the session takes no new streams.
    pub(crate) fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Open a forwarded connection to `port`: an error and a data stream.
    /// Returns once the kubelet accepted the data stream; that is when it
    /// dials the pod's port. The connection keeps the session alive, also
    /// once the pool has forgotten it (after a GOAWAY).
    pub(crate) async fn open(self: &Arc<Self>, port: u16) -> Result<Tunnel, String> {
        let inner = &self.inner;
        let (data_tx, data_rx) = mpsc::channel(IN_QUEUE);
        let (err_tx, err_rx) = mpsc::channel(IN_QUEUE);
        let (err_id, data_id) = {
            let mut ids = inner.ids.lock().await;
            if inner.closed.load(Ordering::SeqCst) || ids.next_stream > LAST_STREAM_ID {
                inner.closed.store(true, Ordering::SeqCst);
                return Err("the port-forward session is closed".into());
            }
            let err_id = ids.next_stream;
            let data_id = err_id + 2;
            ids.next_stream += 4;
            let request = ids.next_request.to_string();
            ids.next_request += 1;
            {
                let mut streams = inner.streams.lock().unwrap();
                streams.insert(err_id, err_tx);
                streams.insert(data_id, data_tx);
                *inner.idle_since.lock().unwrap() = None;
            }
            let port = port.to_string();
            let headers = |kind| {
                [
                    ("streamtype", kind),
                    ("port", port.as_str()),
                    ("requestid", request.as_str()),
                ]
            };
            // As client-go: the error stream first, closed for writing at
            // once, then the data stream. Queued in id order, as SPDY needs.
            let frames = [
                ids.headers.syn_stream(err_id, &headers("error")),
                spdy::data(err_id, &[], true),
                ids.headers.syn_stream(data_id, &headers("data")),
            ];
            for f in frames {
                if inner.out.send(f).await.is_err() {
                    inner.remove(&[err_id, data_id]);
                    return Err("the port-forward session is closed".into());
                }
            }
            (err_id, data_id)
        };
        let (stream, local) = tokio::io::duplex(BUFFER);
        let (error_tx, error) = oneshot::channel();
        let (ready_tx, ready) = oneshot::channel();
        let guard = Guard {
            inner: inner.clone(),
            _session: self.clone(),
            err_id,
            data_id,
            sent_fin: AtomicBool::new(false),
            remote_done: AtomicBool::new(false),
            err_done: AtomicBool::new(false),
        };
        let task = tokio::spawn(relay(
            guard, local, data_rx, err_rx, ready_tx, error_tx, port,
        ));
        let tunnel = Tunnel::from_parts(stream, error, task);
        match tokio::time::timeout(REPLY_TIMEOUT, ready).await {
            Ok(Ok(())) => Ok(tunnel),
            Ok(Err(_)) => Err("the kubelet did not accept the stream".into()),
            Err(_) => Err(format!(
                "the kubelet did not answer a new stream within {} s",
                REPLY_TIMEOUT.as_secs()
            )),
        }
    }
}

/// Ends a forwarded connection's streams when its relay ends or is
/// aborted: resets what is still open, forgets both streams.
struct Guard {
    inner: Arc<Inner>,
    _session: Arc<Session>,
    err_id: u32,
    data_id: u32,
    sent_fin: AtomicBool,
    remote_done: AtomicBool,
    err_done: AtomicBool,
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.inner.remove(&[self.err_id, self.data_id]);
        if !self.inner.closed.load(Ordering::SeqCst) {
            let data_open =
                !(self.sent_fin.load(Ordering::SeqCst) && self.remote_done.load(Ordering::SeqCst));
            if data_open {
                self.inner
                    .send_later(spdy::rst_stream(self.data_id, spdy::CANCEL));
            }
            if !self.err_done.load(Ordering::SeqCst) {
                self.inner
                    .send_later(spdy::rst_stream(self.err_id, spdy::CANCEL));
            }
        }
    }
}

/// Move one connection's bytes: local to the data stream, the data stream
/// to local (both at once, so neither direction waits for the other), and
/// collect the error stream's text.
async fn relay(
    guard: Guard,
    local: tokio::io::DuplexStream,
    mut data_rx: mpsc::Receiver<Inbound>,
    mut err_rx: mpsc::Receiver<Inbound>,
    ready_tx: oneshot::Sender<()>,
    error_tx: oneshot::Sender<String>,
    port: u16,
) {
    let g = &guard;
    let connection = async move {
        let (mut from_local, mut to_local) = tokio::io::split(local);
        let mut ready_tx = Some(ready_tx);
        let down = async {
            while let Some(m) = data_rx.recv().await {
                match m {
                    Inbound::Reply => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(());
                        }
                    }
                    Inbound::Data(b) => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(());
                        }
                        if to_local.write_all(&b).await.is_err() {
                            break;
                        }
                    }
                    Inbound::Fin | Inbound::Reset => break,
                }
            }
            g.remote_done.store(true, Ordering::SeqCst);
            let _ = to_local.shutdown().await;
        };
        let up = async {
            let mut buf = vec![0u8; 32 * 1024];
            loop {
                let n = match from_local.read(&mut buf).await {
                    Ok(n) => n,
                    Err(e) => {
                        tracing::debug!("port-forward: port {port}: local side: {e}");
                        return;
                    }
                };
                let fin = n == 0;
                if g.inner
                    .out
                    .send(spdy::data(g.data_id, &buf[..n], fin))
                    .await
                    .is_err()
                {
                    return;
                }
                if fin {
                    g.sent_fin.store(true, Ordering::SeqCst);
                    // Wait for the server's end, as client-go does.
                    std::future::pending::<()>().await;
                }
            }
        };
        // The server's end of the data stream ends the connection: the
        // local side is dropped, as with one upgrade per connection.
        tokio::select! {
            _ = down => {}
            _ = up => {}
        }
    };
    let errors = async move {
        let mut text = Vec::new();
        while let Some(m) = err_rx.recv().await {
            match m {
                Inbound::Reply => {}
                Inbound::Data(b) => text.extend_from_slice(&b),
                Inbound::Fin | Inbound::Reset => break,
            }
        }
        g.err_done.store(true, Ordering::SeqCst);
        if !text.is_empty() {
            let _ = error_tx.send(String::from_utf8_lossy(&text).into_owned());
        }
    };
    tokio::join!(connection, errors);
    drop(guard);
}

async fn read_frames<R: AsyncRead + Unpin>(inner: Arc<Inner>, read: R) {
    let mut read = tokio::io::BufReader::with_capacity(64 * 1024, read);
    loop {
        let frame = match spdy::read_frame(&mut read).await {
            Ok(f) => f,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    tracing::debug!("port-forward session: {e}");
                }
                break;
            }
        };
        let stream_of = |id: u32| inner.streams.lock().unwrap().get(&id).cloned();
        match frame {
            Frame::Data { stream, fin, data } => {
                let Some(tx) = stream_of(stream) else {
                    continue;
                };
                if !data.is_empty() {
                    let _ = tx.send(Inbound::Data(data)).await;
                }
                if fin {
                    let _ = tx.send(Inbound::Fin).await;
                }
            }
            Frame::Reply { stream, fin } => {
                let Some(tx) = stream_of(stream) else {
                    continue;
                };
                let _ = tx.send(Inbound::Reply).await;
                if fin {
                    let _ = tx.send(Inbound::Fin).await;
                }
            }
            Frame::Reset { stream, status } => {
                tracing::debug!("port-forward session: stream {stream} reset ({status})");
                if let Some(tx) = stream_of(stream) {
                    let _ = tx.send(Inbound::Reset).await;
                }
            }
            // The server's pings have even ids: echo them. Ours (odd) are
            // answered: that read was the point.
            Frame::Ping { id } if id % 2 == 0 => {
                let _ = inner.out.send(spdy::ping(id)).await;
            }
            Frame::Ping { .. } | Frame::Other => {}
            Frame::GoAway => inner.closed.store(true, Ordering::SeqCst),
        }
    }
    inner.close();
}

async fn write_frames<W: AsyncWrite + Unpin>(
    inner: Arc<Inner>,
    write: W,
    mut out: mpsc::Receiver<Vec<u8>>,
) {
    let mut write = tokio::io::BufWriter::with_capacity(64 * 1024, write);
    let mut shutdown = inner.shutdown.subscribe();
    let result: std::io::Result<()> = async {
        loop {
            let frame = tokio::select! {
                f = out.recv() => f,
                _ = stopped(&mut shutdown) => None,
            };
            let Some(frame) = frame else { return Ok(()) };
            write.write_all(&frame).await?;
            // Everything queued meanwhile goes in the same flush.
            while let Ok(frame) = out.try_recv() {
                write.write_all(&frame).await?;
            }
            write.flush().await?;
        }
    }
    .await;
    if let Err(e) = result {
        tracing::debug!("port-forward session: cannot write: {e}");
    }
    let _ = write.shutdown().await;
    inner.close();
}

/// Resolves once the session is shut down.
async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|s| *s).await;
}

async fn keep(inner: Arc<Inner>, ping_every: Duration, idle_after: Duration) {
    let mut shutdown = inner.shutdown.subscribe();
    let mut ping = tokio::time::interval_at(Instant::now() + ping_every, ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut check = tokio::time::interval(idle_after / 4);
    let mut next_ping = 1u32;
    loop {
        tokio::select! {
            _ = stopped(&mut shutdown) => return,
            _ = ping.tick() => {
                let _ = inner.out.send(spdy::ping(next_ping)).await;
                next_ping = next_ping.wrapping_add(2);
            }
            _ = check.tick() => {
                let idle = inner.idle_since.lock().unwrap().is_some_and(|t| t.elapsed() >= idle_after);
                if idle {
                    tracing::debug!("port-forward session: idle, closing");
                    inner.close();
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::DuplexStream;

    /// A session over an in-memory connection, and the "kubelet" end.
    fn pair(ping_every: Duration, idle_after: Duration) -> (Arc<Session>, DuplexStream) {
        let (a, b) = tokio::io::duplex(1024 * 1024);
        (Arc::new(Session::new(a, ping_every, idle_after)), b)
    }

    const HOUR: Duration = Duration::from_secs(3600);

    fn control(kind: u16, flags: u8, body: &[u8]) -> Vec<u8> {
        let mut f = vec![0x80, 3];
        f.extend_from_slice(&kind.to_be_bytes());
        f.push(flags);
        f.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
        f.extend_from_slice(body);
        f
    }

    fn reply(stream: u32) -> Vec<u8> {
        control(spdy::SYN_REPLY, 0, &stream.to_be_bytes())
    }

    /// Read frames until a SYN_STREAM, returning its stream id.
    async fn next_frame(k: &mut DuplexStream) -> (bool, u16, u32, Vec<u8>) {
        let mut head = [0u8; 8];
        k.read_exact(&mut head).await.unwrap();
        let len = u32::from_be_bytes([0, head[5], head[6], head[7]]) as usize;
        let mut body = vec![0u8; len];
        k.read_exact(&mut body).await.unwrap();
        let control = head[0] & 0x80 != 0;
        let kind = u16::from_be_bytes([head[2], head[3]]);
        let id = if control {
            u32::from_be_bytes([body[0], body[1], body[2], body[3]])
        } else {
            u32::from_be_bytes(head[..4].try_into().unwrap())
        };
        (control, kind, id, body)
    }

    /// The kubelet's side of opening a connection: SYN_STREAM error, FIN on
    /// it, SYN_STREAM data, then a reply to the data stream.
    async fn accept(k: &mut DuplexStream) -> (u32, u32) {
        let (c, kind, err_id, _) = next_frame(k).await;
        assert!(c && kind == spdy::SYN_STREAM);
        let (c, _, id, body) = next_frame(k).await;
        assert!(!c && id == err_id && body.is_empty());
        let (c, kind, data_id, _) = next_frame(k).await;
        assert!(c && kind == spdy::SYN_STREAM);
        k.write_all(&reply(err_id)).await.unwrap();
        k.write_all(&reply(data_id)).await.unwrap();
        (err_id, data_id)
    }

    #[tokio::test]
    async fn streams_carry_data_both_ways_and_the_error() {
        let (s, mut k) = pair(HOUR, HOUR);
        let open = tokio::spawn(async move {
            let t = s.open(8080).await;
            (s, t)
        });
        let (err_id, data_id) = accept(&mut k).await;
        assert_eq!((err_id, data_id), (1, 3));
        let (s, t) = open.await.unwrap();
        let mut t = t.unwrap();

        k.write_all(&spdy::data(data_id, b"hello", false))
            .await
            .unwrap();
        let mut got = [0u8; 5];
        t.stream.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello");

        t.stream.write_all(b"ping?").await.unwrap();
        let (c, _, id, body) = next_frame(&mut k).await;
        assert!(!c && id == data_id && body == b"ping?");

        k.write_all(&spdy::data(err_id, b"connection refused", true))
            .await
            .unwrap();
        assert_eq!((&mut t.error).await.unwrap(), "connection refused");

        // The local side's end is a FIN on the data stream.
        t.stream.shutdown().await.unwrap();
        let (c, _, id, body) = next_frame(&mut k).await;
        assert!(!c && id == data_id && body.is_empty());
        // The server's FIN ends the local side.
        k.write_all(&spdy::data(data_id, &[], true)).await.unwrap();
        let mut rest = Vec::new();
        t.stream.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        drop(s);
    }

    #[tokio::test]
    async fn connections_get_their_own_streams_and_request_ids() {
        let (s, mut k) = pair(HOUR, HOUR);
        let s2 = s.clone();
        let opens = tokio::spawn(async move {
            let a = s2.open(80).await.unwrap();
            let b = s2.open(80).await.unwrap();
            (a, b)
        });
        assert_eq!(accept(&mut k).await, (1, 3));
        assert_eq!(accept(&mut k).await, (5, 7));
        let (mut a, mut b) = opens.await.unwrap();
        k.write_all(&spdy::data(7, b"to b", false)).await.unwrap();
        k.write_all(&spdy::data(3, b"to a", false)).await.unwrap();
        let mut got = [0u8; 4];
        b.stream.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"to b");
        a.stream.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"to a");
    }

    #[tokio::test]
    async fn dropping_a_connection_resets_its_open_streams() {
        let (s, mut k) = pair(HOUR, HOUR);
        let open = tokio::spawn(async move {
            let t = s.open(80).await;
            (s, t)
        });
        let (err_id, data_id) = accept(&mut k).await;
        let (_s, t) = open.await.unwrap();
        drop(t.unwrap());
        let mut reset = Vec::new();
        for _ in 0..2 {
            let (c, kind, id, body) = next_frame(&mut k).await;
            assert!(c && kind == spdy::RST_STREAM, "{kind}");
            assert_eq!(&body[4..], &spdy::CANCEL.to_be_bytes());
            reset.push(id);
        }
        reset.sort();
        assert_eq!(reset, vec![err_id, data_id]);
    }

    #[tokio::test]
    async fn a_reset_before_the_reply_fails_the_open() {
        let (s, mut k) = pair(HOUR, HOUR);
        let open = tokio::spawn(async move { s.open(80).await.err() });
        let (_, _, _, _) = next_frame(&mut k).await;
        let (_, _, _, _) = next_frame(&mut k).await;
        let (_, _, data_id, _) = next_frame(&mut k).await;
        k.write_all(&spdy::rst_stream(data_id, 3)).await.unwrap();
        assert!(open.await.unwrap().is_some());
    }

    #[tokio::test]
    async fn after_goaway_open_connections_go_on_and_no_new_ones_open() {
        let (s, mut k) = pair(HOUR, HOUR);
        let s2 = s.clone();
        let open = tokio::spawn(async move { s2.open(80).await });
        let (_, data_id) = accept(&mut k).await;
        let mut t = open.await.unwrap().unwrap();
        k.write_all(&control(spdy::GOAWAY, 0, &[0; 8]))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !s.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The pool forgets a closed session; its connection keeps it.
        drop(s);
        k.write_all(&spdy::data(data_id, b"still", false))
            .await
            .unwrap();
        let mut got = [0u8; 5];
        t.stream.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"still");
    }

    #[tokio::test]
    async fn the_server_ending_the_connection_closes_the_session() {
        let (s, k) = pair(HOUR, HOUR);
        drop(k);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !s.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(s.open(80).await.is_err());
    }

    #[tokio::test]
    async fn it_pings_and_echoes_the_servers_pings() {
        let (_s, mut k) = pair(Duration::from_millis(50), HOUR);
        let (c, kind, id, _) = next_frame(&mut k).await;
        assert!(c && kind == spdy::PING && id == 1);
        k.write_all(&spdy::ping(2)).await.unwrap();
        loop {
            let (_, kind, id, _) = next_frame(&mut k).await;
            assert_eq!(kind, spdy::PING);
            if id == 2 {
                break;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_without_streams_closes_after_a_while() {
        let (s, _k) = pair(HOUR, Duration::from_secs(300));
        tokio::time::sleep(Duration::from_secs(200)).await;
        assert!(!s.is_closed());
        tokio::time::sleep(Duration::from_secs(200)).await;
        assert!(s.is_closed());
    }
}
