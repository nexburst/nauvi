//! Noticing an API server that stopped answering (#90).
//!
//! A watch only fails when its connection does. An API server that is
//! paused, overloaded or behind a VPN that dropped often leaves the TCP
//! connection open and just sends nothing, so kube's watcher waits for its
//! read timeout (about 5 minutes) while the table still says Live. Watch
//! bookmarks don't help: kube consumes them, and the server sends them only
//! about once a minute.
//!
//! [`guard`] wraps a stream that talks to the API server (a watcher, or the
//! lists of [`crate::poll`]). Whenever that stream has been quiet for
//! [`Liveness::quiet`], it asks the server something cheap ([`probe`]:
//! `GET /readyz` with a short timeout). Any HTTP answer counts, even an
//! error status: the question is whether the server answers, not whether it
//! is ready or lets us read it. So a quiet but healthy cluster never looks
//! disconnected. After [`Liveness::failures`] unanswered probes in a row,
//! the guard yields [`Guarded::Lost`] and drops the stream, whose connection
//! may never recover; it probes again every [`Liveness::retry`] and, once the
//! server answers, starts a new stream (a new watcher lists everything
//! again).

use futures::stream::{self, BoxStream};
use futures::{Stream, StreamExt};
use kube::Client;
use std::future::Future;
use std::time::Duration;

/// When and how a [`guard`] probes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Liveness {
    /// Probe after this long without an item from the stream.
    pub quiet: Duration,
    /// A probe without an answer within this time failed.
    pub timeout: Duration,
    /// Failed probes in a row before the connection counts as lost.
    pub failures: u32,
    /// Time between probes after a failed one, and while lost.
    pub retry: Duration,
}

/// The default: a dead connection is noticed within about
/// `quiet + timeout + retry + timeout` = 23 s.
pub const LIVENESS: Liveness = Liveness {
    quiet: Duration::from_secs(10),
    timeout: Duration::from_secs(5),
    failures: 2,
    retry: Duration::from_secs(3),
};

/// An item of the guarded stream, or the news that the server stopped
/// answering (the text says so, for the status line).
#[derive(Debug, Clone, PartialEq)]
pub enum Guarded<I> {
    Item(I),
    Lost(String),
}

/// Whether the API server behind `client` answers within `timeout`.
pub async fn probe(client: &Client, timeout: Duration) -> Result<(), String> {
    let request = http::Request::get("/readyz")
        .body(Vec::new())
        .expect("a GET without a body is a valid request");
    match tokio::time::timeout(timeout, client.request_text(request)).await {
        Err(_) => Err(format!(
            "The API server is not answering (no reply within {} s)",
            timeout.as_secs()
        )),
        // An error status is still an answer; a failed credential refresh
        // is not a connection problem, and the watches report it themselves.
        Ok(Ok(_)) | Ok(Err(kube::Error::Api(_))) | Ok(Err(kube::Error::Auth(_))) => Ok(()),
        Ok(Err(e)) => Err(format!(
            "The API server cannot be reached: {}",
            crate::errors::chain_text(&e)
        )),
    }
}

/// [`guard`] with [`LIVENESS`] and [`probe`] against `client`.
pub fn guard_client<S, I, M>(client: Client, make: M) -> BoxStream<'static, Guarded<I>>
where
    M: FnMut() -> S + Send + 'static,
    S: Stream<Item = I> + Send + Unpin + 'static,
    I: Send + 'static,
{
    let cfg = LIVENESS;
    guard(
        make,
        move || {
            let client = client.clone();
            async move { probe(&client, cfg.timeout).await }
        },
        cfg,
    )
}

/// The stream `make` builds, watched over: see the module docs. `probe`
/// must time out by itself (after [`Liveness::timeout`]). The guarded
/// stream ends when the inner one does.
pub fn guard<S, I, M, P, F>(make: M, probe: P, cfg: Liveness) -> BoxStream<'static, Guarded<I>>
where
    M: FnMut() -> S + Send + 'static,
    S: Stream<Item = I> + Send + Unpin + 'static,
    P: Fn() -> F + Send + Sync + 'static,
    F: Future<Output = Result<(), String>> + Send,
    I: Send + 'static,
{
    let state = Guard {
        inner: None,
        make,
        probe,
        cfg,
        misses: 0,
    };
    stream::unfold(state, |mut g| async move {
        let item = g.next().await?;
        Some((item, g))
    })
    .boxed()
}

struct Guard<S, M, P> {
    /// `None` while lost (and before the first item is asked for).
    inner: Option<S>,
    make: M,
    probe: P,
    cfg: Liveness,
    /// Failed probes in a row.
    misses: u32,
}

enum Step<I> {
    Item(Option<I>),
    Probed(Result<(), String>),
}

impl<S, I, M, P, F> Guard<S, M, P>
where
    M: FnMut() -> S,
    S: Stream<Item = I> + Unpin,
    P: Fn() -> F,
    F: Future<Output = Result<(), String>>,
{
    fn start(&mut self) {
        if self.inner.is_none() {
            self.inner = Some((self.make)());
        }
    }

    async fn next(&mut self) -> Option<Guarded<I>> {
        if self.misses < self.cfg.failures {
            self.start();
        }
        loop {
            let Some(inner) = self.inner.as_mut() else {
                // Lost: wait for the server to answer, then start over.
                tokio::time::sleep(self.cfg.retry).await;
                if (self.probe)().await.is_ok() {
                    self.misses = 0;
                    self.start();
                }
                continue;
            };
            let wait = if self.misses == 0 {
                self.cfg.quiet
            } else {
                self.cfg.retry
            };
            let probe = &self.probe;
            let step = tokio::select! {
                item = inner.next() => Step::Item(item),
                probed = async { tokio::time::sleep(wait).await; probe().await } => Step::Probed(probed),
            };
            match step {
                Step::Item(item) => {
                    self.misses = 0;
                    return item.map(Guarded::Item);
                }
                Step::Probed(Ok(())) => self.misses = 0,
                Step::Probed(Err(e)) => {
                    self.misses += 1;
                    if self.misses >= self.cfg.failures {
                        self.inner = None;
                        return Some(Guarded::Lost(e));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::time::Instant;

    /// A fake server: `up` says whether probes are answered; it counts
    /// probes and streams made.
    #[derive(Clone, Default)]
    struct Server {
        up: Arc<AtomicBool>,
        probes: Arc<AtomicUsize>,
        made: Arc<AtomicUsize>,
    }

    impl Server {
        fn up() -> Self {
            let s = Self::default();
            s.up.store(true, Ordering::SeqCst);
            s
        }

        /// Guard streams from `make`, probing this server.
        fn guard(
            &self,
            make: impl Fn(usize) -> BoxStream<'static, u32> + Send + 'static,
        ) -> BoxStream<'static, Guarded<u32>> {
            let made = self.made.clone();
            let (up, probes) = (self.up.clone(), self.probes.clone());
            guard(
                move || make(made.fetch_add(1, Ordering::SeqCst)),
                move || {
                    let (up, probes) = (up.clone(), probes.clone());
                    async move {
                        probes.fetch_add(1, Ordering::SeqCst);
                        if up.load(Ordering::SeqCst) {
                            Ok(())
                        } else {
                            // Like a paused server: no answer until the timeout.
                            tokio::time::sleep(LIVENESS.timeout).await;
                            Err("no reply".to_string())
                        }
                    }
                },
                LIVENESS,
            )
        }
    }

    fn silent(_: usize) -> BoxStream<'static, u32> {
        stream::pending().boxed()
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_healthy_server_is_never_lost() {
        let server = Server::up();
        let mut s = server.guard(silent);
        let r = tokio::time::timeout(Duration::from_secs(600), s.next()).await;
        assert!(r.is_err(), "nothing should come out: {r:?}");
        let probes = server.probes.load(Ordering::SeqCst);
        assert!((55..=60).contains(&probes), "one probe per 10 s: {probes}");
        assert_eq!(server.made.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_stream_needs_no_probes() {
        let server = Server::up();
        let mut s = server.guard(|_| {
            stream::unfold(0, |n| async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Some((n, n + 1))
            })
            .boxed()
        });
        for n in 0..20 {
            assert_eq!(s.next().await, Some(Guarded::Item(n)));
        }
        assert_eq!(server.probes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_dead_server_is_lost_within_25_s_then_restarted() {
        let server = Server::default();
        let mut s = server.guard(|n| {
            // The first stream hangs; the next one says hello right away.
            if n == 0 {
                silent(n)
            } else {
                stream::iter([7]).chain(stream::pending()).boxed()
            }
        });
        let start = Instant::now();
        assert_eq!(s.next().await, Some(Guarded::Lost("no reply".into())));
        let took = start.elapsed();
        assert!(took <= Duration::from_secs(25), "{took:?}");
        assert_eq!(took, Duration::from_secs(23));

        // Still down: nothing, and no new stream.
        assert!(tokio::time::timeout(Duration::from_secs(60), s.next())
            .await
            .is_err());
        assert_eq!(server.made.load(Ordering::SeqCst), 1);

        server.up.store(true, Ordering::SeqCst);
        let back = Instant::now();
        assert_eq!(s.next().await, Some(Guarded::Item(7)));
        assert!(back.elapsed() <= LIVENESS.retry + LIVENESS.timeout);
        assert_eq!(server.made.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn one_missed_probe_is_not_lost() {
        let server = Server::default();
        let mut s = server.guard(|_| {
            // An item 20 s in: after the first missed probe (10 s + 5 s),
            // before the second one would fail (+ 3 s + 5 s).
            stream::once(async {
                tokio::time::sleep(Duration::from_secs(20)).await;
                1
            })
            .chain(stream::pending())
            .boxed()
        });
        assert_eq!(s.next().await, Some(Guarded::Item(1)));
        server.up.store(true, Ordering::SeqCst);
        assert!(tokio::time::timeout(Duration::from_secs(120), s.next())
            .await
            .is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn the_guarded_stream_ends_with_the_inner_one() {
        let server = Server::up();
        let mut s = server.guard(|_| stream::iter([1, 2]).boxed());
        assert_eq!(s.next().await, Some(Guarded::Item(1)));
        assert_eq!(s.next().await, Some(Guarded::Item(2)));
        assert_eq!(s.next().await, None);
    }
}
