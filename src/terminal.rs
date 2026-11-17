//! Interactive sessions on the CLI: `nauvi attach`, `nauvi debug`
//! and `nauvi node-shell`. Connects the local terminal (raw mode, window
//! size) or plain pipes to an attached or exec'd process.

use crate::attach::{attach_note, attach_target, describe_attach_error};
use crate::debug::{add_debug_container, attach_container, describe_debug_error, EPHEMERAL_NOTE};
use crate::node_shell::{
    create_node_shell, delete_node_shell, describe_node_shell_error, exec_node_shell,
    new_node_shell_name,
};
use anyhow::{anyhow, Result};
use futures::SinkExt;
use kube::api::{AttachedProcess, TerminalSize};
use kube::Client;
use std::io::{IsTerminal, Read, Write};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Whether the session gets a TTY: only when stdin and stdout are terminals.
pub fn use_tty() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Puts the local terminal in raw mode while alive (Unix).
struct RawMode {
    #[cfg(unix)]
    saved: Option<libc::termios>,
}

impl RawMode {
    fn enable() -> Self {
        #[cfg(unix)]
        {
            // SAFETY: tcgetattr/tcsetattr only read and write the termios we
            // own, for the stdin file descriptor.
            unsafe {
                let mut t: libc::termios = std::mem::zeroed();
                if libc::tcgetattr(libc::STDIN_FILENO, &mut t) != 0 {
                    return RawMode { saved: None };
                }
                let saved = t;
                libc::cfmakeraw(&mut t);
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t);
                RawMode { saved: Some(saved) }
            }
        }
        #[cfg(not(unix))]
        RawMode {}
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(t) = self.saved {
            // SAFETY: restores the settings read in `enable`.
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t);
            }
        }
    }
}

fn local_size() -> Option<TerminalSize> {
    #[cfg(unix)]
    {
        // SAFETY: TIOCGWINSZ writes a winsize into the struct we pass.
        unsafe {
            let mut ws: libc::winsize = std::mem::zeroed();
            if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
                return Some(TerminalSize {
                    width: ws.ws_col,
                    height: ws.ws_row,
                });
            }
        }
    }
    None
}

/// Read stdin on a plain thread: tokio's stdin cannot be cancelled and would
/// keep the process alive after the session ends.
fn stdin_channel() -> tokio::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

/// Ctrl-P Ctrl-Q, like `docker attach` and `kubectl attach`.
const DETACH_KEYS: [u8; 2] = [0x10, 0x11];

/// Whether `bytes`, typed after `prev` (the last byte of the previous read),
/// complete the detach sequence. Pure.
pub fn detach_typed(prev: Option<u8>, bytes: &[u8]) -> bool {
    prev.into_iter()
        .chain(bytes.iter().copied())
        .collect::<Vec<_>>()
        .windows(2)
        .any(|w| w == DETACH_KEYS)
}

/// Connect the local terminal to `process` until it exits. With `detach`,
/// Ctrl-P Ctrl-Q ends the session and leaves the process running.
pub async fn run_attached(mut process: AttachedProcess, tty: bool, detach: bool) -> Result<()> {
    let _raw = tty.then(RawMode::enable);
    if let Some(mut tx) = process.terminal_size() {
        if let Some(size) = local_size() {
            let _ = tx.send(size).await;
        }
        #[cfg(unix)]
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let Ok(mut winch) = signal(SignalKind::window_change()) else {
                return;
            };
            while winch.recv().await.is_some() {
                if let Some(size) = local_size() {
                    if tx.send(size).await.is_err() {
                        break;
                    }
                }
            }
        });
    }
    let mut stdin_rx = stdin_channel();
    let stdin_writer = process.stdin();
    let stdout_reader = process.stdout();
    let stderr_reader = process.stderr();
    let stdin_pump = async move {
        if let Some(mut w) = stdin_writer {
            let mut prev = None;
            while let Some(bytes) = stdin_rx.recv().await {
                if detach && detach_typed(prev, &bytes) {
                    return true;
                }
                prev = bytes.last().copied();
                if w.write_all(&bytes).await.is_err() {
                    return false;
                }
            }
            // Stdin ended (piped input): let the remote shell see EOF.
            let _ = w.shutdown().await;
        }
        std::future::pending::<bool>().await
    };
    let stdout_pump = async move {
        if let Some(mut r) = stdout_reader {
            let mut buf = [0u8; 4096];
            while let Ok(n) = r.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(&buf[..n]);
                let _ = out.flush();
            }
        }
    };
    let stderr_pump = async move {
        if let Some(mut r) = stderr_reader {
            let mut buf = [0u8; 4096];
            while let Ok(n) = r.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let _ = std::io::stderr().write_all(&buf[..n]);
            }
        }
    };
    let status = process.take_status();
    let detached = tokio::select! {
        () = async { tokio::join!(stdout_pump, stderr_pump); } => false,
        d = stdin_pump => d,
    };
    drop(_raw);
    if detached {
        eprintln!("\r\nDetached; the process keeps running.");
        return Ok(());
    }
    if let Some(status) = status {
        if let Some(s) = status.await {
            // A non-zero exit of the shell is the user's business.
            let nonzero = s.reason.as_deref() == Some("NonZeroExitCode");
            if s.status.as_deref() == Some("Failure") && !nonzero {
                return Err(anyhow!(s
                    .message
                    .unwrap_or_else(|| "session failed".into())));
            }
        }
    }
    Ok(())
}

/// `nauvi debug <pod> [-c container] [--image]`.
pub async fn cli_debug(
    client: &Client,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
    image: &str,
) -> Result<()> {
    let tty = use_tty();
    eprintln!("{EPHEMERAL_NOTE}");
    let name = add_debug_container(
        client,
        namespace,
        pod,
        container.unwrap_or(""),
        image,
        tty,
        |reason| eprintln!("debug container: {reason}"),
    )
    .await
    .map_err(|e| anyhow!("pod/{namespace}/{pod}: {}", describe_debug_error(&e)))?;
    eprintln!(
        "Attached to {name} in pod/{namespace}/{pod}. If you don't see a prompt, press Enter."
    );
    let process = attach_container(client, namespace, pod, &name, tty)
        .await
        .map_err(|e| anyhow!("pod/{namespace}/{pod}: {}", describe_debug_error(&e)))?;
    run_attached(process, tty, false).await
}

/// `nauvi attach <pod> [-c container]`. A TTY is used when the container
/// has one and the local terminal is one too.
pub async fn cli_attach(
    client: &Client,
    namespace: &str,
    pod: &str,
    container: Option<&str>,
) -> Result<()> {
    let describe =
        |e: anyhow::Error| anyhow!("pod/{namespace}/{pod}: {}", describe_attach_error(&e));
    let p: kube::Api<k8s_openapi::api::core::v1::Pod> =
        kube::Api::namespaced(client.clone(), namespace);
    let found = p.get(pod).await.map_err(|e| describe(e.into()))?;
    let target = attach_target(&found, container).map_err(describe)?;
    let tty = target.tty && use_tty();
    let detach = if tty {
        "Press Ctrl-P Ctrl-Q to detach."
    } else {
        "Press Ctrl-P Ctrl-Q or Ctrl-C to detach."
    };
    eprintln!("{}", attach_note(pod, &target, detach));
    let process = attach_container(client, namespace, pod, &target.container, tty)
        .await
        .map_err(describe)?;
    let session = run_attached(process, tty, true);
    tokio::select! {
        r = session => r,
        () = interrupted() => Ok(()),
    }
}

/// `nauvi node-shell <node>`: the pod is deleted however the session ends
/// (exit, error, Ctrl-C, SIGTERM).
pub async fn cli_node_shell(
    client: &Client,
    node: &str,
    namespace: &str,
    image: &str,
) -> Result<()> {
    let tty = use_tty();
    let pod = new_node_shell_name(node);
    let describe =
        |e: anyhow::Error| anyhow!("node/{node}: {}", describe_node_shell_error(&e, namespace));
    let session = async {
        create_node_shell(client, node, namespace, &pod, image, |reason| {
            eprintln!("node shell pod: {reason}")
        })
        .await
        .map_err(describe)?;
        eprintln!("Shell on node/{node} (pod {namespace}/{pod}, deleted when the shell exits).");
        let process = exec_node_shell(client, namespace, &pod, tty)
            .await
            .map_err(describe)?;
        run_attached(process, tty, false).await
    };
    let result = tokio::select! {
        r = session => r,
        () = interrupted() => Err(anyhow!("interrupted")),
    };
    let deleted = delete_node_shell(client, namespace, &pod).await;
    result?;
    deleted
}

/// Ctrl-C (outside raw mode) or SIGTERM.
async fn interrupted() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return std::future::pending().await,
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::detach_typed;

    #[test]
    fn ctrl_p_ctrl_q_detaches_even_across_reads() {
        assert!(detach_typed(None, b"\x10\x11"));
        assert!(detach_typed(Some(b'a'), b"ls\x10\x11"));
        assert!(detach_typed(Some(0x10), b"\x11"));
        assert!(!detach_typed(None, b"\x10"));
        assert!(!detach_typed(Some(0x11), b"\x10"));
        assert!(!detach_typed(None, b"echo hi\r"));
    }
}
