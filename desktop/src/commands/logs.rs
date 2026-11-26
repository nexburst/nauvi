//! Pod and workload log streams, and saving logs.

use super::log_flow::{batch_with_credit, queue};
use super::log_frame::{send, LogChannel, LogEvent, LogFrame};
use super::raw_body::RawUpload;
use crate::state::Cluster;
use nauvi::{
    stream_pod_containers_logs, stream_pod_logs_into, stream_workload_logs, LogOptions, StopReason,
    WorkloadEvent, WorkloadKind,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

/// Flush a log batch after this many lines or this long, whichever is first.
const LOG_BATCH_LINES: usize = 1000;
const LOG_BATCH_INTERVAL: Duration = Duration::from_millis(50);

/// Follow one container of a pod. Lines, errors and the end go to
/// `on_event`, the channel of the tab that asked (#115); `stream_id` names
/// the stream for `cmd_stop_logs` and `cmd_log_ack`: the tab acknowledges
/// each batch of lines it gets, and at most `log_flow::WINDOW` bytes are
/// sent ahead of that (#397).
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_stream_pod_logs(
    cluster: Cluster,
    namespace: String,
    name: String,
    container: Option<String>,
    previous: Option<bool>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    stream_id: u64,
    on_event: LogChannel,
) -> Result<(), String> {
    let client = cluster.client().await?;
    let out = on_event;
    let opts = LogOptions {
        container,
        previous: previous.unwrap_or(false),
        tail_lines,
        since_seconds,
        timestamps: timestamps.unwrap_or(false),
    };
    let credit = cluster.log_streams.new_credit(stream_id);
    cluster.log_streams.start(stream_id, move || {
        tauri::async_runtime::spawn(async move {
            let (tx, rx) = queue();
            let emitter = out.clone();
            let batcher = tauri::async_runtime::spawn(batch_with_credit(
                rx,
                LOG_BATCH_LINES,
                LOG_BATCH_INTERVAL,
                credit,
                move |batch: Vec<String>| {
                    let frame = LogFrame::lines(&batch);
                    let bytes = match &frame {
                        LogFrame::Lines(b) => b.len(),
                        LogFrame::Event(_) => 0,
                    };
                    send(&emitter, frame);
                    bytes
                },
            ));
            // Aborting this task drops the reader but not the batcher.
            let _abort = AbortOnDrop(batcher.inner().abort_handle());
            let result = stream_pod_logs_into(&client, &namespace, &name, &opts, tx).await;
            // The sender is gone, so the batcher flushes and exits.
            let _ = batcher.await;
            end_stream(&out, result);
        })
    })
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkloadNoticeKind {
    /// A per-container stream started (a pod appeared).
    Started,
    /// The container exited and its log ended.
    Ended,
    /// The pod was deleted.
    Deleted,
    /// The stream failed; see `message`.
    Failed,
    /// More containers match than the stream limit: `skipped` are waiting.
    Truncated,
}

/// A change in which pods a merged stream is following.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkloadNotice {
    kind: WorkloadNoticeKind,
    /// Empty for `truncated`.
    pod: String,
    container: String,
    message: String,
    /// For `truncated`: the stream limit and how many containers are waiting.
    limit: u32,
    skipped: u32,
}

/// Options of a workload log stream.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkloadLogOptions {
    /// One container name for every pod; `None` follows all containers.
    container: Option<String>,
    /// Applies to the pods present when the stream starts; pods that appear
    /// later are read from their beginning.
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
}

fn workload_notice(ev: WorkloadEvent) -> Option<WorkloadNotice> {
    let (kind, pod, container, message, limit, skipped) = match ev {
        WorkloadEvent::Lines(_) => return None,
        WorkloadEvent::Started { pod, container } => (
            WorkloadNoticeKind::Started,
            pod,
            container,
            String::new(),
            0,
            0,
        ),
        WorkloadEvent::Stopped {
            pod,
            container,
            reason,
        } => {
            let (kind, message) = match reason {
                StopReason::Deleted => (WorkloadNoticeKind::Deleted, "pod deleted".to_string()),
                StopReason::Ended => (WorkloadNoticeKind::Ended, "log ended".to_string()),
                StopReason::Failed(e) => (WorkloadNoticeKind::Failed, e),
            };
            (kind, pod, container, message, 0, 0)
        }
        WorkloadEvent::Truncated { limit, skipped } => (
            WorkloadNoticeKind::Truncated,
            String::new(),
            String::new(),
            format!("following {limit} containers, {skipped} more waiting"),
            limit as u32,
            skipped as u32,
        ),
    };
    Some(WorkloadNotice {
        kind,
        pod,
        container,
        message,
        limit,
        skipped,
    })
}

/// Follow the logs of all pods of a Deployment, StatefulSet, DaemonSet, Job
/// or ReplicaSet (`kind` is case-insensitive). Runs next to the other log
/// streams (up to `MAX_LOG_STREAMS`) until `cmd_stop_logs`, its cluster is disconnected or
/// its window closes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_stream_workload_logs(
    cluster: Cluster,
    kind: String,
    namespace: String,
    name: String,
    options: WorkloadLogOptions,
    stream_id: u64,
    on_event: LogChannel,
) -> Result<(), String> {
    let kind = kind.parse::<WorkloadKind>().map_err(|e| e.to_string())?;
    let client = cluster.client().await?;
    let out = on_event;
    let opts = LogOptions {
        container: options.container,
        previous: false,
        tail_lines: options.tail_lines,
        since_seconds: options.since_seconds,
        timestamps: options.timestamps.unwrap_or(false),
    };
    cluster.log_streams.start(stream_id, move || {
        tauri::async_runtime::spawn(async move {
            let emitter = out.clone();
            let result = stream_workload_logs(&client, kind, &namespace, &name, &opts, move |ev| {
                emit_tagged(&emitter, ev)
            })
            .await;
            end_stream(&out, result);
        })
    })
}

/// Follow every container of one pod at once, merged and tagged by container
/// like a workload stream (same events as [`cmd_stream_workload_logs`]).
/// `options.container` narrows it to one container; previous logs are not
/// offered (they are per container).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_stream_pod_all_logs(
    cluster: Cluster,
    namespace: String,
    name: String,
    options: WorkloadLogOptions,
    stream_id: u64,
    on_event: LogChannel,
) -> Result<(), String> {
    let client = cluster.client().await?;
    let out = on_event;
    let opts = LogOptions {
        container: options.container,
        previous: false,
        tail_lines: options.tail_lines,
        since_seconds: options.since_seconds,
        timestamps: options.timestamps.unwrap_or(false),
    };
    cluster.log_streams.start(stream_id, move || {
        tauri::async_runtime::spawn(async move {
            let emitter = out.clone();
            let result = stream_pod_containers_logs(&client, &namespace, &name, &opts, move |ev| {
                emit_tagged(&emitter, ev)
            })
            .await;
            end_stream(&out, result);
        })
    })
}

/// Send one event of a merged (tagged) log stream.
fn emit_tagged(out: &LogChannel, ev: WorkloadEvent) {
    match ev {
        WorkloadEvent::Lines(data) => send(out, LogFrame::Event(LogEvent::Tagged { data })),
        ev => {
            if let Some(n) = workload_notice(ev) {
                send(out, LogFrame::Event(LogEvent::Notice(n)));
            }
        }
    }
}

/// Aborts a task when dropped.
struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The tab of pod log stream `stream_id` got `bytes` of lines (the length
/// of the raw message), which lets the backend send more (#397).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_log_ack(
    cluster: Cluster,
    stream_id: u64,
    bytes: u32,
) -> Result<(), String> {
    cluster.log_streams.ack(stream_id, bytes as usize);
    Ok(())
}

/// Report how a log stream ended.
fn end_stream(out: &LogChannel, result: anyhow::Result<()>) {
    if let Err(e) = result {
        // A log that is not there (#493) is said in plain words, as is.
        let message = match e.downcast_ref::<nauvi::LogUnavailable>() {
            Some(gone) => gone.to_string(),
            None => format!(
                "Log stream ended with an error: {}",
                nauvi::errors::error_text(&e)
            ),
        };
        send(out, LogFrame::Event(LogEvent::Error { message }));
    }
    send(out, LogFrame::Event(LogEvent::Done));
}

/// Save log text to the user's Downloads folder and return the path. A
/// webview Blob download is not reliable across the platforms Tauri targets
/// and there is no file dialog without an extra plugin, so we write directly.
/// The text comes as raw bytes (#115), `<file name>\n<log text>`: call it
/// through `saveLogs` in `lib/rawIpc.ts`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_save_logs(upload: RawUpload) -> Result<String, String> {
    let RawUpload {
        head: filename,
        body: content,
    } = upload;
    let safe = log_file_name(&filename);
    // Windows keeps the profile in USERPROFILE; HOME there (Git Bash, MSYS)
    // may point somewhere else.
    let (first, second) = if cfg!(windows) {
        ("USERPROFILE", "HOME")
    } else {
        ("HOME", "USERPROFILE")
    };
    let home = std::env::var_os(first)
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os(second).filter(|v| !v.is_empty()))
        .ok_or("cannot locate home directory")?;
    let dir = std::path::PathBuf::from(home).join("Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = write_new_file(&dir, &safe, &content)
        .map_err(|e| format!("could not save the logs in {}: {e}", dir.display()))?;
    Ok(path.display().to_string())
}

/// The name a saved log gets in Downloads: `filename` with only ASCII
/// letters, digits, `-`, `_` and `.` (the rest become `_`), never hidden,
/// and always ending in `.log`, so the page cannot leave a runnable file
/// (`.desktop`, `.sh`, `.exe`) there.
fn log_file_name(filename: &str) -> String {
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() || safe.starts_with('.') {
        format!("log{safe}")
    } else {
        safe
    };
    if safe.ends_with(".log") {
        safe
    } else {
        format!("{safe}.log")
    }
}

/// Write `content` to a new file `name` in `dir`, or to `stem (1).ext`,
/// `stem (2).ext` and so on if that name is taken. It never overwrites a file
/// and never follows a symlink: `create_new` fails on any existing entry.
fn write_new_file(
    dir: &std::path::Path,
    name: &str,
    content: &[u8],
) -> std::io::Result<std::path::PathBuf> {
    use std::io::Write;
    let base = std::path::Path::new(name);
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = base.extension().and_then(|s| s.to_str());
    for n in 0..1000 {
        let candidate = match (n, ext) {
            (0, _) => name.to_string(),
            (_, Some(ext)) => format!("{stem} ({n}).{ext}"),
            (_, None) => format!("{stem} ({n})"),
        };
        let path = dir.join(candidate);
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if let Err(e) = file.write_all(content).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
        return Ok(path);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("{name} and 999 numbered copies of it already exist"),
    ))
}

/// Stop one log stream (pod or workload, with every per-pod task under it).
/// Other streams keep running.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_stop_logs(cluster: Cluster, stream_id: u64) -> Result<(), String> {
    cluster.log_streams.stop(stream_id);
    Ok(())
}

#[cfg(test)]
mod save_tests {
    use super::{log_file_name, write_new_file};

    #[test]
    fn a_saved_log_always_ends_in_dot_log() {
        assert_eq!(log_file_name("web-1_app_2026.log"), "web-1_app_2026.log");
        assert_eq!(log_file_name("evil.desktop"), "evil.desktop.log");
        assert_eq!(log_file_name("run.sh"), "run.sh.log");
        assert_eq!(log_file_name("x.LOG"), "x.LOG.log");
        assert_eq!(log_file_name("../../.bashrc"), "log.._.._.bashrc.log");
        assert_eq!(log_file_name(""), "log.log");
        assert_eq!(log_file_name("é ü/a"), "____a.log");
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nauvi-save-logs-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn never_overwrites_and_numbers_the_copies() {
        let dir = temp_dir("numbers");
        let first = write_new_file(&dir, "web.log", b"one").unwrap();
        let second = write_new_file(&dir, "web.log", b"two").unwrap();
        let third = write_new_file(&dir, "web.log", b"three").unwrap();
        assert_eq!(first, dir.join("web.log"));
        assert_eq!(second, dir.join("web (1).log"));
        assert_eq!(third, dir.join("web (2).log"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
        let plain = write_new_file(&dir, "logs", b"x").unwrap();
        let plain2 = write_new_file(&dir, "logs", b"y").unwrap();
        assert_eq!((plain, plain2), (dir.join("logs"), dir.join("logs (1)")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlink() {
        let dir = temp_dir("symlink");
        let target = dir.join("target.txt");
        std::fs::write(&target, b"keep").unwrap();
        std::os::unix::fs::symlink(&target, dir.join("web.log")).unwrap();
        // A dangling link too: create_new must not create its target.
        std::os::unix::fs::symlink(dir.join("missing"), dir.join("web (1).log")).unwrap();
        let path = write_new_file(&dir, "web.log", b"new").unwrap();
        assert_eq!(path, dir.join("web (2).log"));
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        assert!(!dir.join("missing").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
