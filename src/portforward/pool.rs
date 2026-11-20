//! Tunnels opened ahead of time, so a new local connection does not wait
//! for the API server (#374).
//!
//! Opening a [`Tunnel`] is a new HTTPS connection to the API server: TCP,
//! TLS and the WebSocket upgrade, several round trips. kubectl instead keeps
//! one SPDY connection per forward and opens a stream on it per local
//! connection, one round trip. The `v4.channel.k8s.io` protocol cannot do
//! that (the streams of a port are single use), so a forward keeps
//! [`WARM`] tunnels to its current backend open and ready while it is in
//! use, and a local connection takes one of those.
//!
//! The pod sees each warm tunnel as a connection that sends nothing until
//! it is used. So they only live [`MAX_AGE`] (servers time out a silent
//! connection: MySQL's handshake after 10 s), and the pool only refills
//! while the forward had a connection in the last [`IDLE`]: an unused
//! forward holds none.

use super::resolve::Backend;
use super::tunnel::Tunnel;
use futures::future::BoxFuture;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

/// Tunnels kept ready while the forward is in use.
pub(crate) const WARM: usize = 2;
/// A warm tunnel older than this is closed and replaced.
pub(crate) const MAX_AGE: Duration = Duration::from_secs(5);
/// How long after the last local connection the pool keeps refilling.
pub(crate) const IDLE: Duration = Duration::from_secs(30);
/// How long to wait before trying again when opening a tunnel failed.
const RETRY: Duration = Duration::from_secs(2);

/// Opens a tunnel to a backend.
pub(crate) type Opener =
    Arc<dyn Fn(Backend) -> BoxFuture<'static, Result<Tunnel, String>> + Send + Sync>;

struct Ready {
    tunnel: Tunnel,
    opened: Instant,
}

#[derive(Default)]
struct State {
    /// The backend the warm tunnels go to: the one used last.
    backend: Option<Backend>,
    ready: Vec<Ready>,
    last_used: Option<Instant>,
}

impl State {
    /// Drop the tunnels that are too old or closed.
    fn prune(&mut self, now: Instant) {
        self.ready
            .retain_mut(|r| now.duration_since(r.opened) < MAX_AGE && r.tunnel.is_open());
    }

    fn in_use(&self, now: Instant) -> bool {
        self.last_used.is_some_and(|t| now.duration_since(t) < IDLE)
    }
}

/// The warm tunnels of one forward. Dropping it closes them.
pub(crate) struct Pool {
    state: Arc<Mutex<State>>,
    wake: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl Pool {
    pub(crate) fn new(open: Opener) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let wake = Arc::new(Notify::new());
        let task = tokio::spawn(fill(state.clone(), wake.clone(), open));
        Self { state, wake, task }
    }

    /// Keep `tunnel` (the probe of a starting forward) for the first
    /// connection. It does not count as use, so nothing refills it.
    pub(crate) fn put(&self, backend: Backend, tunnel: Tunnel) {
        let mut s = self.state.lock().unwrap();
        if s.backend.as_ref() != Some(&backend) {
            s.backend = Some(backend);
            s.ready.clear();
        }
        s.ready.push(Ready {
            tunnel,
            opened: Instant::now(),
        });
        drop(s);
        self.wake.notify_one();
    }

    /// A warm tunnel to `backend`, if one is ready. Either way the pool now
    /// keeps tunnels to `backend` ready for the next connections.
    pub(crate) fn take(&self, backend: &Backend) -> Option<Tunnel> {
        let now = Instant::now();
        let mut s = self.state.lock().unwrap();
        s.last_used = Some(now);
        if s.backend.as_ref() != Some(backend) {
            s.backend = Some(backend.clone());
            s.ready.clear();
        }
        s.prune(now);
        // The oldest first: it expires soonest.
        let got = (!s.ready.is_empty()).then(|| s.ready.remove(0).tunnel);
        drop(s);
        self.wake.notify_one();
        got
    }

    /// Close the warm tunnels to `backend`: it just failed.
    pub(crate) fn forget(&self, backend: &Backend) {
        let mut s = self.state.lock().unwrap();
        if s.backend.as_ref() == Some(backend) {
            s.ready.clear();
        }
    }

    #[cfg(test)]
    fn ready(&self) -> usize {
        let mut s = self.state.lock().unwrap();
        s.prune(Instant::now());
        s.ready.len()
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Keep the pool topped up while the forward is in use, and drop tunnels
/// as they expire.
async fn fill(state: Arc<Mutex<State>>, wake: Arc<Notify>, open: Opener) {
    loop {
        let now = Instant::now();
        let (missing, backend, next) = {
            let mut s = state.lock().unwrap();
            s.prune(now);
            let missing = if s.in_use(now) {
                WARM.saturating_sub(s.ready.len())
            } else {
                0
            };
            // Wake up when the oldest tunnel expires or the use ends.
            let expiry = s.ready.iter().map(|r| r.opened + MAX_AGE).min();
            let idle = s.last_used.map(|t| t + IDLE).filter(|t| *t > now);
            let next = expiry.into_iter().chain(idle).min();
            (missing, s.backend.clone(), next)
        };
        if let (true, Some(backend)) = (missing > 0, backend) {
            let opened =
                futures::future::join_all((0..missing).map(|_| open(backend.clone()))).await;
            if !keep(&state, &backend, opened) {
                tokio::time::sleep(RETRY).await;
            }
            continue;
        }
        match next {
            Some(at) => {
                tokio::select! {
                    _ = wake.notified() => {}
                    _ = tokio::time::sleep_until(at) => {}
                }
            }
            None => wake.notified().await,
        }
    }
}

/// Add the tunnels just opened to `backend` to the pool; false when one
/// could not be opened.
fn keep(state: &Mutex<State>, backend: &Backend, opened: Vec<Result<Tunnel, String>>) -> bool {
    let mut ok = true;
    let now = Instant::now();
    let mut s = state.lock().unwrap();
    for t in opened {
        match t {
            // The connections may have moved to another backend meanwhile:
            // then the tunnel is dropped (closed).
            Ok(tunnel) if s.backend.as_ref() == Some(backend) => s.ready.push(Ready {
                tunnel,
                opened: now,
            }),
            Ok(_) => {}
            Err(e) => {
                tracing::debug!(
                    "port-forward: cannot pre-open a tunnel to {}: {e}",
                    backend.pod
                );
                ok = false;
            }
        }
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::DuplexStream;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::WebSocketStream;

    fn backend(pod: &str) -> Backend {
        Backend {
            pod: pod.to_string(),
            port: 80,
        }
    }

    /// An opener of in-memory tunnels that counts what it opened per pod,
    /// and keeps the server ends open (or fails for pod "gone").
    fn opener() -> (
        Opener,
        Arc<Mutex<Vec<(String, WebSocketStream<DuplexStream>)>>>,
        Arc<AtomicUsize>,
    ) {
        let servers = Arc::new(Mutex::new(Vec::new()));
        let count = Arc::new(AtomicUsize::new(0));
        let (s, c) = (servers.clone(), count.clone());
        let open: Opener = Arc::new(move |b: Backend| {
            let (s, c) = (s.clone(), c.clone());
            Box::pin(async move {
                if b.pod == "gone" {
                    return Err("pod gone not found".to_string());
                }
                c.fetch_add(1, Ordering::SeqCst);
                let (a, z) = tokio::io::duplex(64 * 1024);
                let client = WebSocketStream::from_raw_socket(a, Role::Client, None).await;
                let server = WebSocketStream::from_raw_socket(z, Role::Server, None).await;
                s.lock().unwrap().push((b.pod.clone(), server));
                Ok(Tunnel::over(client, b.port, Duration::from_secs(3600)))
            })
        });
        (open, servers, count)
    }

    /// Let the fill task run until it waits again.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_unused_pool_opens_nothing_and_the_probe_expires() {
        let (open, _servers, count) = opener();
        let pool = Pool::new(open);
        let (t, _server) = {
            let (o, s, _) = opener();
            let t = o(backend("a")).await.unwrap();
            (t, s)
        };
        pool.put(backend("a"), t);
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(pool.ready(), 1);
        tokio::time::advance(MAX_AGE).await;
        settle().await;
        assert_eq!(pool.ready(), 0);
        assert_eq!(
            count.load(Ordering::SeqCst),
            0,
            "nothing refills an unused pool"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_takes_a_warm_tunnel_and_the_pool_refills() {
        let (open, _servers, count) = opener();
        let pool = Pool::new(open);
        // The first connection finds nothing, and starts the pool.
        assert!(pool.take(&backend("a")).is_none());
        settle().await;
        assert_eq!(pool.ready(), WARM);
        let t = pool.take(&backend("a"));
        assert!(t.is_some());
        settle().await;
        assert_eq!(pool.ready(), WARM, "refilled");
        assert_eq!(count.load(Ordering::SeqCst), WARM + 1);
    }

    #[tokio::test(start_paused = true)]
    async fn tunnels_are_replaced_as_they_expire_and_stop_when_idle() {
        let (open, _servers, count) = opener();
        let pool = Pool::new(open);
        pool.take(&backend("a"));
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), WARM);
        tokio::time::advance(MAX_AGE).await;
        settle().await;
        assert_eq!(pool.ready(), WARM);
        assert_eq!(count.load(Ordering::SeqCst), 2 * WARM, "replaced");
        // Once idle, the pool lets them expire.
        tokio::time::advance(IDLE).await;
        settle().await;
        tokio::time::advance(MAX_AGE).await;
        settle().await;
        assert_eq!(pool.ready(), 0);
        let opened = count.load(Ordering::SeqCst);
        tokio::time::advance(IDLE).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), opened, "no more once idle");
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_tunnel_is_not_handed_out() {
        let (open, servers, _count) = opener();
        let pool = Pool::new(open);
        pool.take(&backend("a"));
        settle().await;
        // The API server closes both warm tunnels (the pod went away).
        for (_, mut server) in servers.lock().unwrap().drain(..) {
            tokio::spawn(async move {
                use futures::{SinkExt, StreamExt};
                let _ = server
                    .send(tokio_tungstenite::tungstenite::Message::Close(None))
                    .await;
                while server.next().await.is_some() {}
            });
        }
        settle().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        settle().await;
        // The closed ones are never handed out; the pool then refills.
        assert!(pool.take(&backend("a")).is_none());
        settle().await;
        let mut t = pool.take(&backend("a")).expect("a fresh tunnel");
        assert!(t.is_open());
    }

    #[tokio::test(start_paused = true)]
    async fn moving_to_another_backend_drops_the_old_tunnels() {
        let (open, servers, _count) = opener();
        let pool = Pool::new(open);
        pool.take(&backend("a"));
        settle().await;
        assert!(pool.take(&backend("b")).is_none());
        settle().await;
        assert_eq!(pool.ready(), WARM);
        let to_b = servers
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _)| p == "b")
            .count();
        assert!(to_b >= WARM, "{to_b}");
        assert!(pool.take(&backend("b")).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_backend_is_retried_slowly() {
        let (open, _servers, _count) = opener();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let counting: Opener = Arc::new(move |b| {
            c.fetch_add(1, Ordering::SeqCst);
            open(b)
        });
        let pool = Pool::new(counting);
        assert!(pool.take(&backend("gone")).is_none());
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), WARM);
        tokio::time::advance(RETRY / 2).await;
        settle().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            WARM,
            "waits before trying again"
        );
        tokio::time::advance(RETRY).await;
        settle().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2 * WARM);
        pool.forget(&backend("gone"));
    }
}
