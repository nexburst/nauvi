//! Getting a watch going again after it failed (#180), and what to tell
//! people meanwhile.
//!
//! kube's watcher, after a failed watch, starts a new one from the last
//! resourceVersion and sends no event when that works: if nothing changes
//! in the cluster, its consumer never hears that the watch is back, and a
//! table stays on Reconnecting… with stale data until something changes.
//! That is what a dropped connection looks like (a VPN or SSH tunnel that
//! closed, a restarted API server): the watch fails at once, the retries
//! are refused, and the one that works is silent.
//!
//! [`restart_on_error`] drops the watcher after every error and, after a
//! backoff ([`RetryBackoff`]: about 1 s, doubling up to 10 s), starts a new
//! one, which lists everything again. The backoff starts over only when a
//! watcher had worked for [`STABLE`]: a list that works followed by a
//! watch that fails at once (a 429 or 500 on the watch, a proxy that cuts
//! streams) keeps backing off instead of listing again every second. The list ends with `InitDone`, which
//! the trackers turn into a snapshot and Live. A list after a failure costs
//! one request per watch, which is what a re-list after a 410 Gone (kube's
//! own recovery) or after a lost connection ([`crate::liveness`]) cost too.
//!
//! [`failure_text`] says what failed in one plain line for the status
//! banner; the full error chain goes to the log.

use futures::stream::{self, Stream, StreamExt};
use kube::runtime::utils::Backoff;
use std::collections::hash_map::RandomState;
use std::error::Error as StdError;
use std::hash::{BuildHasher, Hasher};
use std::time::Duration;
use tokio::time::Instant;

/// The first wait after an error.
pub const RETRY_MIN: Duration = Duration::from_millis(800);
/// The longest wait between two attempts: once the API server answers
/// again, a watch is back within about this long.
pub const RETRY_MAX: Duration = Duration::from_secs(10);

/// A stream that ran this long before it failed counts as having worked:
/// the next wait is [`RETRY_MIN`] again.
pub const STABLE: Duration = Duration::from_secs(30);

/// Exponential backoff from [`RETRY_MIN`] to [`RETRY_MAX`], each wait
/// shortened by up to a fifth at random so that the watches of a window,
/// which fail together, don't all list again in the same instant.
#[derive(Debug, Clone)]
pub struct RetryBackoff {
    next: Duration,
    seed: u64,
}

impl Default for RetryBackoff {
    fn default() -> Self {
        Self {
            next: RETRY_MIN,
            seed: RandomState::new().build_hasher().finish() | 1,
        }
    }
}

impl Iterator for RetryBackoff {
    type Item = Duration;

    fn next(&mut self) -> Option<Duration> {
        let wait = self.next;
        self.next = (self.next * 2).min(RETRY_MAX);
        // xorshift64
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        let cut = wait.mul_f64((self.seed % 1000) as f64 / 5000.0);
        Some(wait - cut)
    }
}

impl Backoff for RetryBackoff {
    fn reset(&mut self) {
        self.next = RETRY_MIN;
    }
}

/// The items of the stream `make` builds; after an error, that stream is
/// dropped and, after the next wait of `backoff`, a new one is made. The
/// backoff is reset when the failed stream had run for [`STABLE`] (not by
/// its items: a new watcher's first item is always a successful `Init`).
/// Ends when a stream ends by itself.
pub fn restart_on_error<S, T, E, M, B>(make: M, backoff: B) -> impl Stream<Item = Result<T, E>>
where
    M: FnMut() -> S,
    S: Stream<Item = Result<T, E>> + Unpin,
    B: Backoff,
{
    let state = Restart {
        make,
        backoff,
        current: None,
        wait: None,
    };
    stream::unfold(state, |mut r| async move {
        let (s, started) = match r.current.as_mut() {
            Some(c) => c,
            None => {
                if let Some(wait) = r.wait.take() {
                    tokio::time::sleep(wait).await;
                }
                r.current.insert(((r.make)(), Instant::now()))
            }
        };
        let item = s.next().await?;
        if item.is_err() {
            if started.elapsed() >= STABLE {
                r.backoff.reset();
            }
            r.wait = r.backoff.next();
            r.current = None;
        }
        Some((item, r))
    })
}

struct Restart<M, S, B> {
    make: M,
    backoff: B,
    /// The stream and when it was made; `None` after an error.
    current: Option<(S, Instant)>,
    /// How long to wait before making the next one.
    wait: Option<Duration>,
}

/// "Lost the connection to the cluster (`server`)", or without the
/// parentheses when the server is not known.
pub fn lost_connection(server: &str) -> String {
    let server = display_server(server);
    if server.is_empty() {
        "Lost the connection to the cluster".to_string()
    } else {
        format!("Lost the connection to the cluster ({server})")
    }
}

/// `url` without a trailing slash and without the user and password a
/// kubeconfig may put in it (`https://user:pass@host`), for messages and logs.
pub fn display_server(url: &str) -> String {
    let url = url.trim_end_matches('/');
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (format!("{scheme}://"), rest),
        None => (String::new(), url),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let rest = match rest[..authority_end].rfind('@') {
        Some(at) => &rest[at + 1..],
        None => rest,
    };
    format!("{scheme}{rest}")
}

/// What a watch or list that failed says while it retries, for the status
/// banner: `server` is the cluster's URL (`""`: unknown).
///
/// - the connection failed (refused, closed, reset, a TLS or HTTP error):
///   [`lost_connection`];
/// - the API server answered with an error: its message;
/// - the credential plugin exited with an error: its exit code and stderr,
///   never its environment or stdout;
/// - anything else (credentials that could not be refreshed, a response
///   that could not be read): the error chain, which then is the message.
///
/// Every text ends with "; retrying." The full chain is logged.
pub fn failure_text(err: &(dyn StdError + 'static), server: &str) -> String {
    let chain = crate::errors::chain_text(err);
    tracing::warn!(server, error = %chain, "watch failed, retrying");
    let text = if let Some(r) = crate::errors::api_response(err) {
        format!(
            "The API server answered with an error: {}",
            crate::errors::response_text(r)
        )
    } else if let Some(t) = exec_run_text(err) {
        format!("Could not refresh the login: {t}")
    } else if is_connection_error(err) {
        lost_connection(server)
    } else {
        chain
    };
    retrying(&text)
}

/// The text of a credential plugin that exited with an error, if that is
/// what `err` is (see [`crate::auth::exec_run_text`]).
fn exec_run_text(err: &(dyn StdError + 'static)) -> Option<String> {
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(t) = e
            .downcast_ref::<kube::client::AuthError>()
            .and_then(crate::auth::exec_run_text)
        {
            return Some(t);
        }
        cur = e.source();
    }
    None
}

/// `text` followed by "; retrying.".
pub fn retrying(text: &str) -> String {
    format!("{}; retrying.", text.trim_end_matches('.'))
}

/// Whether `err` is the connection to the API server failing, as opposed to
/// an answer from it or a credential problem.
fn is_connection_error(err: &(dyn StdError + 'static)) -> bool {
    let mut connection = false;
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = cur {
        match e.downcast_ref::<kube::Error>() {
            Some(kube::Error::Auth(_)) => return false,
            Some(
                kube::Error::HyperError(_) | kube::Error::Service(_) | kube::Error::ReadEvents(_),
            ) => connection = true,
            _ => {}
        }
        if e.downcast_ref::<kube::client::AuthError>().is_some() {
            return false;
        }
        if e.downcast_ref::<std::io::Error>().is_some() {
            connection = true;
        }
        cur = e.source();
    }
    connection
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream::BoxStream;
    use kube::runtime::watcher;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[test]
    fn the_backoff_doubles_up_to_ten_seconds_and_resets() {
        let mut b = RetryBackoff::default();
        let waits: Vec<Duration> = (&mut b).take(8).collect();
        let full = [0.8, 1.6, 3.2, 6.4, 10.0, 10.0, 10.0, 10.0];
        for (wait, full) in waits.iter().zip(full) {
            let full = Duration::from_secs_f64(full);
            assert!(*wait <= full && *wait >= full.mul_f64(0.8), "{waits:?}");
        }
        b.reset();
        assert!(b.next().unwrap() <= RETRY_MIN);
    }

    /// The first stream yields 1, fails, and would go on with 2 (a watcher
    /// resuming from its resourceVersion); later ones yield 10 + their
    /// number and then nothing.
    #[tokio::test(start_paused = true)]
    async fn an_error_drops_the_stream_and_a_new_one_starts_after_the_backoff() {
        let made = Arc::new(AtomicUsize::new(0));
        let m = made.clone();
        let s = restart_on_error(
            move || -> BoxStream<'static, Result<usize, &'static str>> {
                let n = m.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    stream::iter([Ok(1), Err("gone"), Ok(2)]).boxed()
                } else {
                    stream::iter([Ok(10 + n)]).chain(stream::pending()).boxed()
                }
            },
            RetryBackoff::default(),
        );
        let mut s = Box::pin(s);
        assert_eq!(s.next().await, Some(Ok(1)));
        assert_eq!(s.next().await, Some(Err("gone")));
        let start = Instant::now();
        assert_eq!(s.next().await, Some(Ok(11)));
        assert!(start.elapsed() <= RETRY_MIN, "{:?}", start.elapsed());
        assert_eq!(made.load(Ordering::SeqCst), 2);
    }

    /// While the server stays down every new stream fails at once; when it
    /// is back, the next one gets through within RETRY_MAX.
    #[tokio::test(start_paused = true)]
    async fn after_a_long_outage_the_stream_is_back_within_the_longest_wait() {
        let start = Instant::now();
        let s = restart_on_error(
            move || -> BoxStream<'static, Result<u32, &'static str>> {
                if start.elapsed() < Duration::from_secs(60) {
                    stream::iter([Err("refused")]).boxed()
                } else {
                    stream::iter([Ok(1)]).chain(stream::pending()).boxed()
                }
            },
            RetryBackoff::default(),
        );
        let mut s = Box::pin(s);
        let mut errors = 0;
        while s.next().await == Some(Err("refused")) {
            errors += 1;
        }
        let back = start.elapsed();
        assert!(back <= Duration::from_secs(60) + RETRY_MAX, "{back:?}");
        assert!((6..=15).contains(&errors), "{errors} attempts in 60 s");
    }

    /// A list that works and a watch that fails at once, again and again
    /// (a 429 on the watch): the waits between new streams grow to the
    /// longest one instead of starting over with every successful list.
    #[tokio::test(start_paused = true)]
    async fn a_stream_that_fails_right_after_its_first_item_keeps_backing_off() {
        let made = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let m = made.clone();
        let s = restart_on_error(
            move || -> BoxStream<'static, Result<&'static str, &'static str>> {
                m.lock().unwrap().push(Instant::now());
                stream::iter([Ok("init"), Err("429")]).boxed()
            },
            RetryBackoff::default(),
        );
        let mut s = Box::pin(s.take(20));
        while s.next().await.is_some() {}
        let made = made.lock().unwrap();
        let waits: Vec<Duration> = made.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(waits.len(), 9, "{waits:?}");
        let full = [0.8, 1.6, 3.2, 6.4, 10.0, 10.0, 10.0, 10.0, 10.0];
        for (wait, full) in waits.iter().zip(full) {
            let full = Duration::from_secs_f64(full);
            assert!(*wait <= full && *wait >= full.mul_f64(0.8), "{waits:?}");
        }
    }

    /// A stream that worked for a while before it failed starts the waits
    /// over: the next one is short.
    #[tokio::test(start_paused = true)]
    async fn a_stream_that_worked_for_a_while_starts_the_waits_over() {
        let made = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let m = made.clone();
        let s = restart_on_error(
            move || -> BoxStream<'static, Result<u32, &'static str>> {
                let n = {
                    let mut made = m.lock().unwrap();
                    made.push(Instant::now());
                    made.len()
                };
                // Five that fail at once, then one that lasts a minute.
                let lasts = if n == 6 { 60 } else { 0 };
                stream::iter([Ok(1)])
                    .chain(stream::once(async move {
                        tokio::time::sleep(Duration::from_secs(lasts)).await;
                        Err("gone")
                    }))
                    .boxed()
            },
            RetryBackoff::default(),
        );
        let mut s = Box::pin(s.take(14));
        while s.next().await.is_some() {}
        let made = made.lock().unwrap();
        assert_eq!(made.len(), 7);
        let after_long = made[6] - made[5] - Duration::from_secs(60);
        assert!(after_long <= RETRY_MIN, "{after_long:?}");
    }

    #[test]
    fn the_server_is_shown_without_credentials() {
        assert_eq!(
            lost_connection("https://admin:s3cret@10.0.0.1:6443/"),
            "Lost the connection to the cluster (https://10.0.0.1:6443)"
        );
        assert_eq!(
            display_server("https://k8s.example/path@x"),
            "https://k8s.example/path@x"
        );
        assert_eq!(display_server(""), "");
    }

    fn io(kind: std::io::ErrorKind) -> std::io::Error {
        std::io::Error::new(kind, "peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof")
    }

    #[test]
    fn a_closed_connection_says_so_without_the_raw_chain() {
        let e = watcher::Error::WatchFailed(kube::Error::ReadEvents(io(
            std::io::ErrorKind::UnexpectedEof,
        )));
        assert_eq!(
            failure_text(&e, "https://127.0.0.1:45613"),
            "Lost the connection to the cluster (https://127.0.0.1:45613); retrying."
        );
        let e = watcher::Error::InitialListFailed(kube::Error::Service(Box::new(io(
            std::io::ErrorKind::ConnectionRefused,
        ))));
        assert_eq!(
            failure_text(&e, ""),
            "Lost the connection to the cluster; retrying."
        );
    }

    #[test]
    fn an_answer_from_the_server_keeps_its_message() {
        let e = watcher::Error::WatchStartFailed(kube::Error::Api(kube::core::ErrorResponse {
            status: "Failure".into(),
            message: "etcdserver: request timed out".into(),
            reason: "InternalError".into(),
            code: 500,
        }));
        assert_eq!(
            failure_text(&e, "https://x"),
            "The API server answered with an error: etcdserver: request timed out; retrying."
        );
    }

    #[cfg(unix)]
    fn failed_run() -> kube::client::AuthError {
        use std::os::unix::process::ExitStatusExt;
        let mut cmd = std::process::Command::new("aws");
        cmd.arg("eks").env("VAULT_TOKEN", "s3cret-env-value");
        kube::client::AuthError::AuthExecRun {
            cmd: format!("{cmd:?}"),
            status: std::process::ExitStatus::from_raw(255 << 8),
            out: std::process::Output {
                status: std::process::ExitStatus::from_raw(255 << 8),
                stdout: b"{\"token\":\"s3cret-stdout\"}".to_vec(),
                stderr: b"Error: SSO session expired. Run aws sso login\n".to_vec(),
            },
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_plugin_shows_stderr_but_not_env_or_stdout() {
        // kube's own text has both, so the test means something.
        let raw = failed_run().to_string();
        assert!(raw.contains("s3cret-env-value"), "{raw}");
        assert!(raw.contains("s3cret-stdout"), "{raw}");
        let e = watcher::Error::WatchFailed(kube::Error::Auth(failed_run()));
        assert_eq!(
            failure_text(&e, "https://x"),
            "Could not refresh the login: the credential plugin exited with exit code 255: \
             Error: SSO session expired. Run aws sso login; retrying."
        );
        let chain = crate::errors::chain_text(&e);
        assert!(!chain.contains("s3cret"), "{chain}");
        assert!(chain.contains("Run aws sso login"), "{chain}");
    }

    #[test]
    fn other_failures_keep_their_chain() {
        let e = watcher::Error::NoResourceVersion;
        assert_eq!(
            failure_text(&e, "https://x"),
            "no metadata.resourceVersion in watch result (does resource support watch?); retrying."
        );
    }
}
