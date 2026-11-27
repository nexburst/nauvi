//! Logging in to a registry: the `WWW-Authenticate` challenge, the token
//! flow, and the user's own docker credentials.
//!
//! - Credentials come only from the user's docker config
//!   (`$DOCKER_CONFIG/config.json`, else `~/.docker/config.json`): an
//!   `auths` entry, a `credHelpers` helper for that host, or the
//!   `credsStore` for a host that `auths` lists (as `docker login` leaves
//!   it). Never from the cluster (`imagePullSecrets` are not read).
//! - A host's credentials go only to that host, or to the token service
//!   its challenge names when that is the same host, a parent domain of it
//!   (`registry.gitlab.com` -> `gitlab.com`), or `auth.docker.io` for
//!   Docker Hub. Over HTTPS only (the client refuses anything else).
//! - A credential helper is `docker-credential-<name>` on `PATH`, `<name>`
//!   from the user's config and only `[A-Za-z0-9._-]`; the host goes to its
//!   stdin, never into its arguments. It gets [`HELPER_TIMEOUT`] and its
//!   output is capped.
//! - Neither credentials nor tokens are ever logged or put in a message.

use super::reference::{split_host, DOCKER_HUB};
use base64::Engine as _;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// How long a credential helper may take.
const HELPER_TIMEOUT: Duration = Duration::from_secs(10);
/// The most read of a helper's output or a docker config file.
const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_HELPER_OUTPUT: usize = 64 * 1024;

/// A user name and password (or token) from the docker config.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Credentials {
    pub username: String,
    pub secret: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Credentials({}, ••••)", self.username)
    }
}

impl Credentials {
    /// The `Authorization: Basic …` value.
    pub(crate) fn basic(&self) -> String {
        let raw = format!("{}:{}", self.username, self.secret);
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        )
    }
}

/// A `WWW-Authenticate` challenge: its scheme (lower-case) and parameters
/// (keys lower-case).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Challenge {
    pub scheme: String,
    pub params: BTreeMap<String, String>,
}

impl Challenge {
    /// Parse one challenge (`Bearer realm="…",service="…",scope="…"`).
    pub(crate) fn parse(header: &str) -> Option<Self> {
        let header = header.trim();
        let (scheme, rest) = header.split_once(' ').unwrap_or((header, ""));
        if scheme.is_empty() || !scheme.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        let mut params = BTreeMap::new();
        let mut s = rest.trim_start();
        while !s.is_empty() {
            let eq = s.find('=')?;
            let key = s[..eq].trim().to_ascii_lowercase();
            s = &s[eq + 1..];
            let value;
            if let Some(q) = s.strip_prefix('"') {
                let mut out = String::new();
                let mut chars = q.char_indices();
                let mut end = None;
                while let Some((i, c)) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some((_, n)) = chars.next() {
                                out.push(n);
                            }
                        }
                        '"' => {
                            end = Some(i + 1);
                            break;
                        }
                        c => out.push(c),
                    }
                }
                value = out;
                s = &q[end?..];
            } else {
                let stop = s.find(',').unwrap_or(s.len());
                value = s[..stop].trim().to_string();
                s = &s[stop..];
            }
            if !key.is_empty() {
                params.insert(key, value);
            }
            s = s.trim_start().trim_start_matches(',').trim_start();
        }
        Some(Self {
            scheme: scheme.to_ascii_lowercase(),
            params,
        })
    }
}

/// Whether credentials for `registry` (the API host, `host[:port]`) may go
/// to the token service at `realm_host`.
pub(crate) fn may_send_credentials(registry_host: &str, realm_host: &str) -> bool {
    let (r, t) = (
        registry_host.to_ascii_lowercase(),
        realm_host.to_ascii_lowercase(),
    );
    if r == t {
        return true;
    }
    if r == "registry-1.docker.io" && t == "auth.docker.io" {
        return true;
    }
    // A parent domain with at least two labels (`gitlab.com`, never `com`),
    // of host names only: `10.0.0.5` does not "end with" `0.0.5`.
    let is_ip = |a: &str| {
        split_host(a)
            .map(|(h, _)| h.parse::<std::net::IpAddr>().is_ok())
            .unwrap_or(true)
    };
    !is_ip(&r) && !is_ip(&t) && t.contains('.') && r.ends_with(&format!(".{t}"))
}

/// The Bearer token service `realm` a challenge from `api` (the registry
/// API's `host[:port]`) names is followed only on the registry's own host
/// name or its parent domain, on any port (a self-hosted GitLab serves its
/// registry on `gitlab.example.com:5050` and signs in at
/// `gitlab.example.com`), or `auth.docker.io` for Docker Hub. An IP literal
/// must match exactly, port included. Anything else (another host, an
/// internal address) is refused, so a registry named by the cluster cannot
/// send nauvi to an arbitrary URL. Credentials follow the stricter
/// [`may_send_credentials`] (ports must match).
pub(crate) fn check_realm(registry: &str, api: &str, realm: &http::Uri) -> Result<(), String> {
    let host = realm.authority().map(|a| a.as_str()).unwrap_or("");
    let name = |a: &str| -> Option<String> {
        let (h, _) = split_host(a).ok()?;
        h.parse::<std::net::IpAddr>().is_err().then_some(h)
    };
    let same_name = match (name(api), name(host)) {
        (Some(r), Some(t)) => may_send_credentials(&r, &t),
        _ => false,
    };
    if !host.is_empty() && (may_send_credentials(api, host) || same_name) {
        return Ok(());
    }
    let shown: String = host.chars().filter(|c| !c.is_control()).take(120).collect();
    Err(format!(
        "{registry} sent its sign-in to another host, {shown}: nauvi signs in only at the \
         registry's own host or its parent domain."
    ))
}

/// The docker config file, if there is one.
fn config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DOCKER_CONFIG").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("config.json"));
    }
    Some(home::home_dir()?.join(".docker").join("config.json"))
}

/// The docker config, `{}` without one or when it does not parse.
pub(crate) fn read_config() -> serde_json::Value {
    let read = || -> Option<serde_json::Value> {
        let path = config_path()?;
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MAX_CONFIG {
            return None;
        }
        serde_json::from_slice(&std::fs::read(&path).ok()?).ok()
    };
    read().unwrap_or_else(|| serde_json::json!({}))
}

/// A config key (`https://index.docker.io/v1/`, `ghcr.io`) as a registry
/// as an image names it (`docker.io`, `ghcr.io`).
fn key_registry(key: &str) -> String {
    let k = key.trim();
    let k = k
        .strip_prefix("https://")
        .or_else(|| k.strip_prefix("http://"))
        .unwrap_or(k);
    let host = k.split('/').next().unwrap_or("").to_ascii_lowercase();
    match host.as_str() {
        "index.docker.io" | "registry-1.docker.io" | "registry.hub.docker.com" => DOCKER_HUB.into(),
        _ => host,
    }
}

/// Where the credentials of `registry` (as an image names it) are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Source {
    None,
    Inline(Credentials),
    /// A credential helper, by its name (`desktop`, `osxkeychain`).
    Helper(String),
}

/// The credentials source for `registry` in `config`.
pub(crate) fn source_for(config: &serde_json::Value, registry: &str) -> Source {
    let entries = |field: &str| -> Vec<(String, serde_json::Value)> {
        config
            .get(field)
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (key_registry(k), v.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };
    if let Some((_, helper)) = entries("credHelpers")
        .into_iter()
        .find(|(k, _)| k == registry)
    {
        if let Some(name) = helper.as_str().filter(|n| is_helper_name(n)) {
            return Source::Helper(name.to_string());
        }
    }
    let Some((_, entry)) = entries("auths").into_iter().find(|(k, _)| k == registry) else {
        return Source::None;
    };
    if let Some(auth) = entry
        .get("auth")
        .and_then(|a| a.as_str())
        .filter(|a| !a.is_empty())
    {
        if let Some(c) = decode_auth(auth) {
            return Source::Inline(c);
        }
    }
    if let (Some(u), Some(p)) = (
        entry.get("username").and_then(|v| v.as_str()),
        entry.get("password").and_then(|v| v.as_str()),
    ) {
        return Source::Inline(Credentials {
            username: u.into(),
            secret: p.into(),
        });
    }
    match config.get("credsStore").and_then(|v| v.as_str()) {
        Some(name) if is_helper_name(name) => Source::Helper(name.to_string()),
        _ => Source::None,
    }
}

fn decode_auth(auth: &str) -> Option<Credentials> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(auth.trim())
        .ok()?;
    let text = String::from_utf8(raw).ok()?;
    let (u, p) = text.split_once(':')?;
    Some(Credentials {
        username: u.into(),
        secret: p.into(),
    })
}

fn is_helper_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The server URL a credential helper knows `registry` by.
fn helper_server(registry: &str) -> String {
    if registry == DOCKER_HUB {
        "https://index.docker.io/v1/".into()
    } else {
        registry.into()
    }
}

/// Ask `docker-credential-<helper>` for `registry`'s credentials. `None`
/// when it has none (or fails, or answers with an identity token, which
/// needs an OAuth exchange nauvi does not do).
pub(crate) async fn from_helper(helper: &str, registry: &str) -> Option<Credentials> {
    if !is_helper_name(helper) {
        return None;
    }
    let mut child = tokio::process::Command::new(format!("docker-credential-{helper}"))
        .arg("get")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let server = helper_server(registry);
    let run = async move {
        stdin.write_all(server.as_bytes()).await.ok()?;
        drop(stdin);
        let mut out = Vec::new();
        let stdout = child.stdout.take()?;
        stdout
            .take(MAX_HELPER_OUTPUT as u64)
            .read_to_end(&mut out)
            .await
            .ok()?;
        let status = child.wait().await.ok()?;
        status.success().then_some(out)
    };
    let out = tokio::time::timeout(HELPER_TIMEOUT, run).await.ok()??;
    parse_helper_output(&out)
}

fn parse_helper_output(out: &[u8]) -> Option<Credentials> {
    let v: serde_json::Value = serde_json::from_slice(out).ok()?;
    let username = v.get("Username")?.as_str()?.to_string();
    let secret = v.get("Secret")?.as_str()?.to_string();
    if username == "<token>" || secret.is_empty() {
        return None;
    }
    Some(Credentials { username, secret })
}

/// The token in a token service's JSON answer (`token` or `access_token`).
pub(crate) fn token_of(body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let t = v.get("token").or_else(|| v.get("access_token"))?.as_str()?;
    (!t.is_empty() && t.len() <= 16 * 1024 && t.bytes().all(|b| b.is_ascii_graphic()))
        .then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_challenges() {
        let c = Challenge::parse(
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/mongo:pull,push""#,
        )
        .unwrap();
        assert_eq!(c.scheme, "bearer");
        assert_eq!(c.params["realm"], "https://auth.docker.io/token");
        assert_eq!(c.params["service"], "registry.docker.io");
        assert_eq!(c.params["scope"], "repository:library/mongo:pull,push");
        let b = Challenge::parse(r#"Basic realm="Registry \"x\"""#).unwrap();
        assert_eq!(b.scheme, "basic");
        assert_eq!(b.params["realm"], r#"Registry "x""#);
        let bare = Challenge::parse("Bearer realm=https://r/token, service=r").unwrap();
        assert_eq!(bare.params["realm"], "https://r/token");
        assert_eq!(bare.params["service"], "r");
        assert!(Challenge::parse("").is_none());
        assert!(Challenge::parse(r#"Bearer realm="unterminated"#).is_none());
    }

    #[test]
    fn credentials_go_only_to_the_registry_or_its_own_token_service() {
        assert!(may_send_credentials("ghcr.io", "ghcr.io"));
        assert!(may_send_credentials(
            "registry-1.docker.io",
            "auth.docker.io"
        ));
        assert!(may_send_credentials("registry.gitlab.com", "gitlab.com"));
        assert!(may_send_credentials("Quay.io", "quay.io"));
        assert!(!may_send_credentials("ghcr.io", "evil.com"));
        assert!(!may_send_credentials("registry.gitlab.com", "com"));
        assert!(!may_send_credentials("evil-gitlab.com", "gitlab.com"));
        assert!(!may_send_credentials("gitlab.com", "registry.gitlab.com"));
        assert!(!may_send_credentials("ghcr.io:443", "ghcr.io"));
        // IP literals: only the same address and port.
        assert!(may_send_credentials("10.0.0.5:5000", "10.0.0.5:5000"));
        assert!(!may_send_credentials("10.0.0.5", "0.0.5"));
        assert!(!may_send_credentials("192.168.1.10", "168.1.10"));
        assert!(!may_send_credentials("10.0.0.5:5000", "10.0.0.5"));
    }

    #[test]
    fn a_token_service_on_another_host_is_not_followed() {
        let uri = |s: &str| s.parse::<http::Uri>().unwrap();
        assert_eq!(
            check_realm("ghcr.io", "ghcr.io", &uri("https://ghcr.io/token")),
            Ok(())
        );
        assert_eq!(
            check_realm(
                "Docker Hub",
                "registry-1.docker.io",
                &uri("https://auth.docker.io/token")
            ),
            Ok(())
        );
        assert_eq!(
            check_realm(
                "registry.gitlab.com",
                "registry.gitlab.com",
                &uri("https://gitlab.com/jwt/auth")
            ),
            Ok(())
        );
        let e = check_realm(
            "ghcr.io",
            "ghcr.io",
            &uri("https://internal.example.com/admin?x=1"),
        )
        .unwrap_err();
        assert!(
            e.starts_with("ghcr.io sent its sign-in to another host, internal.example.com:"),
            "{e}"
        );
        // An IP literal: another address, or the registry's own on another port.
        let e = check_realm("ghcr.io", "ghcr.io", &uri("https://10.0.0.1/token")).unwrap_err();
        assert!(e.contains("another host, 10.0.0.1:"), "{e}");
        let e = check_realm(
            "10.0.0.5:5000",
            "10.0.0.5:5000",
            &uri("https://10.0.0.5:8443/token"),
        )
        .unwrap_err();
        assert!(e.contains("another host, 10.0.0.5:8443:"), "{e}");
        // Self-hosted GitLab: registry on :5050, sign-in on the same name.
        let gl = "gitlab.example.com:5050";
        assert_eq!(
            check_realm(gl, gl, &uri("https://gitlab.example.com/jwt/auth")),
            Ok(())
        );
        assert_eq!(
            check_realm(gl, gl, &uri("https://gitlab.example.com:8443/jwt/auth")),
            Ok(())
        );
        assert_eq!(
            check_realm(
                "registry.gitlab.example.com:5050",
                "registry.gitlab.example.com:5050",
                &uri("https://gitlab.example.com/jwt/auth")
            ),
            Ok(())
        );
        // ...but credentials only go where the port matches too.
        assert!(!may_send_credentials(gl, "gitlab.example.com"));
        // Another name on any port is still refused, and so is nvcr.io's
        // sign-in on an unrelated host.
        assert!(check_realm(gl, gl, &uri("https://evil.example.com/jwt/auth")).is_err());
        assert!(check_realm(gl, gl, &uri("https://example.com.evil.net/x")).is_err());
        assert!(check_realm("nvcr.io", "nvcr.io", &uri("https://authn.nvidia.com/token")).is_err());
        // A name and an IP literal never match by name.
        assert!(check_realm(gl, gl, &uri("https://10.0.0.1/jwt/auth")).is_err());
        assert_eq!(
            check_realm(
                "10.0.0.5:5000",
                "10.0.0.5:5000",
                &uri("https://10.0.0.5:5000/token")
            ),
            Ok(())
        );
    }

    #[test]
    fn finds_credentials_in_the_docker_config() {
        let auth = base64::engine::general_purpose::STANDARD.encode("me:s3cret");
        let config = json!({
            "auths": {
                "https://index.docker.io/v1/": {"auth": auth},
                "registry.example.com:5000": {},
                "plain.example.com": {"username": "u", "password": "p"},
            },
            "credHelpers": {"ghcr.io": "gh", "bad.example.com": "../evil"},
            "credsStore": "desktop",
        });
        let me = Credentials {
            username: "me".into(),
            secret: "s3cret".into(),
        };
        assert_eq!(source_for(&config, "docker.io"), Source::Inline(me));
        assert_eq!(source_for(&config, "ghcr.io"), Source::Helper("gh".into()));
        assert_eq!(
            source_for(&config, "registry.example.com:5000"),
            Source::Helper("desktop".into())
        );
        assert_eq!(
            source_for(&config, "plain.example.com"),
            Source::Inline(Credentials {
                username: "u".into(),
                secret: "p".into()
            })
        );
        // Not listed in auths: the store is not asked about a host the
        // cluster named.
        assert_eq!(source_for(&config, "unknown.example.com"), Source::None);
        assert_eq!(source_for(&config, "bad.example.com"), Source::None);
        assert_eq!(source_for(&json!({}), "docker.io"), Source::None);
    }

    #[test]
    fn helper_output_and_tokens() {
        assert_eq!(
            parse_helper_output(br#"{"ServerURL":"ghcr.io","Username":"me","Secret":"t"}"#),
            Some(Credentials {
                username: "me".into(),
                secret: "t".into()
            })
        );
        assert_eq!(
            parse_helper_output(br#"{"Username":"<token>","Secret":"refresh"}"#),
            None
        );
        assert_eq!(parse_helper_output(b"credentials not found"), None);
        assert_eq!(
            token_of(br#"{"token":"abc.def"}"#).as_deref(),
            Some("abc.def")
        );
        assert_eq!(
            token_of(br#"{"access_token":"xyz"}"#).as_deref(),
            Some("xyz")
        );
        assert_eq!(token_of(br#"{"token":"a\nb"}"#), None);
        assert_eq!(token_of(b"{}"), None);
        let c = Credentials {
            username: "me".into(),
            secret: "pw".into(),
        };
        assert_eq!(format!("{c:?}"), "Credentials(me, ••••)");
        assert_eq!(c.basic(), "Basic bWU6cHc=");
    }

    #[tokio::test]
    async fn an_unknown_helper_gives_nothing() {
        assert_eq!(
            from_helper("nauvi-test-missing-helper", "ghcr.io").await,
            None
        );
        assert_eq!(from_helper("../x", "ghcr.io").await, None);
    }
}
