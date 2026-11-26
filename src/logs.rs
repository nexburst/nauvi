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
        // The whole reason: "ContainerCreating", or a phrase such as
        // "trying and failing to pull image" (ImagePullBackOff).
        let reason = reason.trim().trim_end_matches('.');
        return Some(format!(
            "The container has not started yet ({reason}), so it has no logs yet."
        ));
    }
    None
}

/// How the kubelet starts the body it answers (with a 200) when the
/// runtime no longer has a container's log file.
const RUNTIME_LOG_GONE: &str = "unable to retrieve container logs for ";

/// The container id in `line` when it has the form of the kubelet's answer
/// for a log that is gone: `unable to retrieve container logs for
/// containerd://<id>` and nothing else (#493).
fn gone_id(line: &str) -> Option<&str> {
    let id = line.trim_end().strip_prefix(RUNTIME_LOG_GONE)?;
    (id.contains("://") && !id.contains(char::is_whitespace)).then_some(id)
}

/// Whether `id` is the `containerID` of a run of `container` (any
/// container when `None`) in the pod's status: the current run or the last
/// finished one, of a container, init container or ephemeral container.
/// The workload writes its log but not its pod's status, so it cannot make
/// one of its lines pass for the kubelet's answer by naming a made-up id
/// (#520).
fn status_has_container_id(pod: &Pod, container: Option<&str>, id: &str) -> bool {
    let Some(status) = &pod.status else {
        return false;
    };
    [
        &status.container_statuses,
        &status.init_container_statuses,
        &status.ephemeral_container_statuses,
    ]
    .into_iter()
    .flatten()
    .flatten()
    .filter(|c| container.is_none_or(|name| c.name == name))
    .any(|c| {
        let last = c.last_state.as_ref().and_then(|s| s.terminated.as_ref());
        let finished = c.state.as_ref().and_then(|s| s.terminated.as_ref());
        c.container_id.as_deref() == Some(id)
            || [last, finished]
                .into_iter()
                .flatten()
                .any(|t| t.container_id.as_deref() == Some(id))
    })
}

/// Whether `id`, from a line shaped as the kubelet's answer, names a run of
/// the container in the pod's status; `false` when the pod cannot be read.
async fn id_in_status(pods: &Api<Pod>, name: &str, opts: &LogOptions, id: &str) -> bool {
    match pods.get(name).await {
        Ok(pod) => status_has_container_id(&pod, opts.container.as_deref(), id),
        Err(_) => false,
    }
}

/// The kubelet's answer for a log that is gone, as [`LogUnavailable`], when
/// `line` is the whole log, has its form and `confirm` (the id) holds.
async fn gone_line<C, Fut>(line: &str, previous: bool, confirm: C) -> Option<LogUnavailable>
where
    C: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let id = gone_id(line)?;
    if !confirm(id.to_string()).await {
        return None;
    }
    log_unavailable_text(line, previous).map(LogUnavailable)
}

/// The first lines of a log stream to pass on, then how the head ended:
/// `Ok` to read on, or an error, the [`LogUnavailable`] one when the stream
/// is only the kubelet's answer for a log that is gone. A first line of that
/// form is held until the next line (then it was a log line) or the end of
/// the stream (then its id is checked with `confirm`): the kubelet ends the
/// stream after its answer (#520). When reading the next line fails, the
/// held line is still passed on, before the error.
async fn stream_head<S, C, Fut>(
    lines: &mut S,
    previous: bool,
    confirm: C,
) -> (Vec<String>, Result<()>)
where
    S: futures::Stream<Item = std::io::Result<String>> + Unpin,
    C: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let first = match lines.try_next().await {
        Ok(Some(first)) => first,
        Ok(None) => return (Vec::new(), Ok(())),
        Err(e) => return (Vec::new(), Err(e.into())),
    };
    if gone_id(&first).is_none() {
        return (vec![first], Ok(()));
    }
    match lines.try_next().await {
        Ok(Some(second)) => (vec![first, second], Ok(())),
        Ok(None) => match gone_line(&first, previous, confirm).await {
            Some(gone) => (Vec::new(), Err(gone.into())),
            None => (vec![first], Ok(())),
        },
        Err(e) => (vec![first], Err(e.into())),
    }
}

/// The error of a log request: [`LogUnavailable`] when the log is not there.
fn log_error(e: kube::Error, previous: bool) -> anyhow::Error {
    // The API server's own message: `Display` adds the reason and code after it.
    let message = match &e {
        kube::Error::Api(status) => status.message.clone(),
        other => other.to_string(),
    };
    match log_unavailable_text(&message, previous) {
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
        let confirm = |id: String| async move { id_in_status(&pods, name, opts, &id).await };
        if let Some(gone) = gone_line(first, opts.previous, confirm).await {
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
    let confirm = |id: String| async move { id_in_status(&pods, name, opts, &id).await };
    let (head, ended) = stream_head(&mut lines, opts.previous, confirm).await;
    for line in head {
        on_line(line);
    }
    ended?;
    while let Some(line) = lines.try_next().await? {
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
    let confirm = |id: String| async move { id_in_status(&pods, name, opts, &id).await };
    let (head, ended) = stream_head(&mut lines, opts.previous, confirm).await;
    for line in head {
        if tx.send(line).await.is_err() {
            return Ok(());
        }
    }
    ended?;
    while let Some(line) = lines.try_next().await? {
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
    fn waiting_keeps_the_whole_reason_of_an_api_error() {
        let api = kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: r#"container "app" in pod "web-1" is waiting to start: trying and failing to pull image"#.into(),
            reason: "BadRequest".into(),
            code: 400,
            ..Default::default()
        }));
        let err = log_error(api, false);
        assert_eq!(
            err.downcast_ref::<LogUnavailable>().map(|g| g.0.as_str()),
            Some("The container has not started yet (trying and failing to pull image), so it has no logs yet.")
        );
        let pulling =
            r#"container "app" in pod "web-1" is waiting to start: image can't be pulled"#;
        assert_eq!(
            log_unavailable_text(pulling, false).as_deref(),
            Some(
                "The container has not started yet (image can't be pulled), so it has no logs yet."
            )
        );
    }

    const GONE: &str = "unable to retrieve container logs for containerd://38505ea6f0ae";

    fn yes(_: String) -> std::future::Ready<bool> {
        std::future::ready(true)
    }

    fn no(_: String) -> std::future::Ready<bool> {
        std::future::ready(false)
    }

    #[test]
    fn gone_id_is_only_the_kubelet_form() {
        assert_eq!(gone_id(GONE), Some("containerd://38505ea6f0ae"));
        assert_eq!(
            gone_id(&format!("{GONE}\n")),
            Some("containerd://38505ea6f0ae")
        );
        // A log line that happens to start the same way is a log line.
        assert_eq!(
            gone_id("unable to retrieve container logs for my app, retrying"),
            None
        );
        assert_eq!(gone_id("hello"), None);
    }

    #[tokio::test]
    async fn gone_line_needs_the_id_confirmed() {
        assert!(gone_line(GONE, true, yes).await.is_some());
        // The workload printed the line itself, with an id of no run (#520).
        assert!(gone_line(GONE, true, no).await.is_none());
        assert!(gone_line("hello", false, yes).await.is_none());
        // The id passed to `confirm` is the one in the line.
        let seen = std::sync::Mutex::new(String::new());
        let _ = gone_line(GONE, false, |id| {
            *seen.lock().unwrap() = id;
            std::future::ready(false)
        })
        .await;
        assert_eq!(*seen.lock().unwrap(), "containerd://38505ea6f0ae");
    }

    fn lines(v: &[&str]) -> impl futures::Stream<Item = std::io::Result<String>> + Unpin {
        futures::stream::iter(
            v.iter()
                .map(|l| Ok(l.to_string()))
                .collect::<Vec<std::io::Result<String>>>(),
        )
    }

    #[tokio::test]
    async fn stream_head_reports_only_a_confirmed_lone_answer() {
        // The kubelet's answer, alone, with an id of the pod's status.
        let (head, ended) = stream_head(&mut lines(&[GONE]), false, yes).await;
        let err = ended.unwrap_err();
        assert!(err.downcast_ref::<LogUnavailable>().is_some(), "{err:#}");
        assert!(head.is_empty());
        // The same line, but its id is not in the status: a log line.
        let (head, ended) = stream_head(&mut lines(&[GONE]), false, no).await;
        assert!(ended.is_ok());
        assert_eq!(head, vec![GONE.to_string()]);
        // Followed by more lines: the workload's own output, never checked.
        let confirm = |_: String| async { panic!("checked a line that has a next one") };
        let mut s = lines(&[GONE, "secret work", "more"]);
        let (head, ended) = stream_head(&mut s, false, confirm).await;
        assert!(ended.is_ok());
        assert_eq!(head, vec![GONE.to_string(), "secret work".to_string()]);
        assert_eq!(s.try_next().await.unwrap().as_deref(), Some("more"));
        // Ordinary logs and an empty one.
        let (head, ended) = stream_head(&mut lines(&["a", "b"]), false, yes).await;
        assert!(ended.is_ok());
        assert_eq!(head, vec!["a".to_string()]);
        let (head, ended) = stream_head(&mut lines(&[]), false, yes).await;
        assert!(ended.is_ok() && head.is_empty());
    }

    #[tokio::test]
    async fn stream_head_passes_the_held_line_on_before_a_read_error() {
        let broken = || std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        // The read after a held line fails: the line is kept, then the error.
        let confirm = |_: String| async { panic!("checked a line whose next read failed") };
        let mut s = futures::stream::iter(vec![Ok(GONE.to_string()), Err(broken())]);
        let (head, ended) = stream_head(&mut s, false, confirm).await;
        assert_eq!(head, vec![GONE.to_string()]);
        let err = ended.unwrap_err();
        assert!(err.downcast_ref::<LogUnavailable>().is_none(), "{err:#}");
        assert!(format!("{err:#}").contains("reset"), "{err:#}");
        // The first read fails: nothing to pass on, only the error.
        let mut s = futures::stream::iter(vec![Err::<String, _>(broken())]);
        let (head, ended) = stream_head(&mut s, false, yes).await;
        assert!(head.is_empty() && ended.is_err());
    }

    fn pod_with_status(status: serde_json::Value) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "web-1" },
            "status": status,
        }))
        .unwrap()
    }

    #[test]
    fn container_id_must_be_a_run_in_the_status() {
        let pod = pod_with_status(serde_json::json!({
            "containerStatuses": [{
                "name": "app", "image": "x", "imageID": "", "ready": true, "restartCount": 1,
                "containerID": "containerd://now",
                "state": { "running": {} },
                "lastState": { "terminated": { "exitCode": 1, "containerID": "containerd://before" } },
            }, {
                "name": "sidecar", "image": "x", "imageID": "", "ready": true, "restartCount": 0,
                "containerID": "containerd://side",
            }],
            "initContainerStatuses": [{
                "name": "init", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "terminated": { "exitCode": 0, "containerID": "containerd://init" } },
            }],
        }));
        let has = |c: Option<&str>, id: &str| status_has_container_id(&pod, c, id);
        assert!(has(Some("app"), "containerd://now"));
        assert!(has(Some("app"), "containerd://before"));
        assert!(has(Some("init"), "containerd://init"));
        assert!(has(None, "containerd://side"));
        // Another container's id, or one that is in no status.
        assert!(!has(Some("app"), "containerd://side"));
        assert!(!has(Some("app"), "containerd://38505ea6f0ae"));
        assert!(!has(None, "containerd://made-up"));
        assert!(!status_has_container_id(
            &pod_with_status(serde_json::json!({})),
            None,
            "containerd://now"
        ));
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
