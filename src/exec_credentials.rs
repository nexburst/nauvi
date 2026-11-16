//! Exec credential plugins (`users[].user.exec`), run by kubeloupe instead
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
use chrono::{DateTime, Utc};
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

/// What an exec plugin returned.
#[derive(Clone, Debug)]
pub struct ExecCredential {
    /// A bearer token, if the plugin returned one.
    pub token: Option<String>,
    /// A client certificate and key (PEM), if the plugin returned them.
    pub certificate: Option<(String, String)>,
    /// When the plugin said it expires (`None`: it did not say).
    pub expires: Option<DateTime<Utc>>,
    /// When the cache stops using it.
    reuse_until: DateTime<Utc>,
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
        if Utc::now() < c.reuse_until {
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
    let out = cmd.output().map_err(AuthError::AuthExecStart)?;
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
            status: out.status,
            out,
        });
    }
    let parsed: Output = serde_json::from_slice(&out.stdout).map_err(AuthError::AuthExecParse)?;
    let status = parsed.status.ok_or(AuthError::ExecPluginFailed)?;
    let expires = status
        .expiration_timestamp
        .map(|ts| ts.parse::<DateTime<Utc>>())
        .transpose()
        .map_err(AuthError::MalformedTokenExpirationDate)?;
    let now = Utc::now();
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
    use std::os::unix::fs::PermissionsExt;
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
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, count)
    }

    fn exec_for(script: &Path, tag: &str) -> ExecConfig {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "client.authentication.k8s.io/v1",
            "command": script,
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
        let dir = std::env::temp_dir().join(format!("kubeloupe-201-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_credential_is_reused_until_it_expires() {
        let dir = temp_dir("reuse");
        let later = (Utc::now() + chrono::Duration::minutes(15)).to_rfc3339();
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
        let soon = (Utc::now() + chrono::Duration::seconds(30)).to_rfc3339();
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
        assert!(c.reuse_until > Utc::now() + NO_EXPIRY_TTL - chrono::Duration::seconds(5));
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
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let exec = exec_for(&script, "fail-s3cret-env");
        let err = credential(&exec).await.unwrap_err();
        assert!(matches!(err, AuthError::AuthExecRun { .. }), "{err:?}");
        if let AuthError::AuthExecRun { out, cmd, .. } = &err {
            assert_eq!(
                String::from_utf8_lossy(&out.stderr).trim(),
                "Run aws sso login"
            );
            assert_eq!(cmd, &script.display().to_string());
        }
        // Neither the env value nor the plugin's stdout reaches a message.
        let wrapped = kube::Error::Auth(err);
        let text = crate::errors::chain_text(&wrapped);
        assert!(!text.contains("s3cret"), "{text}");
        assert!(text.ends_with("exit code 255: Run aws sso login"), "{text}");
        credential(&exec).await.unwrap_err();
        assert_eq!(runs(&count), 2);

        let missing = exec_for(&dir.join("nope"), "x");
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
