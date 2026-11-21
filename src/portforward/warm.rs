//! One API-server connection kept ready for the next tunnel (#374).
//!
//! A tunnel is an HTTP upgrade, and hyper sends it over an idle connection
//! from the client's pool when there is one. So the TCP and TLS handshakes
//! (two round trips) only happen when the pool is empty, and the upgraded
//! connection leaves the pool for good. While a forward is in use, a cheap
//! `GET /version` after each local connection, and every [`REFRESH`], keeps
//! one connection idle in the pool. This reaches the API server only: no
//! connection to the pod is opened ahead of time (the kubelet dials the pod
//! port as soon as an upgrade completes).

use kube::Client;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::Instant;

/// How long after the last local connection the forward keeps warming.
pub(crate) const IN_USE: Duration = Duration::from_secs(300);
/// How often an idle pooled connection is used, well within the pool's
/// (hyper: 90 s) and the API server's idle timeouts.
pub(crate) const REFRESH: Duration = Duration::from_secs(30);

/// Something that puts a connection into the pool.
pub(crate) type Warm = Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

/// `GET /version` with `client`: what leaves a connection in its pool.
pub(crate) fn version_of(client: Client) -> Warm {
    Arc::new(move || {
        let client = client.clone();
        Box::pin(async move {
            if let Err(e) = client.apiserver_version().await {
                tracing::debug!("port-forward: warming a connection: {e}");
            }
        })
    })
}

/// Keeps a connection warm while the forward is in use. Dropping it stops.
pub(crate) struct Warmer {
    last_used: Arc<Mutex<Option<Instant>>>,
    wake: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl Warmer {
    pub(crate) fn new(warm: Warm) -> Self {
        let last_used = Arc::new(Mutex::new(None));
        let wake = Arc::new(Notify::new());
        let task = tokio::spawn(run(last_used.clone(), wake.clone(), warm));
        Self {
            last_used,
            wake,
            task,
        }
    }

    /// A local connection just took (or opened) a connection to the API
    /// server: put another one in the pool.
    pub(crate) fn used(&self) {
        *self.last_used.lock().unwrap() = Some(Instant::now());
        self.wake.notify_one();
    }
}

impl Drop for Warmer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn run(last_used: Arc<Mutex<Option<Instant>>>, wake: Arc<Notify>, warm: Warm) {
    loop {
        let until = last_used.lock().unwrap().map(|t| t + IN_USE);
        match until {
            Some(until) if Instant::now() < until => {
                tokio::select! {
                    // A connection was used: warm one now. Several at once
                    // wake this once; one request at a time.
                    _ = wake.notified() => warm().await,
                    _ = tokio::time::sleep(REFRESH) => warm().await,
                }
            }
            // Not in use: wait for the next connection.
            _ => wake.notified().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counting() -> (Warm, Arc<AtomicUsize>) {
        let n = Arc::new(AtomicUsize::new(0));
        let c = n.clone();
        let warm: Warm = Arc::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        });
        (warm, n)
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_unused_forward_warms_nothing() {
        let (warm, n) = counting();
        let _w = Warmer::new(warm);
        tokio::time::advance(IN_USE * 2).await;
        settle().await;
        assert_eq!(n.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn each_use_warms_and_it_refreshes_until_idle() {
        let (warm, n) = counting();
        let w = Warmer::new(warm);
        w.used();
        settle().await;
        assert_eq!(n.load(Ordering::SeqCst), 1);
        w.used();
        settle().await;
        assert_eq!(n.load(Ordering::SeqCst), 2);
        tokio::time::advance(REFRESH).await;
        settle().await;
        assert_eq!(n.load(Ordering::SeqCst), 3, "refreshed");
        // After IN_USE without a connection it stops.
        tokio::time::advance(IN_USE).await;
        settle().await;
        let stopped = n.load(Ordering::SeqCst);
        tokio::time::advance(IN_USE).await;
        settle().await;
        assert_eq!(n.load(Ordering::SeqCst), stopped);
    }
}
