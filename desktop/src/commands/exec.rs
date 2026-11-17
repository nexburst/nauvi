//! Interactive terminal sessions in pods.

use super::term_frame::{TermChannel, Utf8Cut};
use super::term_out::{send_closed, send_data, TermOut};
use crate::state::mutation::Mutation;
use crate::state::{next_session, Cluster, ExecSession, SessionCleanup};
use futures::SinkExt;
use kube::api::{AttachedProcess, TerminalSize};
use nauvi::attach::{attach_note, attach_pod, describe_attach_error};
use nauvi::exec_pod;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// The most one read of a session's output takes: under a flood the reads
/// fill up, so the tab gets fewer, bigger messages (#115).
const READ_BUF: usize = 64 * 1024;

/// Ctrl-C: typing it drops the session's output still waiting to be sent,
/// so the prompt shows at once instead of after the backlog (#115).
pub(crate) const INTERRUPT: char = '\x03';

/// Open an interactive shell in a pod. Returns the session id; the output
/// arrives on `on_output` (this session's own channel, #115), then `closed`
/// when the shell exits.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_exec_start(
    cluster: Mutation,
    namespace: String,
    name: String,
    container: Option<String>,
    cols: u16,
    rows: u16,
    on_output: TermChannel,
) -> Result<String, String> {
    let client = cluster.client().await?;
    let attached = exec_pod(&client, &namespace, &name, container.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let session = next_session("exec");
    let close = SessionClose {
        end_shell: true,
        cleanup: None,
    };
    let out = SessionOut {
        cols,
        rows,
        on_output: TermOut::new(on_output),
    };
    start_session(&cluster, session.clone(), attached, out, close).await;
    Ok(session)
}

/// Attach to the main process of a pod's container (`container`: `None` for
/// the default one). Returns the session id; the session works like a shell's
/// (output on `on_output`). Closing it detaches and leaves the process
/// running. Fails, in plain words, when the container has no stdin or is not
/// running.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_attach_start(
    cluster: Mutation,
    namespace: String,
    name: String,
    container: Option<String>,
    cols: u16,
    rows: u16,
    on_output: TermChannel,
) -> Result<String, String> {
    let client = cluster.client().await?;
    let (target, attached) = attach_pod(&client, &namespace, &name, container.as_deref())
        .await
        .map_err(|e| describe_attach_error(&e))?;
    let session = next_session("attach");
    let on_output = TermOut::new(on_output);
    // Arrives before the UI knows the id: the channel is the tab's own.
    emit_note(
        &on_output,
        &attach_note(&name, &target, "Closing this tab detaches."),
    );
    // Closing detaches (#88): the main process keeps running.
    let close = SessionClose {
        end_shell: false,
        cleanup: None,
    };
    let out = SessionOut {
        cols,
        rows,
        on_output,
    };
    start_session(&cluster, session.clone(), attached, out, close).await;
    Ok(session)
}

/// Where a terminal session's output goes, and the size it starts with.
pub(crate) struct SessionOut {
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) on_output: TermOut,
}

/// What closing a terminal session does.
pub(crate) struct SessionClose {
    /// End the shell first (exec, debug container), rather than detach.
    pub(crate) end_shell: bool,
    /// What to remove when the session ends or is closed (a node shell's
    /// pod).
    pub(crate) cleanup: Option<SessionCleanup>,
}

/// Write a line of text into a terminal session (progress, notes).
pub(crate) fn emit_note(out: &TermOut, text: &str) {
    send_data(out, format!("\x1b[90m{text}\x1b[0m\r\n").into_bytes());
}

/// Send what `r` reads to `out` until it ends.
async fn pump(r: Option<impl AsyncRead + Unpin>, out: &TermOut) {
    let Some(mut r) = r else { return };
    let mut buf = vec![0u8; READ_BUF];
    let mut cut = Utf8Cut::default();
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => send_data(out, cut.push(&buf[..n])),
        }
    }
}

/// Pump an attached or exec'd process to its session's channel and
/// register it as `session`, so `cmd_exec_input`, `cmd_exec_resize` and
/// `cmd_exec_close` drive it. `close` says what closing it does.
pub(crate) async fn start_session(
    cluster: &Cluster,
    session: String,
    mut attached: AttachedProcess,
    out: SessionOut,
    close: SessionClose,
) {
    let SessionClose { end_shell, cleanup } = close;
    let SessionOut {
        cols,
        rows,
        on_output,
    } = out;
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let mut stdin_writer = attached.stdin();
    let stdout_reader = attached.stdout();
    let stderr_reader = attached.stderr();
    let mut size_tx = attached.terminal_size();
    if let Some(tx) = size_tx.as_mut() {
        let _ = tx
            .send(TerminalSize {
                width: cols,
                height: rows,
            })
            .await;
    }
    // Surface a failed exec (e.g. no kubelet) in the terminal: join() alone
    // returns Ok even on failure; the Status channel carries the error.
    if let Some(status_fut) = attached.take_status() {
        let status_out = on_output.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(status) = status_fut.await {
                if status.status.as_deref() == Some("Failure") {
                    if let Some(msg) = status.message {
                        send_data(&status_out, format!("\r\n{msg}\r\n").into_bytes());
                    }
                }
            }
        });
    }
    let task_cleanup = cleanup.clone();
    let task_out = on_output.clone();
    let task = tauri::async_runtime::spawn(async move {
        let stdin_pump = async {
            if let Some(mut w) = stdin_writer.take() {
                while let Some(bytes) = stdin_rx.recv().await {
                    if w.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                let _ = w.shutdown().await;
            }
        };
        let stdout_pump = pump(stdout_reader, &task_out);
        let stderr_pump = pump(stderr_reader, &task_out);
        // The stdin pump waits on its channel, so it would outlive the shell;
        // finish when either all pumps end or the process itself exits.
        tokio::select! {
            () = async { tokio::join!(stdin_pump, stdout_pump, stderr_pump); } => {},
            _ = attached.join() => {},
        }
        if let Some(c) = task_cleanup {
            c.run().await;
        }
        send_closed(&task_out);
    });
    let stopped = cluster.add_exec(
        session,
        ExecSession {
            stdin_tx,
            size_tx,
            task,
            cleanup,
            end_on_close: end_shell,
            out: on_output,
        },
    );
    if let Some(s) = stopped {
        s.close().await;
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_exec_input(
    cluster: Cluster,
    session: String,
    data: String,
) -> Result<(), String> {
    // Clone the sender under the lock, then await outside it: holding a
    // std MutexGuard across an await would make this future non-Send.
    let tx = {
        let sessions = cluster.exec_sessions.lock().unwrap();
        let entry = sessions.get(&session);
        if let Some(e) = entry.filter(|_| data.contains(INTERRUPT)) {
            e.out.clear();
        }
        entry.map(|e| e.stdin_tx.clone())
    };
    let Some(tx) = tx else {
        return Err("exec session not found".to_string());
    };
    tx.send(data.into_bytes())
        .await
        .map_err(|_| "exec session closed".to_string())
}

/// The tab wrote (or dropped) `bytes` of the session's output: that much
/// more may be sent (#115). A session already gone is no error.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_exec_ack(
    cluster: Cluster,
    session: String,
    bytes: u32,
) -> Result<(), String> {
    if let Some(e) = cluster.exec_sessions.lock().unwrap().get(&session) {
        e.out.ack(bytes as usize);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_exec_resize(
    cluster: Cluster,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let tx = {
        let sessions = cluster.exec_sessions.lock().unwrap();
        sessions
            .get(&session)
            .and_then(|entry| entry.size_tx.clone())
    };
    if let Some(mut tx) = tx {
        tx.send(TerminalSize {
            width: cols,
            height: rows,
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_exec_close(cluster: Cluster, session: String) -> Result<(), String> {
    let entry = cluster.exec_sessions.lock().unwrap().remove(&session);
    if let Some(entry) = entry {
        entry.close().await;
    }
    Ok(())
}
