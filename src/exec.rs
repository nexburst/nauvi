//! Running commands and interactive shells in pods.

use anyhow::Result;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, AttachedProcess};
use kube::Client;
use std::future::Future;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc::Sender;

// ---------------------------------------------------------------------------
// Pod exec.
// ---------------------------------------------------------------------------

/// Open an interactive TTY shell (`/bin/sh`) in a pod. The caller drives
/// stdin/stdout/stderr and the terminal size on the returned process.
pub async fn exec_pod(
    client: &Client,
    namespace: &str,
    name: &str,
    container: Option<&str>,
) -> Result<AttachedProcess> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let mut params = AttachParams::interactive_tty();
    params.container = container.map(str::to_string);
    Ok(pods.exec(name, ["/bin/sh"], &params).await?)
}

/// What [`end_shell`] types into a shell: Ctrl-C (stops the foreground
/// command, drops a half-typed line), then Ctrl-D (end of input at the
/// prompt, so the shell exits).
pub const END_SHELL_KEYS: &[u8] = b"\x03\x04";

/// How often [`end_shell`] types [`END_SHELL_KEYS`]: once per nested shell
/// or interrupted command.
pub const END_SHELL_INTERVAL: Duration = Duration::from_millis(300);

/// How long [`end_shell`] waits for the shell to exit.
pub const END_SHELL_WAIT: Duration = Duration::from_secs(2);

/// End an interactive TTY shell before its connection is dropped, the way
/// typing `exit` would. Dropping the connection, or closing stdin, is not
/// enough: the container runtime keeps a TTY process alive, so every closed
/// terminal would leave its shell running in the container.
///
/// Types [`END_SHELL_KEYS`] into `stdin` every [`END_SHELL_INTERVAL`] until
/// `exited` resolves (the process ended), for at most [`END_SHELL_WAIT`].
/// Returns whether it exited. A program that ignores Ctrl-C and Ctrl-D
/// (an editor, say) keeps the shell alive.
pub async fn end_shell(stdin: &Sender<Vec<u8>>, exited: impl Future) -> bool {
    let type_keys = async {
        loop {
            if stdin.send(END_SHELL_KEYS.to_vec()).await.is_err() {
                // Nobody reads stdin any more: wait for `exited` alone.
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(END_SHELL_INTERVAL).await;
        }
    };
    let ended = async {
        tokio::select! {
            _ = exited => {},
            () = type_keys => {},
        }
    };
    tokio::time::timeout(END_SHELL_WAIT, ended).await.is_ok()
}

/// Result of a non-interactive command run in a pod.
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// Run a command in a pod (non-TTY) and collect its output.
pub async fn exec_command(
    client: &Client,
    namespace: &str,
    name: &str,
    container: Option<&str>,
    command: &[String],
) -> Result<ExecResult> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let params = AttachParams {
        container: container.map(str::to_string),
        stdin: false,
        stdout: true,
        stderr: true,
        tty: false,
        ..AttachParams::default()
    };
    let mut attached = pods.exec(name, command, &params).await?;
    let stdout_reader = attached.stdout();
    let stderr_reader = attached.stderr();
    // join() returns Ok even when the command fails — the failure is only
    // visible on the status channel, so read it too.
    let status_fut = attached.take_status();
    let read_stdout = async {
        match stdout_reader {
            Some(mut r) => {
                let mut buf = String::new();
                let _ = r.read_to_string(&mut buf).await;
                buf
            }
            None => String::new(),
        }
    };
    let read_stderr = async {
        match stderr_reader {
            Some(mut r) => {
                let mut buf = String::new();
                let _ = r.read_to_string(&mut buf).await;
                buf
            }
            None => String::new(),
        }
    };
    let read_status = async {
        match status_fut {
            Some(f) => f.await,
            None => None,
        }
    };
    let (stdout, mut stderr, joined, status) =
        tokio::join!(read_stdout, read_stderr, attached.join(), read_status);
    let mut success = joined.is_ok();
    if let Some(s) = status {
        if s.status.as_deref() == Some("Failure") {
            success = false;
            if let Some(msg) = s.message {
                if !stderr.is_empty() {
                    stderr.push('\n');
                }
                stderr.push_str(&msg);
            }
        }
    }
    Ok(ExecResult {
        stdout,
        stderr,
        success,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn end_shell_types_the_keys_until_the_shell_exits() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        // The shell exits on the second Ctrl-D (a nested shell, say).
        let shell = async move {
            for _ in 0..2 {
                assert_eq!(rx.recv().await.unwrap(), END_SHELL_KEYS);
            }
        };
        let started = tokio::time::Instant::now();
        assert!(end_shell(&tx, tokio::spawn(shell)).await);
        assert_eq!(started.elapsed(), END_SHELL_INTERVAL);
    }

    #[tokio::test(start_paused = true)]
    async fn end_shell_gives_up_after_the_wait() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let started = tokio::time::Instant::now();
        assert!(!end_shell(&tx, std::future::pending::<()>()).await);
        assert_eq!(started.elapsed(), END_SHELL_WAIT);
        let mut typed = 0;
        while rx.try_recv().is_ok() {
            typed += 1;
        }
        assert_eq!(typed, 7, "once at 0 ms and every 300 ms until 2 s");
    }

    #[tokio::test(start_paused = true)]
    async fn end_shell_waits_for_exit_when_stdin_is_gone() {
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        drop(rx);
        let exit = tokio::time::sleep(Duration::from_millis(500));
        assert!(end_shell(&tx, exit).await);
    }
}
