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
//!
//! The probes go through a [`Prober`], shared by every guard of one cluster
//! connection (a window, the CLI, an overview): guards that go quiet
//! together (an idle cluster) wait for one probe instead of sending one each,
//! so an idle cluster sees about one probe per 10 s, however many watches
//! are open.

use futures::future::{BoxFuture, FutureExt, Shared};
use futures::stream::{self, BoxStream};
use futures::{Stream, StreamExt};
use kube::Client;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

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
/// `quiet + timeout + retry + timeout` = 23 s, plus up to [`REUSE`] when
/// a guard reused another one's recent answer.
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

/// A probe asked for within this time of the start of another one gets that
/// one's answer (or waits for it) instead of sending its own.
pub const REUSE: Duration = Duration::from_secs(3);

/// How long a probe request may run on after its caller stopped waiting
/// (after [`Liveness::timeout`]). It is not cancelled at the timeout, so a
/// slow credential refresh (an exec plugin) can finish and the next probe
/// finds the token cached instead of timing out again.
const PROBE_MAX: Duration = Duration::from_secs(30);

type ProbeFuture = Shared<BoxFuture<'static, Result<(), String>>>;
type ProbeFn = dyn Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync;

/// Asks whether the API server answers, for every [`guard`] of one cluster
/// connection. Cheap to clone; clones share the probe in flight and its
/// answer for [`REUSE`].
#[derive(Clone)]
pub struct Prober {
    send: Arc<ProbeFn>,
    timeout: Duration,
    last: Arc<Mutex<Option<(Instant, ProbeFuture)>>>,
}

impl Prober {
    /// Probes `client`'s API server with `GET /readyz`.
    pub fn new(client: Client) -> Self {
        Self::with(LIVENESS.timeout, move || {
            let client = client.clone();
            async move { answers(&client).await }.boxed()
        })
    }

    /// A prober whose requests are `send` (they need not time out by
    /// themselves): for tests.
    pub fn with(
        timeout: Duration,
        send: impl Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync + 'static,
    ) -> Self {
        Self {
            send: Arc::new(send),
            timeout,
            last: Arc::new(Mutex::new(None)),
        }
    }

    /// Whether the API server answers within the timeout: the answer of a
    /// probe started less than [`REUSE`] ago, or of one still in flight and
    /// started less than the timeout ago, or a new probe.
    ///
    /// A probe nobody waits for any more (every waiter got an item first) is
    /// not polled, so it may still look in flight long after its request got
    /// an answer: past the timeout that answer is too old to reuse (#151).
    pub async fn probe(&self) -> Result<(), String> {
        let probe = {
            let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            match &*last {
                Some((started, probe)) if self.reusable(*started, probe) => probe.clone(),
                _ => {
                    let probe = self.start();
                    *last = Some((Instant::now(), probe.clone()));
                    probe
                }
            }
        };
        probe.await
    }

    fn reusable(&self, started: Instant, probe: &ProbeFuture) -> bool {
        let age = started.elapsed();
        if probe.peek().is_some() {
            age < REUSE
        } else {
            age < self.timeout
        }
    }

    fn start(&self) -> ProbeFuture {
        // A task of its own, so the request outlives the wait (see PROBE_MAX).
        let request = tokio::spawn(tokio::time::timeout(PROBE_MAX, (self.send)()));
        let timeout = self.timeout;
        async move {
            match tokio::time::timeout(timeout, request).await {
                Ok(Ok(Ok(answer))) => answer,
                Ok(Ok(Err(_))) | Err(_) => Err(format!(
                    "The API server is not answering (no reply within {} s)",
                    timeout.as_secs()
                )),
                Ok(Err(e)) => Err(format!("The probe of the API server failed: {e}")),
            }
        }
        .boxed()
        .shared()
    }
}

/// Whether the API server behind `client` answers `GET /readyz` at all.
async fn answers(client: &Client) -> Result<(), String> {
    let request = http::Request::get("/readyz")
        .body(Vec::new())
        .expect("a GET without a body is a valid request");
    match client.request_text(request).await {
        // An error status is still an answer; a failed credential refresh
        // is not a connection problem, and the watches report it themselves.
        Ok(_) | Err(kube::Error::Api(_)) | Err(kube::Error::Auth(_)) => Ok(()),
        Err(e) => Err(format!(
            "The API server cannot be reached: {}",
            crate::errors::chain_text(&e)
        )),
    }
}

/// [`guard`] with [`LIVENESS`].
pub fn guard_client<S, I, M>(prober: &Prober, make: M) -> BoxStream<'static, Guarded<I>>
where
    M: FnMut() -> S + Send + 'static,
    S: Stream<Item = I> + Send + Unpin + 'static,
    I: Send + 'static,
{
    guard(make, prober.clone(), LIVENESS)
}

/// The stream `make` builds, watched over: see the module docs. The
/// guarded stream ends when the inner one does.
pub fn guard<S, I, M>(make: M, prober: Prober, cfg: Liveness) -> BoxStream<'static, Guarded<I>>
where
    M: FnMut() -> S + Send + 'static,
    S: Stream<Item = I> + Send + Unpin + 'static,
    I: Send + 'static,
{
    let state = Guard {
        inner: None,
        make,
        prober,
        cfg,
        misses: 0,
    };
    stream::unfold(state, |mut g| async move {
        let item = g.next().await?;
        Some((item, g))
    })
    .boxed()
}

struct Guard<S, M> {
    /// `None` while lost (and before the first item is asked for).
    inner: Option<S>,
    make: M,
    prober: Prober,
    cfg: Liveness,
    /// Failed probes in a row.
    misses: u32,
}

enum Step<I> {
    Item(Option<I>),
    Probed(Result<(), String>),
}

impl<S, I, M> Guard<S, M>
where
    M: FnMut() -> S,
    S: Stream<Item = I> + Unpin,
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
                if self.prober.probe().await.is_ok() {
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
            let prober = &self.prober;
            let step = tokio::select! {
                item = inner.next() => Step::Item(item),
                probed = async { tokio::time::sleep(wait).await; prober.probe().await } => Step::Probed(probed),
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

    /// A fake server: `up` says whether probes are answered (a request sent
    /// while it is down waits until it is up again, like a paused one); it
    /// counts probes and streams made.
    #[derive(Clone)]
    struct Server {
        up: Arc<AtomicBool>,
        probes: Arc<AtomicUsize>,
        made: Arc<AtomicUsize>,
        prober: Prober,
    }

    impl Server {
        fn new(up: bool) -> Self {
            let up = Arc::new(AtomicBool::new(up));
            let probes = Arc::new(AtomicUsize::new(0));
            let (u, p) = (up.clone(), probes.clone());
            let prober = Prober::with(LIVENESS.timeout, move || {
                let (up, probes) = (u.clone(), p.clone());
                async move {
                    probes.fetch_add(1, Ordering::SeqCst);
                    while !up.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    Ok(())
                }
                .boxed()
            });
            Self {
                up,
                probes,
                made: Arc::new(AtomicUsize::new(0)),
                prober,
            }
        }

        fn probes(&self) -> usize {
            self.probes.load(Ordering::SeqCst)
        }

        /// Guard streams from `make`, probing this server.
        fn guard(
            &self,
            make: impl Fn(usize) -> BoxStream<'static, u32> + Send + 'static,
        ) -> BoxStream<'static, Guarded<u32>> {
            let made = self.made.clone();
            guard(
                move || make(made.fetch_add(1, Ordering::SeqCst)),
                self.prober.clone(),
                LIVENESS,
            )
        }
    }

    fn silent(_: usize) -> BoxStream<'static, u32> {
        stream::pending().boxed()
    }

    fn not_answering() -> Guarded<u32> {
        Guarded::Lost("The API server is not answering (no reply within 5 s)".into())
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_healthy_server_is_never_lost() {
        let server = Server::new(true);
        let mut s = server.guard(silent);
        let r = tokio::time::timeout(Duration::from_secs(600), s.next()).await;
        assert!(r.is_err(), "nothing should come out: {r:?}");
        assert!((55..=60).contains(&server.probes()), "one probe per 10 s");
        assert_eq!(server.made.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn many_quiet_streams_share_one_probe() {
        let server = Server::new(true);
        // 80 watches (a workloads overview of 10 namespaces), going quiet
        // within 2 s of each other.
        let streams = (0..80u64).map(|i| {
            server.guard(move |_| {
                stream::once(async move {
                    tokio::time::sleep(Duration::from_millis(25 * i)).await;
                    1
                })
                .chain(stream::pending())
                .boxed()
            })
        });
        let mut all = stream::select_all(streams);
        for _ in 0..80 {
            assert_eq!(all.next().await, Some(Guarded::Item(1)));
        }
        let r = tokio::time::timeout(Duration::from_secs(600), all.next()).await;
        assert!(r.is_err(), "nothing should come out: {r:?}");
        let probes = server.probes();
        assert!((55..=61).contains(&probes), "one probe per 10 s: {probes}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_stream_needs_no_probes() {
        let server = Server::new(true);
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
        assert_eq!(server.probes(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_dead_server_is_lost_within_25_s_then_restarted() {
        let server = Server::new(false);
        let mut s = server.guard(|n| {
            // The first stream hangs; the next one says hello right away.
            if n == 0 {
                silent(n)
            } else {
                stream::iter([7]).chain(stream::pending()).boxed()
            }
        });
        let start = Instant::now();
        assert_eq!(s.next().await, Some(not_answering()));
        assert_eq!(start.elapsed(), Duration::from_secs(23));

        // Still down: nothing, and no new stream.
        assert!(tokio::time::timeout(Duration::from_secs(60), s.next())
            .await
            .is_err());
        assert_eq!(server.made.load(Ordering::SeqCst), 1);

        server.up.store(true, Ordering::SeqCst);
        let back = Instant::now();
        assert_eq!(s.next().await, Some(Guarded::Item(7)));
        assert!(back.elapsed() <= LIVENESS.retry + Duration::from_secs(1));
        assert_eq!(server.made.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn many_streams_on_a_dead_server_are_lost_together() {
        let server = Server::new(false);
        let mut all = stream::select_all((0..20).map(|_| server.guard(silent)));
        let start = Instant::now();
        for _ in 0..20 {
            assert_eq!(all.next().await, Some(not_answering()));
        }
        assert_eq!(start.elapsed(), Duration::from_secs(23));
        assert_eq!(server.probes(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn one_missed_probe_is_not_lost() {
        let server = Server::new(false);
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
    async fn a_slow_credential_refresh_is_not_lost() {
        // The first request runs an exec plugin for 7 s, past the timeout;
        // it finishes anyway, so the next probe finds the token cached.
        let cached = Arc::new(AtomicBool::new(false));
        let c = cached.clone();
        let prober = Prober::with(LIVENESS.timeout, move || {
            let cached = c.clone();
            async move {
                if !cached.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_secs(7)).await;
                    cached.store(true, Ordering::SeqCst);
                }
                Ok(())
            }
            .boxed()
        });
        let mut s = guard(|| silent(0), prober, LIVENESS);
        assert!(tokio::time::timeout(Duration::from_secs(120), s.next())
            .await
            .is_err());
        assert!(cached.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn an_abandoned_probe_is_not_reused_past_the_timeout() {
        // Answers after 1 s while up; never while down.
        let up = Arc::new(AtomicBool::new(true));
        let u = up.clone();
        let prober = Prober::with(LIVENESS.timeout, move || {
            let up = u.clone();
            async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                while !up.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Ok(())
            }
            .boxed()
        });

        // A probe whose only waiter stops waiting (an item won the select):
        // its request still gets an answer, but nobody polls the probe again.
        let mut abandoned = Box::pin(prober.probe());
        assert!(futures::poll!(&mut abandoned).is_pending());
        drop(abandoned);
        tokio::time::sleep(LIVENESS.timeout + Duration::from_secs(1)).await;

        // Then the server dies: the old answer must not count.
        up.store(false, Ordering::SeqCst);
        let mut s = guard(|| silent(0), prober, LIVENESS);
        let start = Instant::now();
        assert_eq!(s.next().await, Some(not_answering()));
        assert_eq!(start.elapsed(), Duration::from_secs(23));
    }

    #[tokio::test(start_paused = true)]
    async fn the_guarded_stream_ends_with_the_inner_one() {
        let server = Server::new(true);
        let mut s = server.guard(|_| stream::iter([1, 2]).boxed());
        assert_eq!(s.next().await, Some(Guarded::Item(1)));
        assert_eq!(s.next().await, Some(Guarded::Item(2)));
        assert_eq!(s.next().await, None);
    }
}
