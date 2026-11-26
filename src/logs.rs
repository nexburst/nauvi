//! Reading and streaming pod logs, and batching log lines.

use anyhow::Result;
use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use kube::Client;

/// Options shared by the CLI and the desktop app for reading pod logs.
#[derive(Debug, Clone, Default)]
pub struct LogOptions {
    /// Container name; `None` lets the API server pick the default.
    pub container: Option<String>,
    /// Read the logs of the previous (crashed/restarted) container instance.
    pub previous: bool,
    /// Number of lines from the end; `None` = everything.
    pub tail_lines: Option<i64>,
    /// Only logs newer than this many seconds.
    pub since_seconds: Option<i64>,
    /// Prefix each line with its RFC3339 timestamp.
    pub timestamps: bool,
}

impl LogOptions {
    fn to_params(&self, follow: bool) -> LogParams {
        LogParams {
            follow,
            previous: self.previous,
            tail_lines: self.tail_lines,
            since_seconds: self.since_seconds,
            timestamps: self.timestamps,
            container: self.container.clone(),
            ..LogParams::default()
        }
    }
}

/// A log that cannot be read, in plain words (#493). The text replaces the
/// API server's, so callers show it as it is.
#[derive(Debug)]
pub struct LogUnavailable(pub String);

impl std::fmt::Display for LogUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LogUnavailable {}

/// Plain words for the API server's answer `message` to a log request, when
/// it is one of those that say the log is not there (#493); `None` for any
/// other error. `previous`: the request asked for the previous run.
pub fn log_unavailable_text(message: &str, previous: bool) -> Option<String> {
    if message.contains(RUNTIME_LOG_GONE.trim_end()) {
        return Some(if previous {
            "The logs of the previous run are no longer on the node: Kubernetes keeps only the \
             last finished run, and the container runtime may already have removed it."
                .into()
        } else {
            "The logs of this run are no longer on the node: the container runtime has \
             removed them."
                .into()
        });
    }
    if message.contains("previous terminated container") && message.contains("not found") {
        return Some(
            "This container has no previous run: it has not restarted since the pod started."
                .into(),
        );
    }
    if let Some((_, reason)) = message.split_once("is waiting to start: ") {
        let reason = reason.trim();
        let reason = reason.split_whitespace().next().unwrap_or(reason);
        return Some(format!(
            "The container has not started yet ({reason}), so it has no logs yet."
        ));
    }
    None
}

/// How the kubelet starts the body it answers (with a 200) when the
/// runtime no longer has a container's log file.
const RUNTIME_LOG_GONE: &str = "unable to retrieve container logs for ";

/// Whether `line`, the first of a log, is the kubelet saying the log is gone
/// rather than a line of it: `unable to retrieve container logs for
/// containerd://<id>` and nothing else (#493).
fn gone_line(line: &str, previous: bool) -> Option<LogUnavailable> {
    let id = line.trim_end().strip_prefix(RUNTIME_LOG_GONE)?;
    if !id.contains("://") || id.contains(char::is_whitespace) {
        return None;
    }
    log_unavailable_text(line, previous).map(LogUnavailable)
}

/// The error of a log request: [`LogUnavailable`] when the log is not there.
fn log_error(e: kube::Error, previous: bool) -> anyhow::Error {
    match log_unavailable_text(&e.to_string(), previous) {
        Some(text) => LogUnavailable(text).into(),
        None => e.into(),
    }
}

/// Fetch a pod's logs in one go (non-streaming, for the CLI).
pub async fn get_pod_logs(
    client: &Client,
    namespace: &str,
    name: &str,
    opts: &LogOptions,
) -> Result<String> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let text = pods
        .logs(name, &opts.to_params(false))
        .await
        .map_err(|e| log_error(e, opts.previous))?;
    let mut lines = text.lines();
    if let (Some(first), None) = (lines.next(), lines.next()) {
        if let Some(gone) = gone_line(first, opts.previous) {
            return Err(gone.into());
        }
    }
    Ok(text)
}

/// Stream a pod's logs, calling `on_line` for each line. Runs until the
/// stream ends (or the caller drops the future). With `previous` set the
/// container is no longer running, so the log is read once (no follow) and
/// the stream simply ends.
pub async fn stream_pod_logs<F>(
    client: &Client,
    namespace: &str,
    name: &str,
    opts: &LogOptions,
    on_line: F,
) -> Result<()>
where
    F: FnMut(String) + Send,
{
    stream_pod_logs_follow(client, namespace, name, opts, !opts.previous, on_line).await
}

/// [`stream_pod_logs`] with an explicit `follow`.
pub(crate) async fn stream_pod_logs_follow<F>(
    client: &Client,
    namespace: &str,
    name: &str,
    opts: &LogOptions,
    follow: bool,
    mut on_line: F,
) -> Result<()>
where
    F: FnMut(String) + Send,
{
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = opts.to_params(follow);
    let mut lines = pods
        .log_stream(name, &params)
        .await
        .map_err(|e| log_error(e, opts.previous))?
        .lines();
    let mut first = true;
    while let Some(line) = lines.try_next().await? {
        if std::mem::take(&mut first) {
            if let Some(gone) = gone_line(&line, opts.previous) {
                return Err(gone.into());
            }
        }
        on_line(line);
    }
    Ok(())
}

/// [`stream_pod_logs`] into a bounded channel: when `tx` is full the read
/// waits, so a log that comes in faster than it is shown stays in the API
/// server's buffers, not in ours (#397). Ends early, without an error, when
/// the receiver is gone.
pub async fn stream_pod_logs_into(
    client: &Client,
    namespace: &str,
    name: &str,
    opts: &LogOptions,
    tx: tokio::sync::mpsc::Sender<String>,
) -> Result<()> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = opts.to_params(!opts.previous);
    let mut lines = pods
        .log_stream(name, &params)
        .await
        .map_err(|e| log_error(e, opts.previous))?
        .lines();
    let mut first = true;
    while let Some(line) = lines.try_next().await? {
        if std::mem::take(&mut first) {
            if let Some(gone) = gone_line(&line, opts.previous) {
                return Err(gone.into());
            }
        }
        if tx.send(line).await.is_err() {
            break;
        }
    }
    Ok(())
}

/// Collect lines from `rx` into batches and hand each to `emit`. A batch is
/// flushed when it reaches `max_lines` or when `interval` has passed since its
/// first line, so a noisy pod costs one event per batch instead of per line.
/// Returns (after flushing the remainder) once all senders are dropped.
pub async fn batch_lines<T, F>(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<T>,
    max_lines: usize,
    interval: std::time::Duration,
    mut emit: F,
) where
    F: FnMut(Vec<T>),
{
    let mut batch: Vec<T> = Vec::new();
    let mut deadline: Option<tokio::time::Instant> = None;
    loop {
        let sleep = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            line = rx.recv() => match line {
                Some(line) => {
                    if batch.is_empty() {
                        deadline = Some(tokio::time::Instant::now() + interval);
                    }
                    batch.push(line);
                    if batch.len() >= max_lines {
                        deadline = None;
                        emit(std::mem::take(&mut batch));
                    }
                }
                None => break,
            },
            _ = sleep => {
                deadline = None;
                if !batch.is_empty() {
                    emit(std::mem::take(&mut batch));
                }
            }
        }
    }
    if !batch.is_empty() {
        emit(batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn batch_lines_flushes_on_size_and_on_close() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        for i in 0..5 {
            tx.send(i.to_string()).unwrap();
        }
        drop(tx);
        let mut out: Vec<Vec<String>> = Vec::new();
        batch_lines(rx, 2, std::time::Duration::from_millis(50), |b| out.push(b)).await;
        let sizes: Vec<usize> = out.iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![2, 2, 1]);
        assert_eq!(out[2], vec!["4".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn batch_lines_flushes_on_interval() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(batch_lines(
            rx,
            500,
            std::time::Duration::from_millis(50),
            move |b| {
                let _ = out_tx.send(b);
            },
        ));
        tx.send("a".into()).unwrap();
        tx.send("b".into()).unwrap();
        // Sender still open: only the timer can flush.
        let first = out_rx.recv().await.unwrap();
        assert_eq!(first, vec!["a".to_string(), "b".to_string()]);
        tx.send("c".into()).unwrap();
        drop(tx);
        task.await.unwrap();
        assert_eq!(out_rx.recv().await.unwrap(), vec!["c".to_string()]);
    }

    #[test]
    fn log_unavailable_text_explains_missing_logs() {
        let gone = "unable to retrieve container logs for containerd://1176904011d8d1adde";
        let prev = log_unavailable_text(gone, true).unwrap();
        assert!(prev.starts_with("The logs of the previous run are no longer on the node"));
        assert!(!prev.contains("containerd"));
        assert!(log_unavailable_text(gone, false)
            .unwrap()
            .starts_with("The logs of this run"));
        let none = r#"previous terminated container "app" in pod "web-1" not found"#;
        assert_eq!(
            log_unavailable_text(none, true).as_deref(),
            Some("This container has no previous run: it has not restarted since the pod started.")
        );
        let waiting = r#"container "app" in pod "web-1" is waiting to start: ContainerCreating"#;
        assert_eq!(
            log_unavailable_text(waiting, false).as_deref(),
            Some("The container has not started yet (ContainerCreating), so it has no logs yet.")
        );
        assert_eq!(log_unavailable_text("pods \"x\" is forbidden", false), None);
    }

    #[test]
    fn gone_line_is_only_the_kubelet_answer() {
        let body = "unable to retrieve container logs for containerd://38505ea6f0ae";
        assert!(gone_line(body, true).is_some());
        assert!(gone_line(&format!("{body}\n"), true).is_some());
        // A log line that happens to start the same way is a log line.
        assert!(gone_line(
            "unable to retrieve container logs for my app, retrying",
            false
        )
        .is_none());
        assert!(gone_line("hello", false).is_none());
    }

    #[test]
    fn log_options_map_to_params() {
        let opts = LogOptions {
            previous: true,
            container: Some("app".into()),
            since_seconds: Some(300),
            ..LogOptions::default()
        };
        let p = opts.to_params(!opts.previous);
        assert!(p.previous && !p.follow);
        assert_eq!(p.container.as_deref(), Some("app"));
        assert_eq!(p.since_seconds, Some(300));
    }
}
