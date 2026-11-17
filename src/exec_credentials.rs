//! Exec credential plugins (`users[].user.exec`), run by nauvi instead
//! of kube-client, with their credentials cached (#201).
//!
//! kube-client 2.0 runs the plugin each time it builds the auth parts of a
//! client: for the auth layer, for the TLS identity and for the client's
//! expiry, so about three times per client, and again for every new client.
//! With `aws eks get-token` that is a second or more each, and the catalog's
//! check and the window's session each built their own client.
//!
//! Here the plugin runs once per distinct exec config and the credential is
//! kept until 60 s before its `expirationTimestamp` (or [`NO_EXPIRY_TTL`]
//! without one). The client built by [`client_with_exec`] asks this cache
//! for the token on every request, so it refreshes like kube's own
//! refreshable token, and a check and a connect of the same context share
//! one run.

use base64::Engine as _;
use jiff::Timestamp;
use kube::client::{AuthError, Body, ClientBuilder};
use kube::config::{ExecConfig, ExecInteractiveMode};
use kube::{Client, Config};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// How long a credential without an `expirationTimestamp` is reused.
pub const NO_EXPIRY_TTL: Duration = Duration::from_secs(5 * 60);

/// A credential is refreshed this long before it expires, like kube does.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

/// How long a plugin may run before it is stopped, by default: long
/// enough for a login in the browser (`kubelogin`, `aws sso login`).
pub const DEFAULT_PLUGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The plugin timeout of `nauvi mcp`: nobody is there to log in.
pub const MCP_PLUGIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Overrides the timeout, in whole seconds (for tests of the real app).
pub const TIMEOUT_ENV: &str = "NAUVI_EXEC_TIMEOUT_SECS";

/// The timeout set by [`set_plugin_timeout`], in ms (0: not set).
static TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);

/// Set how long a plugin may run in this process (default:
/// [`DEFAULT_PLUGIN_TIMEOUT`]). [`TIMEOUT_ENV`] still wins.
pub fn set_plugin_timeout(timeout: Duration) {
    let ms = u64::try_from(timeout.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    TIMEOUT_MS.store(ms, Ordering::Relaxed);
}

/// How long a plugin may run: [`TIMEOUT_ENV`], else what
/// [`set_plugin_timeout`] set, else [`DEFAULT_PLUGIN_TIMEOUT`].
pub fn plugin_timeout() -> Duration {
    if let Some(secs) = std::env::var(TIMEOUT_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
    {
        return Duration::from_secs(secs);
    }
    match TIMEOUT_MS.load(Ordering::Relaxed) {
        0 => DEFAULT_PLUGIN_TIMEOUT,
        ms => Duration::from_millis(ms),
    }
}

/// A plugin ran longer than [`plugin_timeout`] and was killed. It reaches
/// callers inside `AuthError::AuthExecStart`, as an `io::Error` of kind
/// `TimedOut`; [`timed_out`] finds it.
#[derive(Debug)]
pub struct PluginTimedOut {
    pub after: Duration,
}

impl std::fmt::Display for PluginTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the credential plugin did not finish within {}, so nauvi stopped it",
            human_duration(self.after)
        )
    }
}

impl std::error::Error for PluginTimedOut {}

/// "45 s", "5 min", "1 min 30 s" (at least "1 s").
pub fn human_duration(d: Duration) -> String {
    let secs = d.as_secs().max(1);
    match (secs / 60, secs % 60) {
        (0, s) => format!("{s} s"),
        (m, 0) => format!("{m} min"),
        (m, s) => format!("{m} min {s} s"),
    }
}

/// The timeout in `err`, if its plugin was stopped for running too long.
pub fn timed_out(err: &AuthError) -> Option<&PluginTimedOut> {
    match err {
        AuthError::AuthExecStart(io) if io.kind() == std::io::ErrorKind::TimedOut => {
            io.get_ref()?.downcast_ref::<PluginTimedOut>()
        }
        _ => None,
    }
}

/// What an exec plugin returned.
#[derive(Clone, Debug)]
pub struct ExecCredential {
    /// A bearer token, if the plugin returned one.
    pub token: Option<String>,
    /// A client certificate and key (PEM), if the plugin returned them.
    pub certificate: Option<(String, String)>,
    /// When the plugin said it expires (`None`: it did not say).
    pub expires: Option<Timestamp>,
    /// When the cache stops using it.
    reuse_until: Timestamp,
}

type Slot = Arc<tokio::sync::Mutex<Option<ExecCredential>>>;

/// The cached credentials, by [`cache_key`]. Each has its own lock, so
/// concurrent requests for one plugin wait for a single run.
static CACHE: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(Default::default);

/// How many times a plugin was started in this process (for tests and logs).
static RUNS: AtomicU64 = AtomicU64::new(0);

/// How many exec plugins this process has started.
pub fn plugin_runs() -> u64 {
    RUNS.load(Ordering::Relaxed)
}

/// What identifies a plugin's credential: everything that changes what it
/// is asked or how it runs. Env entries are sorted (they are maps).
fn cache_key(exec: &ExecConfig) -> String {
    let mut env: Vec<(String, String)> = exec
        .env
        .iter()
        .flatten()
        .filter_map(|e| Some((e.get("name")?.clone(), e.get("value")?.clone())))
        .collect();
    env.sort();
    let cluster = exec
        .provide_cluster_info
        .then(|| exec.cluster.as_ref().map(|c| serde_json::to_string(c).ok()))
        .flatten()
        .flatten();
    serde_json::json!({
        "apiVersion": exec.api_version,
        "command": exec.command,
        "args": exec.args,
        "env": env,
        "interactive": format!("{:?}", exec.interactive_mode),
        "cluster": cluster,
    })
    .to_string()
}

fn slot(exec: &ExecConfig) -> Slot {
    CACHE
        .lock()
        .unwrap()
        .entry(cache_key(exec))
        .or_default()
        .clone()
}

/// The credential of `exec`: the cached one while it is valid, else a new
/// one from running the plugin. Failures are not cached.
pub async fn credential(exec: &ExecConfig) -> Result<ExecCredential, AuthError> {
    let slot = slot(exec);
    let mut cached = slot.lock().await;
    if let Some(c) = cached.as_ref() {
        if Timestamp::now() < c.reuse_until {
            return Ok(c.clone());
        }
    }
    let exec = exec.clone();
    let fresh = tokio::task::spawn_blocking(move || run_plugin(&exec))
        .await
        .map_err(|e| AuthError::AuthExec(format!("the credential plugin did not finish: {e}")))??;
    *cached = Some(fresh.clone());
    Ok(fresh)
}

/// Drop the cached credential of `exec`, so the next use runs the plugin
/// again (the cluster rejected it).
pub fn forget(exec: &ExecConfig) {
    CACHE.lock().unwrap().remove(&cache_key(exec));
}

#[derive(Deserialize)]
struct Output {
    status: Option<Status>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    expiration_timestamp: Option<String>,
    token: Option<String>,
    client_certificate_data: Option<String>,
    client_key_data: Option<String>,
}

/// Run the plugin the way kube-client does (same environment, stdin and
/// stderr handling, `KUBERNETES_EXEC_INFO`) and read its credential.
fn run_plugin(exec: &ExecConfig) -> Result<ExecCredential, AuthError> {
    run_plugin_within(exec, plugin_timeout())
}

/// [`run_plugin`], killed after `timeout`.
fn run_plugin_within(exec: &ExecConfig, timeout: Duration) -> Result<ExecCredential, AuthError> {
    let Some(command) = &exec.command else {
        return Err(AuthError::MissingCommand);
    };
    let mut cmd = std::process::Command::new(command);
    cmd.args(exec.args.iter().flatten());
    for e in exec.env.iter().flatten() {
        if let (Some(name), Some(value)) = (e.get("name"), e.get("value")) {
            cmd.env(name, value);
        }
    }
    let interactive = exec.interactive_mode != Some(ExecInteractiveMode::Never);
    if interactive {
        cmd.stdin(std::process::Stdio::inherit());
        cmd.stderr(std::process::Stdio::inherit());
    } else {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut spec = serde_json::json!({ "interactive": interactive });
    if exec.provide_cluster_info {
        let cluster = exec
            .cluster
            .as_ref()
            .ok_or(AuthError::ExecMissingClusterInfo)?;
        spec["cluster"] = serde_json::to_value(cluster).map_err(AuthError::AuthExecSerialize)?;
    }
    let info = serde_json::json!({
        "apiVersion": exec.api_version,
        "kind": "ExecCredential",
        "spec": spec,
    });
    cmd.env("KUBERNETES_EXEC_INFO", info.to_string());
    for name in exec.drop_env.iter().flatten() {
        cmd.env_remove(name);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    RUNS.fetch_add(1, Ordering::Relaxed);
    let out = output_within(&mut cmd, interactive, timeout)?;
    if !out.status.success() {
        // kube's text for this error prints `out` with `{:?}`, and many
        // callers print errors with `{e}`: the error itself never holds the
        // stdout (it may be a credential) or more stderr than a message shows.
        let out = std::process::Output {
            status: out.status,
            stdout: Vec::new(),
            stderr: crate::auth::stderr_tail(&out.stderr).into_bytes(),
        };
        return Err(AuthError::AuthExecRun {
            // Program and args only: `{cmd:?}` would include the env.
            cmd: std::iter::once(cmd.get_program())
                .chain(cmd.get_args())
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            out: Box::new(out),
        });
    }
    // JSON, as before kube 5 (which parses YAML too). The error keeps
    // serde_json's text only, never a snippet of the output: it may hold
    // the credential.
    let parsed: Output = serde_json::from_slice(&out.stdout)
        .map_err(|e| AuthError::AuthExecParse(Box::new(serde::de::Error::custom(e))))?;
    let status = parsed.status.ok_or(AuthError::ExecPluginFailed)?;
    let expires = status
        .expiration_timestamp
        .map(|ts| ts.parse::<Timestamp>())
        .transpose()
        .map_err(AuthError::MalformedTokenExpirationDate)?;
    let now = Timestamp::now();
    let reuse_until = match expires {
        Some(at) => at - EXPIRY_MARGIN,
        None => now + NO_EXPIRY_TTL,
    };
    let certificate = match (status.client_certificate_data, status.client_key_data) {
        (Some(cert), Some(key)) => Some((cert, key)),
        _ => None,
    };
    Ok(ExecCredential {
        token: status.token,
        certificate,
        expires,
        reuse_until,
    })
}

/// `cmd.output()`, except that the child is killed once it has run for
/// `timeout`.
///
/// What is killed is the plugin with what it started (a wrapper script's
/// `sleep`, `aws` under a shell): on Unix its process group, which a
/// non-interactive plugin gets of its own (an interactive one stays in the
/// terminal's group, so it can read the terminal: there only the plugin is
/// killed); on Windows its process tree (`taskkill /T`).
///
/// stdout (and stderr, unless `interactive` inherits it) is read on its
/// own thread, so a chatty plugin cannot block on a full pipe. After a
/// kill the readers are never waited for, so a process that escaped the
/// kill and still holds a pipe cannot block the caller.
fn output_within(
    cmd: &mut std::process::Command,
    interactive: bool,
    timeout: Duration,
) -> Result<std::process::Output, AuthError> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Instant;
    cmd.stdout(Stdio::piped());
    if !interactive {
        cmd.stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
    }
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(AuthError::AuthExecStart)?;
    // A piped stdin is closed at once: the plugin reads an empty input.
    drop(child.stdin.take());
    fn reader(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel();
        match pipe {
            Some(mut pipe) => {
                std::thread::spawn(move || {
                    let mut buf = Vec::new();
                    let _ = pipe.read_to_end(&mut buf);
                    let _ = tx.send(buf);
                });
            }
            None => {
                let _ = tx.send(Vec::new());
            }
        }
        rx
    }
    let stdout = reader(child.stdout.take());
    let stderr = reader(child.stderr.take());
    let deadline = started + timeout;
    let status = loop {
        match child.try_wait().map_err(AuthError::AuthExecStart)? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                kill_tree(&mut child, interactive);
                let _ = child.wait();
                tracing::warn!(
                    timeout_secs = timeout.as_secs(),
                    "the credential plugin did not finish in time; stopped it"
                );
                return Err(AuthError::AuthExecStart(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    PluginTimedOut { after: timeout },
                )));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    // It exited: its pipes close unless a grandchild still holds them, so
    // the rest of the output is waited for only briefly.
    let collect =
        |rx: mpsc::Receiver<Vec<u8>>| rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout: collect(stdout),
        stderr: collect(stderr),
    })
}

/// Kill a plugin that ran too long, with the processes it started (see
/// [`output_within`]).
fn kill_tree(child: &mut std::process::Child, interactive: bool) {
    #[cfg(unix)]
    if !interactive {
        if let Ok(pgid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: plain syscall; the group is the child's own (it was
            // started with `process_group(0)` and is not reaped yet).
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = interactive;
        // By its full path: a `taskkill` earlier on PATH must not run.
        let root = std::env::var_os("SystemRoot")
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| r"C:\Windows".into());
        let taskkill = std::path::Path::new(&root)
            .join("System32")
            .join("taskkill.exe");
        let _ = std::process::Command::new(taskkill)
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = interactive;
    // The plugin itself, in every case (and if the above failed).
    let _ = child.kill();
}

/// Whether kube-client would log in with the exec plugin: it has one, and
/// no auth provider, basic auth, token or token file comes first.
pub fn logs_in_with_exec(config: &Config) -> bool {
    let a = &config.auth_info;
    a.exec.is_some()
        && a.auth_provider.is_none()
        && !(a.username.is_some() && a.password.is_some())
        && a.token.is_none()
        && a.token_file.is_none()
}

/// Build a client for a config that logs in with an exec plugin (see
/// [`logs_in_with_exec`]), running the plugin through the cache.
///
/// A token is added to each request by a layer that asks the cache, so it
/// is refreshed when it expires. A client certificate is part of the TLS
/// setup and cannot be swapped later: the client's `valid_until` is set to
/// its expiry, as kube does.
pub async fn client_with_exec(mut config: Config) -> Result<Client, kube::Error> {
    let Some(exec) = config.auth_info.exec.take() else {
        return Client::try_from(config);
    };
    let cred = credential(&exec).await.map_err(kube::Error::Auth)?;
    if let Some((cert, key)) = &cred.certificate {
        let b64 = base64::engine::general_purpose::STANDARD;
        config.auth_info.client_certificate_data = Some(b64.encode(cert));
        config.auth_info.client_key_data = Some(b64.encode(key).into());
        config.auth_info.client_certificate = None;
        config.auth_info.client_key = None;
        return Ok(ClientBuilder::try_from(config)?
            .with_valid_until(cred.expires)
            .build());
    }
    let exec = Arc::new(exec);
    let add_token = tower::filter::AsyncFilterLayer::new(move |mut req: http::Request<Body>| {
        let exec = exec.clone();
        async move {
            let cred = credential(&exec).await?;
            if let Some(token) = cred.token {
                let mut value = http::HeaderValue::try_from(format!("Bearer {token}"))
                    .map_err(AuthError::InvalidBearerToken)?;
                value.set_sensitive(true);
                req.headers_mut().insert(http::header::AUTHORIZATION, value);
            }
            Ok::<_, AuthError>(req)
        }
    });
    // The filter needs a service it can clone: a buffer in front of the
    // stack (kube puts one around the whole client too).
    Ok(ClientBuilder::try_from(config)?
        .with_layer(&tower::buffer::BufferLayer::new(1024))
        .with_layer(&add_token)
        .build())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// A stand-in plugin that appends a line to `count` each time it runs
    /// and prints a credential with the given expiry (`""`: none).
    fn plugin(dir: &Path, expires: &str) -> (PathBuf, PathBuf) {
        let script = dir.join("plugin.sh");
        let count = dir.join("runs");
        let ts = if expires.is_empty() {
            String::new()
        } else {
            format!(r#","expirationTimestamp":"{expires}""#)
        };
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho run >> '{}'\necho '{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"t-'$KL_TAG'\"{ts}}}}}'\n",
                count.display()
            ),
        )
        .unwrap();
        (script, count)
    }

    /// Runs `script` as `/bin/sh <script>`, never by executing the file
    /// itself: tests write scripts while other test threads fork, and a
    /// forked child still holding the write fd makes `execve` of that file
    /// fail with ETXTBSY (#343). `sh` only reads it.
    fn exec_for(script: &Path, tag: &str) -> ExecConfig {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "command": "/bin/sh",
            "args": [script],
            "env": [{"name": "KL_TAG", "value": tag}],
            "interactiveMode": "Never",
        }))
        .unwrap()
    }

    fn runs(count: &Path) -> usize {
        std::fs::read_to_string(count)
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nauvi-201-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_credential_is_reused_until_it_expires() {
        let dir = temp_dir("reuse");
        let later = (Timestamp::now() + jiff::SignedDuration::from_mins(15)).to_string();
        let (script, count) = plugin(&dir, &later);
        let exec = exec_for(&script, "a");
        let first = credential(&exec).await.unwrap();
        assert_eq!(first.token.as_deref(), Some("t-a"));
        assert!(first.expires.is_some());
        // Concurrent and later requests share the one run.
        let (b, c) = tokio::join!(credential(&exec), credential(&exec));
        assert_eq!(b.unwrap().token, first.token);
        assert_eq!(c.unwrap().token, first.token);
        assert_eq!(runs(&count), 1);

        // Another env is another credential.
        let other = credential(&exec_for(&script, "b")).await.unwrap();
        assert_eq!(other.token.as_deref(), Some("t-b"));
        assert_eq!(runs(&count), 2);

        // Forgotten (rejected by the cluster): the next use runs it again.
        forget(&exec);
        credential(&exec).await.unwrap();
        assert_eq!(runs(&count), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_expiring_credential_is_refreshed() {
        let dir = temp_dir("expiring");
        // Within the 60 s margin: never reused.
        let soon = (Timestamp::now() + jiff::SignedDuration::from_secs(30)).to_string();
        let (script, count) = plugin(&dir, &soon);
        let exec = exec_for(&script, "soon");
        credential(&exec).await.unwrap();
        credential(&exec).await.unwrap();
        assert_eq!(runs(&count), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn without_expiry_it_is_kept_for_the_ttl() {
        let dir = temp_dir("noexpiry");
        let (script, count) = plugin(&dir, "");
        let exec = exec_for(&script, "ttl");
        let c = credential(&exec).await.unwrap();
        assert!(c.expires.is_none());
        assert!(
            c.reuse_until > Timestamp::now() + NO_EXPIRY_TTL - jiff::SignedDuration::from_secs(5)
        );
        credential(&exec).await.unwrap();
        assert_eq!(runs(&count), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn failures_are_not_cached_and_keep_kube_errors() {
        let dir = temp_dir("fail");
        let script = dir.join("fail.sh");
        let count = dir.join("runs");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho run >> '{}'\necho '{{\"token\":\"s3cret-stdout\"}}'\necho 'Run aws sso login' >&2\nexit 255\n",
                count.display()
            ),
        )
        .unwrap();
        let exec = exec_for(&script, "fail-s3cret-env");
        let err = credential(&exec).await.unwrap_err();
        assert!(matches!(err, AuthError::AuthExecRun { .. }), "{err:?}");
        if let AuthError::AuthExecRun { out, cmd, .. } = &err {
            assert_eq!(
                String::from_utf8_lossy(&out.stderr).trim(),
                "Run aws sso login"
            );
            assert_eq!(cmd, &format!("/bin/sh {}", script.display()));
        }
        // Neither the env value nor the plugin's stdout reaches a message.
        let wrapped = kube::Error::Auth(err);
        let text = crate::errors::chain_text(&wrapped);
        assert!(!text.contains("s3cret"), "{text}");
        assert!(text.ends_with("exit code 255: Run aws sso login"), "{text}");
        credential(&exec).await.unwrap_err();
        assert_eq!(runs(&count), 2);

        let missing: ExecConfig = serde_json::from_value(serde_json::json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "command": dir.join("nope"),
            "interactiveMode": "Never",
        }))
        .unwrap();
        let err = credential(&missing).await.unwrap_err();
        assert!(
            matches!(err, AuthError::AuthExecStart(ref io) if io.kind() == std::io::ErrorKind::NotFound)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A refresh that fails mid-session: the auth layer's error reaches
    /// callers as `kube::Error::Service`, which many print with `{e}`.
    #[tokio::test]
    async fn a_failed_refresh_keeps_env_and_stdout_out_of_every_text() {
        let dir = temp_dir("refresh");
        let (script, _) = plugin(&dir, "");
        let exec = exec_for(&script, "refresh-s3cret-env");
        let mut config = Config::new("http://127.0.0.1:9".parse().unwrap());
        config.auth_info.exec = Some(exec.clone());
        let client = client_with_exec(config).await.unwrap();

        std::fs::write(
            &script,
            "#!/bin/sh\necho '{\"token\":\"s3cret-stdout\"}'\nprintf 'Run qa login\\033[31m\\n' >&2\nexit 3\n",
        )
        .unwrap();
        forget(&exec);
        let err = client.apiserver_version().await.unwrap_err();
        assert!(matches!(err, kube::Error::Service(_)), "{err:?}");
        for text in [
            err.to_string(),
            format!("{err:?}"),
            crate::errors::chain_text(&err),
        ] {
            assert!(!text.contains("s3cret"), "{text}");
            assert!(!text.contains('\u{1b}'), "{text}");
        }
        let chain = crate::errors::chain_text(&err);
        assert!(
            chain.ends_with(
                "the credential plugin exited with exit code 3: Run qa login\\u{1b}[31m"
            ),
            "{chain}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A plugin that waits (for a browser login, say) is killed at the
    /// timeout, even when a grandchild holds its stdout open.
    #[test]
    fn a_slow_plugin_is_killed_at_the_timeout() {
        let dir = temp_dir("slow");
        let script = dir.join("slow.sh");
        let pid_file = dir.join("pid");
        let child_file = dir.join("grandchild");
        // A wrapper whose grandchild (`sleep`) holds stdout and stderr.
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho $$ > '{}'\necho 'Waiting for the browser login' >&2\nsleep 30 &\necho $! > '{}'\nwait\necho '{{}}'\n",
                pid_file.display(),
                child_file.display()
            ),
        )
        .unwrap();
        let exec = exec_for(&script, "slow");
        let started = std::time::Instant::now();
        let err = run_plugin_within(&exec, Duration::from_millis(700)).unwrap_err();
        let took = started.elapsed();
        assert!(took < Duration::from_secs(5), "returned after {took:?}");
        let t = timed_out(&err).expect("a timeout");
        assert_eq!(t.after, Duration::from_millis(700));
        assert_eq!(
            err_text(&err),
            "the credential plugin did not finish within 1 s, so nauvi stopped it"
        );
        // The plugin and its grandchild are gone. The grandchild is reaped
        // by init once its parent is killed: give that a moment.
        let read_pid =
            |p: &Path| -> i32 { std::fs::read_to_string(p).unwrap().trim().parse().unwrap() };
        for pid in [read_pid(&pid_file), read_pid(&child_file)] {
            // SAFETY: signal 0 only checks that the process exists.
            let alive = || unsafe { libc::kill(pid, 0) } == 0;
            let until = std::time::Instant::now() + Duration::from_secs(3);
            while alive() && std::time::Instant::now() < until {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!alive(), "process {pid} still runs");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn err_text(err: &AuthError) -> String {
        crate::errors::chain_text(err)
    }

    #[test]
    fn a_fast_plugin_finishes_within_the_timeout() {
        let dir = temp_dir("fast");
        let (script, _) = plugin(&dir, "");
        let c = run_plugin_within(&exec_for(&script, "fast"), Duration::from_secs(10)).unwrap();
        assert_eq!(c.token.as_deref(), Some("t-fast"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn durations_read_plainly() {
        assert_eq!(human_duration(Duration::from_millis(300)), "1 s");
        assert_eq!(human_duration(Duration::from_secs(45)), "45 s");
        assert_eq!(human_duration(Duration::from_secs(300)), "5 min");
        assert_eq!(human_duration(Duration::from_secs(90)), "1 min 30 s");
    }

    #[test]
    fn env_order_does_not_change_the_key() {
        let a: ExecConfig = serde_json::from_value(serde_json::json!({
            "command": "aws", "env": [{"name": "A", "value": "1"}, {"name": "B", "value": "2"}],
        }))
        .unwrap();
        let b: ExecConfig = serde_json::from_value(serde_json::json!({
            "command": "aws", "env": [{"value": "2", "name": "B"}, {"name": "A", "value": "1"}],
        }))
        .unwrap();
        assert_eq!(cache_key(&a), cache_key(&b));
        let c: ExecConfig =
            serde_json::from_value(serde_json::json!({"command": "aws", "args": ["x"]})).unwrap();
        assert_ne!(cache_key(&a), cache_key(&c));
    }
}
