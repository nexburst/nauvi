//! Readable messages for the ways connecting to a cluster fails: an exec
//! credential plugin that is missing, exits with an error or wants an
//! interactive login, rejected credentials, and certificate problems.
//!
//! The desktop app picks the status text by the prefix of these messages
//! (see `ui-src/src/lib/clusterError.ts`), so keep [`LOGIN_FAILED`],
//! [`CERTIFICATE_PROBLEM`], [`UNREACHABLE`] and [`NO_KUBECONFIG`] in sync
//! with it.

use kube::client::AuthError;
use kube::config::{ExecConfig, ExecInteractiveMode};
use std::error::Error as StdError;
use std::process::ExitStatus;

/// Start of every message about a failed login.
pub const LOGIN_FAILED: &str = "Login to `";
/// Start of every message about a TLS / certificate failure.
pub const CERTIFICATE_PROBLEM: &str = "Certificate problem";
/// Start of every message about a cluster that could not be reached.
pub const UNREACHABLE: &str = "Cannot reach the cluster";
/// Start of the message for a machine with no kubeconfig at all.
pub const NO_KUBECONFIG: &str = "No kubeconfig found";

/// What a message is about: the context, its API server and the exec
/// plugin it logs in with.
#[derive(Debug, Clone, Default)]
pub struct AuthTarget {
    pub context: String,
    pub server: String,
    /// The exec plugin's `command`, if the user logs in with one.
    pub exec_command: Option<String>,
    /// The `PATH` the plugin's own `env` sets, if any; the command is looked
    /// up there instead of in ours.
    pub exec_path: Option<String>,
}

impl AuthTarget {
    fn command(&self) -> &str {
        self.exec_command.as_deref().unwrap_or("credential plugin")
    }
}

/// Make an exec plugin fit a process that can't prompt (`interactive` is
/// false: the desktop app, or a CLI without a terminal), like kubectl does.
///
/// A plugin that always needs a prompt is refused with a readable message.
/// Otherwise it is told it is not interactive, which also makes kube capture
/// its stderr (where hints like `aws sso login` appear) instead of passing
/// it through to ours.
pub fn prepare_exec(
    exec: &mut ExecConfig,
    interactive: bool,
    target: &AuthTarget,
) -> Result<(), String> {
    if interactive {
        return Ok(());
    }
    if exec.interactive_mode == Some(ExecInteractiveMode::Always) {
        return Err(interactive_message(target));
    }
    exec.interactive_mode = Some(ExecInteractiveMode::Never);
    Ok(())
}

fn interactive_message(target: &AuthTarget) -> String {
    format!(
        "{LOGIN_FAILED}{ctx}` failed: `{cmd}` needs an interactive login (interactiveMode: Always), \
         which nauvi can't show. Log in from a terminal first, for example with \
         `kubectl --context {ctx} get namespaces`, then retry.",
        ctx = target.context,
        cmd = target.command(),
    )
}

/// The readable message for an error from building a client or from its
/// first request. Errors that are none of the cases above are reported as
/// an unreachable cluster, with the full error chain.
pub fn describe_client_error(err: &(dyn StdError + 'static), target: &AuthTarget) -> String {
    let ctx = &target.context;
    if let Some(auth) = find::<AuthError>(err) {
        return describe_auth_error(auth, target);
    }
    if let Some(kube::Error::Api(resp)) = find::<kube::Error>(err) {
        if resp.code == 401 {
            let hint = match &target.exec_command {
                Some(cmd) => format!(" Check that `{cmd}` still has a valid login session."),
                None => String::new(),
            };
            return format!(
                "{LOGIN_FAILED}{ctx}` failed: the cluster rejected the credentials (expired token?).{hint}"
            );
        }
    }
    let chain = error_chain(err);
    // The proxy's certificate (#362), not the cluster's: checked against the
    // system's trust store and the proxy's CA file.
    if chain.contains(crate::proxy_tls::PROXY_TLS_FAILED) {
        return format!(
            "{CERTIFICATE_PROBLEM} with the proxy of `{ctx}`: {chain}. An https:// proxy's \
             certificate must be trusted by the system or signed by the CA file set with the \
             proxy; the cluster's certificate-authority and insecure-skip-tls-verify are not \
             used for it."
        );
    }
    if is_tls_error(&chain) {
        return format!(
            "{CERTIFICATE_PROBLEM} connecting to `{ctx}` ({}): {chain}. Check the cluster's \
             certificate-authority data in the kubeconfig.",
            target.server
        );
    }
    format!("{UNREACHABLE} for `{ctx}` ({}): {chain}", target.server)
}

fn describe_auth_error(err: &AuthError, target: &AuthTarget) -> String {
    let ctx = &target.context;
    let cmd = target.command();
    if let Some(t) = crate::exec_credentials::timed_out(err) {
        return timed_out_message(cmd, ctx, t.after);
    }
    match err {
        AuthError::AuthExecStart(io) if io.kind() == std::io::ErrorKind::NotFound => {
            let path = match &target.exec_path {
                Some(path) => path.clone(),
                None => std::env::var("PATH").unwrap_or_default(),
            };
            not_found_message(cmd, ctx, &path)
        }
        AuthError::AuthExecRun { out, .. } => {
            exec_failed_message(cmd, ctx, out.status, &out.stderr)
        }
        AuthError::AuthExecStart(io) => {
            format!("{LOGIN_FAILED}{ctx}` failed: could not run `{cmd}`: {io}")
        }
        AuthError::AuthExecParse(_) | AuthError::ExecPluginFailed => format!(
            "{LOGIN_FAILED}{ctx}` failed: `{cmd}` returned something that is not a valid \
             ExecCredential: {}",
            error_chain(err)
        ),
        _ => format!("{LOGIN_FAILED}{ctx}` failed: {}", error_chain(err)),
    }
}

/// The message for an exec plugin that is not on `PATH`.
pub fn not_found_message(cmd: &str, ctx: &str, path: &str) -> String {
    let searched = if path.is_empty() {
        "(empty)".to_string()
    } else {
        std::env::split_paths(path)
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "{LOGIN_FAILED}{ctx}` failed: the `{cmd}` command it logs in with was not found. \
         Searched PATH: {searched}. Install it, or start nauvi from a terminal."
    )
}

/// The message for an exec plugin that exited with an error, with its stderr.
pub fn exec_failed_message(cmd: &str, ctx: &str, status: ExitStatus, stderr: &[u8]) -> String {
    format!(
        "{LOGIN_FAILED}{ctx}` failed: {}",
        exec_exit_text(&format!("`{cmd}`"), status, stderr)
    )
}

/// The message for an exec plugin that was stopped after `after`. It names
/// the program without its folder, so the catalog row's two lines show the
/// reason (the prompt showed the full command).
pub fn timed_out_message(cmd: &str, ctx: &str, after: std::time::Duration) -> String {
    let cmd = std::path::Path::new(cmd)
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or(cmd.into());
    format!(
        "{LOGIN_FAILED}{ctx}` failed: `{cmd}` did not finish within {}, so nauvi stopped it. \
         If it waits for a login in the browser, finish the login and try again.",
        crate::exec_credentials::human_duration(after)
    )
}

/// What a plugin that exited with an error (or was stopped for running too
/// long) said, for error chains that don't know the context (a token
/// refresh during a watch): its exit code and stderr, never its
/// environment or stdout.
pub fn exec_run_text(err: &AuthError) -> Option<String> {
    if let Some(t) = crate::exec_credentials::timed_out(err) {
        return Some(t.to_string());
    }
    match err {
        AuthError::AuthExecRun { out, .. } => Some(exec_exit_text(
            "the credential plugin",
            out.status,
            &out.stderr,
        )),
        _ => None,
    }
}

/// "`who` exited with exit code N: stderr".
///
/// kube's own text for this error prints the command with `{:?}`, which on
/// Unix includes the environment it set (tokens from the kubeconfig's
/// `env`), and the plugin's stdout (possibly a credential): neither may
/// reach a message.
fn exec_exit_text(who: &str, status: ExitStatus, stderr: &[u8]) -> String {
    let stderr = stderr_tail(stderr);
    let output = if stderr.is_empty() {
        "it printed no error message".to_string()
    } else {
        stderr
    };
    let status = match status.code() {
        Some(code) => format!("exit code {code}"),
        None => status.to_string(),
    };
    format!("{who} exited with {status}: {output}")
}

/// How much of a plugin's stderr a message keeps: its last lines...
const STDERR_LINES: usize = 10;
/// ...and at most this many bytes of them.
const STDERR_BYTES: usize = 1024;

/// The end of a plugin's stderr for a message: trimmed, its last
/// [`STDERR_LINES`] lines and [`STDERR_BYTES`] bytes ("…" first when cut),
/// with control, bidi and other invisible characters (ANSI escapes
/// included) written as `\u{..}`, so they can't restyle a terminal or
/// reorder the text. Newlines are kept. Running it again changes nothing.
pub fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.trim().lines().collect();
    let mut cut = lines.len() > STDERR_LINES;
    let kept = lines[lines.len().saturating_sub(STDERR_LINES)..].join("\n");
    let mut start = kept.len().saturating_sub(STDERR_BYTES);
    while !kept.is_char_boundary(start) {
        start += 1;
    }
    cut |= start > 0;
    let mut out = String::new();
    if cut {
        out.push('…');
    }
    for c in kept[start..].chars() {
        if c != '\n' && crate::catalog::is_invisible(c) {
            out.push_str(&format!("\\u{{{:x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// The first error in the chain of type `T`.
fn find<'a, T: StdError + 'static>(err: &'a (dyn StdError + 'static)) -> Option<&'a T> {
    let mut cur: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = cur {
        if let Some(t) = e.downcast_ref::<T>() {
            return Some(t);
        }
        cur = e.source();
    }
    None
}

/// The error and its sources, each part once (see [`crate::errors`]).
fn error_chain(err: &(dyn StdError + 'static)) -> String {
    crate::errors::chain_text(err)
}

fn is_tls_error(chain: &str) -> bool {
    let lower = chain.to_lowercase();
    ["certificate", "x509", "tls handshake", "unknownissuer"]
        .iter()
        .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    fn target() -> AuthTarget {
        AuthTarget {
            context: "prod".into(),
            server: "https://k.example".into(),
            exec_command: Some("aws".into()),
            exec_path: None,
        }
    }

    #[test]
    fn not_found_lists_path() {
        let path = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let msg = not_found_message("aws", "prod", path.to_str().unwrap());
        assert!(msg.starts_with(LOGIN_FAILED), "{msg}");
        assert!(msg.contains("`aws`"), "{msg}");
        assert!(msg.contains("`prod`"), "{msg}");
        assert!(msg.contains("Searched PATH: /usr/bin, /bin."), "{msg}");
    }

    #[cfg(unix)]
    #[test]
    fn exec_failure_includes_stderr() {
        let msg = exec_failed_message(
            "aws",
            "prod",
            exit_status(255),
            b"\nError: SSO session expired. Run aws sso login\n",
        );
        assert!(msg.starts_with(LOGIN_FAILED), "{msg}");
        assert!(msg.contains("exit code 255"), "{msg}");
        assert!(msg.ends_with("Run aws sso login"), "{msg}");
        let empty = exec_failed_message("aws", "prod", exit_status(1), b"  ");
        assert!(empty.contains("no error message"), "{empty}");
    }

    #[test]
    fn stderr_is_cut_to_its_end_and_escaped() {
        let many: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        assert_eq!(
            stderr_tail(many.as_bytes()),
            format!(
                "…{}",
                (21..=30)
                    .map(|i| format!("line {i}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        );
        let long = "x".repeat(5000) + "é end";
        let t = stderr_tail(long.as_bytes());
        assert!(t.starts_with('…') && t.ends_with("é end"), "{t}");
        assert!(t.len() <= STDERR_BYTES + '…'.len_utf8(), "{}", t.len());
        let nasty = "\u{1b}[31mred\u{1b}[0m \u{202e}evil\rx\nok";
        let t = stderr_tail(nasty.as_bytes());
        assert_eq!(t, "\\u{1b}[31mred\\u{1b}[0m \\u{202e}evil\\u{d}x\nok");
        assert_eq!(stderr_tail(t.as_bytes()), t, "idempotent");
        assert_eq!(stderr_tail(b"  \n "), "");
    }

    #[test]
    fn interactive_plugins() {
        let mut exec: ExecConfig = serde_json::from_value(serde_json::json!({
            "command": "kubelogin",
            "interactiveMode": "Always",
        }))
        .unwrap();
        // A terminal can prompt: left alone.
        assert!(prepare_exec(&mut exec, true, &target()).is_ok());
        assert_eq!(exec.interactive_mode, Some(ExecInteractiveMode::Always));
        // Without one, refused.
        let err = prepare_exec(&mut exec, false, &target()).unwrap_err();
        assert!(err.contains("interactive login"), "{err}");

        // IfAvailable (and unset) become Never so stderr is captured.
        exec.interactive_mode = Some(ExecInteractiveMode::IfAvailable);
        prepare_exec(&mut exec, false, &target()).unwrap();
        assert_eq!(exec.interactive_mode, Some(ExecInteractiveMode::Never));
        exec.interactive_mode = None;
        prepare_exec(&mut exec, false, &target()).unwrap();
        assert_eq!(exec.interactive_mode, Some(ExecInteractiveMode::Never));
    }

    #[test]
    fn classifies_kube_errors() {
        let not_found = kube::Error::Auth(AuthError::AuthExecStart(std::io::Error::from(
            std::io::ErrorKind::NotFound,
        )));
        let msg = describe_client_error(&not_found, &target());
        assert!(msg.contains("was not found"), "{msg}");

        let timed_out = kube::Error::Auth(AuthError::AuthExecStart(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            crate::exec_credentials::PluginTimedOut {
                after: std::time::Duration::from_secs(60),
            },
        )));
        let msg = describe_client_error(&timed_out, &target());
        assert_eq!(
            msg,
            "Login to `prod` failed: `aws` did not finish within 1 min, so nauvi stopped it. \
             If it waits for a login in the browser, finish the login and try again."
        );
        assert!(
            timed_out_message("/opt/bin/kubelogin", "x", std::time::Duration::from_secs(6))
                .contains(": `kubelogin` did not finish within 6 s")
        );

        let unauthorized = kube::Error::Api(
            serde_json::from_value(serde_json::json!({
                "status": "Failure", "message": "Unauthorized", "reason": "Unauthorized", "code": 401
            }))
            .unwrap(),
        );
        let msg = describe_client_error(&unauthorized, &target());
        assert!(msg.starts_with(LOGIN_FAILED), "{msg}");
        assert!(msg.contains("rejected the credentials"), "{msg}");

        // Wrapped in anyhow, as the rest of the crate returns them.
        let wrapped = anyhow::Error::new(unauthorized);
        let msg = describe_client_error(wrapped.as_ref(), &target());
        assert!(msg.contains("rejected the credentials"), "{msg}");

        let tls = anyhow::anyhow!("invalid peer certificate: UnknownIssuer");
        let msg = describe_client_error(tls.as_ref(), &target());
        assert!(msg.starts_with(CERTIFICATE_PROBLEM), "{msg}");
        assert!(msg.contains("certificate-authority data"), "{msg}");

        // The proxy's certificate: not the cluster's CA to check.
        let proxy = anyhow::anyhow!(
            "{}: invalid peer certificate: UnknownIssuer",
            crate::proxy_tls::PROXY_TLS_FAILED
        );
        let msg = describe_client_error(proxy.as_ref(), &target());
        assert!(msg.starts_with(CERTIFICATE_PROBLEM), "{msg}");
        assert!(msg.contains("with the proxy of `"), "{msg}");
        assert!(msg.contains("CA file set with the proxy"), "{msg}");

        let refused = anyhow::anyhow!("tcp connect error: Connection refused");
        let msg = describe_client_error(refused.as_ref(), &target());
        assert!(msg.starts_with(UNREACHABLE), "{msg}");
        assert!(msg.contains("https://k.example"), "{msg}");
    }

    #[test]
    fn chain_skips_repeats() {
        let err = anyhow::anyhow!("inner failure").context("outer: inner failure");
        assert_eq!(error_chain(err.as_ref()), "outer: inner failure");
        let err = anyhow::anyhow!("inner").context("outer");
        assert_eq!(error_chain(err.as_ref()), "outer: inner");
    }
}
