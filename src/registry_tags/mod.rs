//! Available tags (#539): the newer tags of a running image in its
//! registry, grouped against its tag (newer patch, minor, major), the
//! variant kept, and whether the tag itself was pushed again since the pod
//! pulled it.
//!
//! The registry is asked through the OCI distribution API
//! (`/v2/<repo>/tags/list`, paginated by `Link`, with the registry's
//! anonymous token flow, or the user's docker credentials, see [`auth`]),
//! the tag's digest with a `HEAD` of its manifest, and for Docker Hub the
//! dates from its own API ([`hub`]).
//!
//! The image name comes from the cluster, so the host is untrusted. What
//! keeps the requests safe is in [`reference`] (the host checks) and
//! [`http`] (HTTPS only, no redirect to another host, capped bodies,
//! timeouts). Nothing here runs on its own: the app calls it on a click,
//! with its setting on; `nauvi tags` when typed.

mod auth;
mod http;
mod hub;
mod images;
mod reference;
mod text;
mod versions;

pub use images::{workload_images, ContainerImage};
pub use reference::{check_host, running_digest, ImageRef, DOCKER_HUB};
pub use text::{report_text, short_digest, state_text};
pub use versions::{group, Grouped, Version};

use ::http::header::{HeaderName, HeaderValue, ACCEPT, AUTHORIZATION};
use ::http::{Method, StatusCode, Uri};
use auth::{Challenge, Credentials, Source};
use http::{host_of, query_escape, resolve, Https, Reply};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Pages of the tag list read at most.
const MAX_PAGES: usize = 50;
/// Tags read at most; the rest are left out (`truncated`).
const MAX_TAGS: usize = 20_000;
/// The most read of one page of the tag list.
const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;
/// The most read of a token answer.
const MAX_TOKEN_BYTES: usize = 64 * 1024;
/// A whole look-up (every page, the digest and the dates).
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(60);
/// Tags listed per group; the rest are counted in `more`.
pub const GROUP_MAX: usize = 25;

/// The manifest types asked for in the digest `HEAD`, index types first:
/// what a pull by tag resolves to, so the digest matches the pod's
/// `imageID`.
const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.v2+json";

/// Debug builds only: a PEM file with the only extra CA to trust, which
/// also lets loopback registries through (the QA scenario's local one).
pub const TEST_CA_ENV: &str = "NAUVI_REGISTRY_TEST_CA";
/// Debug builds only: the `host:port` that stands in for Docker Hub (its
/// registry and its API), for the QA scenario.
pub const TEST_DOCKER_HUB_ENV: &str = "NAUVI_REGISTRY_TEST_DOCKER_HUB";

/// One tag in a group.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TagInfo {
    pub tag: String,
    /// When it was pushed (RFC 3339), from Docker Hub; `""` elsewhere or
    /// unknown.
    pub updated: String,
}

/// Tags of one group, newest first, at most [`GROUP_MAX`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TagGroup {
    pub tags: Vec<TagInfo>,
    /// How many more there are.
    pub more: u32,
}

/// The running tag compared with the registry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum TagState {
    /// The tag still points at what the pod runs.
    Unchanged,
    /// The tag was pushed again: it points at another digest now.
    Updated,
    /// The registry no longer has the tag.
    Gone,
    /// Not known: no digest from the registry, or the pod's `imageID` says
    /// none (not pulled yet, loaded by hand).
    #[default]
    Unknown,
}

/// What the registry has for an image.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TagReport {
    /// The image as the pod names it.
    pub image: String,
    /// `docker.io`, `ghcr.io`, `registry.example.com:5000`.
    pub registry: String,
    /// `library/mongo`.
    pub repository: String,
    /// The running tag (`""` for an image pinned by digest only).
    pub tag: String,
    /// The tag's numbers (`7.0.1`), `""` when it is not a version.
    pub version: String,
    /// What follows them (`-jammy`), kept in every suggestion.
    pub variant: String,
    pub patch: TagGroup,
    pub minor: TagGroup,
    pub major: TagGroup,
    /// Tags that are not versions (`latest`, `stable`).
    pub other: TagGroup,
    /// Tags read from the registry.
    pub tag_count: u32,
    /// The list was longer than nauvi reads ([`MAX_TAGS`] or [`MAX_PAGES`]).
    pub truncated: bool,
    pub state: TagState,
    /// The tag's digest in the registry (`""`: unknown).
    pub registry_digest: String,
    /// What the pod runs, from its `imageID` (`""`: unknown).
    pub running_digest: String,
    /// When the report was read from the registry (epoch seconds).
    pub fetched_at: u64,
}

/// What a look-up reads from the registry, before it is compared with a
/// pod (cached by [`TagCache`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryData {
    pub tags: Vec<String>,
    pub truncated: bool,
    /// The tag's digest (`""`: unknown).
    pub digest: String,
    /// Tag -> push date (Docker Hub only).
    pub dates: HashMap<String, String>,
    pub fetched_at: u64,
}

/// The newer tags of `image` and how its tag compares with `image_id` (a
/// pod's `status.containerStatuses[].imageID`, or `""`).
pub async fn available_tags(image: &str, image_id: &str) -> Result<TagReport, String> {
    let r = ImageRef::parse(image)?;
    let data = fetch(&r).await?;
    Ok(report(image, &r, image_id, &data))
}

/// Read `image`'s tags, digest and (Docker Hub) dates from its registry.
pub async fn fetch(image: &ImageRef) -> Result<RegistryData, String> {
    match tokio::time::timeout(LOOKUP_TIMEOUT, fetch_inner(image)).await {
        Ok(r) => r.map_err(|e| sentence(&e)),
        Err(_) => Err(format!(
            "{} did not answer within {} s.",
            shown_registry(&image.registry),
            LOOKUP_TIMEOUT.as_secs()
        )),
    }
}

async fn fetch_inner(image: &ImageRef) -> Result<RegistryData, String> {
    let hooks = Hooks::read()?;
    let http = Https::new(hooks.extra_roots.clone(), hooks.allow_loopback)?;
    let api = if image.registry == DOCKER_HUB {
        hooks.hub_registry.clone()
    } else {
        image.registry.clone()
    };
    let mut s = Session {
        http: &http,
        api,
        image,
        auth: None,
        tried_login: false,
        had_credentials: false,
    };
    let (tags, truncated) = s.list_tags().await?;
    let digest = if image.tag.is_empty() {
        String::new()
    } else {
        s.digest().await
    };
    let dates = if image.registry == DOCKER_HUB {
        hub::tag_dates(&http, &hooks.hub_api, &image.repository).await
    } else {
        HashMap::new()
    };
    Ok(RegistryData {
        tags,
        truncated,
        digest,
        dates,
        fetched_at: now_secs(),
    })
}

/// Compare what the registry has with the running image.
pub fn report(image: &str, r: &ImageRef, image_id: &str, data: &RegistryData) -> TagReport {
    let grouped = group(&r.tag, data.tags.iter().map(String::as_str));
    let to_group = |tags: Vec<String>| TagGroup {
        more: tags.len().saturating_sub(GROUP_MAX) as u32,
        tags: tags
            .into_iter()
            .take(GROUP_MAX)
            .map(|t| TagInfo {
                updated: data.dates.get(&t).cloned().unwrap_or_default(),
                tag: t,
            })
            .collect(),
    };
    let version = Version::parse(&r.tag);
    let running = if r.digest.is_empty() {
        running_digest(r, image_id).unwrap_or_default()
    } else {
        r.digest.clone()
    };
    let state = if !r.tag.is_empty() && !data.truncated && !data.tags.contains(&r.tag) {
        TagState::Gone
    } else if data.digest.is_empty() || running.is_empty() {
        TagState::Unknown
    } else if data.digest == running {
        TagState::Unchanged
    } else {
        TagState::Updated
    };
    TagReport {
        image: image.trim().to_string(),
        registry: r.registry.clone(),
        repository: r.repository.clone(),
        tag: r.tag.clone(),
        version: version
            .as_ref()
            .map(Version::number_text)
            .unwrap_or_default(),
        variant: version.map(|v| v.variant).unwrap_or_default(),
        patch: to_group(grouped.patch),
        minor: to_group(grouped.minor),
        major: to_group(grouped.major),
        other: to_group(grouped.other),
        tag_count: data.tags.len() as u32,
        truncated: data.truncated,
        state,
        registry_digest: data.digest.clone(),
        running_digest: running,
        fetched_at: data.fetched_at,
    }
}

/// `e` ending with a full stop.
fn sentence(e: &str) -> String {
    let mut out = e.trim().to_string();
    if !out.ends_with(['.', '!', '?']) {
        out.push('.');
    }
    out
}

/// `Docker Hub` or the host, for messages.
pub fn shown_registry(registry: &str) -> String {
    if registry == DOCKER_HUB {
        "Docker Hub".into()
    } else {
        registry.into()
    }
}

/// Registry look-ups kept for [`TagCache::TTL`], so clicking again (or on
/// the same image in another pod) does not ask the registry again (Docker
/// Hub limits anonymous requests). Errors are not kept.
#[derive(Default)]
pub struct TagCache {
    entries: Mutex<HashMap<String, (Instant, RegistryData)>>,
}

impl TagCache {
    pub const TTL: Duration = Duration::from_secs(10 * 60);
    const MAX_ENTRIES: usize = 100;

    /// [`available_tags`], from the cache when it is fresh and `refresh`
    /// is not set.
    pub async fn report(
        &self,
        image: &str,
        image_id: &str,
        refresh: bool,
    ) -> Result<TagReport, String> {
        let r = ImageRef::parse(image)?;
        let key = format!("{}/{}:{}@{}", r.registry, r.repository, r.tag, r.digest);
        let cached = (!refresh)
            .then(|| {
                self.lock()
                    .get(&key)
                    .filter(|(at, _)| at.elapsed() < Self::TTL)
                    .map(|(_, d)| d.clone())
            })
            .flatten();
        let data = match cached {
            Some(d) => d,
            None => {
                let d = fetch(&r).await?;
                let mut map = self.lock();
                map.retain(|_, (at, _)| at.elapsed() < Self::TTL);
                if map.len() >= Self::MAX_ENTRIES {
                    if let Some(oldest) = map
                        .iter()
                        .min_by_key(|(_, (at, _))| *at)
                        .map(|(k, _)| k.clone())
                    {
                        map.remove(&oldest);
                    }
                }
                map.insert(key, (Instant::now(), d.clone()));
                d
            }
        };
        Ok(report(image, &r, image_id, &data))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, RegistryData)>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The debug-build test hooks (see [`TEST_CA_ENV`]); release builds get
/// the real hosts and the system's roots only.
struct Hooks {
    extra_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
    allow_loopback: bool,
    /// The authority Docker Hub's registry API is reached at.
    hub_registry: String,
    /// The authority of Docker Hub's own API.
    hub_api: String,
}

impl Hooks {
    fn read() -> Result<Self, String> {
        let mut h = Self {
            extra_roots: Vec::new(),
            allow_loopback: false,
            hub_registry: "registry-1.docker.io".into(),
            hub_api: hub::HUB_API.into(),
        };
        if !cfg!(debug_assertions) {
            return Ok(h);
        }
        if let Some(path) = std::env::var_os(TEST_CA_ENV).filter(|p| !p.is_empty()) {
            use rustls::pki_types::pem::PemObject as _;
            let pem = std::fs::read(&path).map_err(|e| format!("{TEST_CA_ENV}: {e}"))?;
            for cert in rustls::pki_types::CertificateDer::pem_slice_iter(&pem) {
                h.extra_roots
                    .push(cert.map_err(|e| format!("{TEST_CA_ENV}: {e}"))?);
            }
            h.allow_loopback = true;
        }
        if let Ok(hub) = std::env::var(TEST_DOCKER_HUB_ENV) {
            if !hub.trim().is_empty() {
                h.hub_registry = hub.trim().to_string();
                h.hub_api = hub.trim().to_string();
            }
        }
        Ok(h)
    }
}

/// The requests of one look-up to one registry, with the login it needed.
struct Session<'a> {
    http: &'a Https,
    /// The registry API's authority (`registry-1.docker.io` for Docker Hub).
    api: String,
    image: &'a ImageRef,
    /// The `Authorization` value once logged in.
    auth: Option<String>,
    tried_login: bool,
    /// Credentials from the docker config were used for the login.
    had_credentials: bool,
}

impl Session<'_> {
    fn registry(&self) -> String {
        shown_registry(&self.image.registry)
    }

    fn uri(&self, path: &str) -> Result<Uri, String> {
        format!("https://{}{path}", self.api)
            .parse()
            .map_err(|_| format!("{} is not a registry host name.", self.api))
    }

    fn headers(&self, accept: Option<&'static str>) -> Vec<(HeaderName, HeaderValue)> {
        let mut h = Vec::new();
        if let Some(a) = accept {
            h.push((ACCEPT, HeaderValue::from_static(a)));
        }
        if let Some(v) = self
            .auth
            .as_deref()
            .and_then(|a| HeaderValue::from_str(a).ok())
        {
            let mut v = v;
            v.set_sensitive(true);
            h.push((AUTHORIZATION, v));
        }
        h
    }

    /// `method uri`, logging in once on a 401.
    async fn send(
        &mut self,
        method: Method,
        uri: Uri,
        accept: Option<&'static str>,
        cap: usize,
    ) -> Result<Reply, String> {
        let reply = self
            .http
            .send(method.clone(), uri.clone(), &self.headers(accept), cap)
            .await?;
        if reply.status != StatusCode::UNAUTHORIZED || self.tried_login {
            return Ok(reply);
        }
        self.tried_login = true;
        self.login(&reply).await?;
        self.http
            .send(method, uri, &self.headers(accept), cap)
            .await
    }

    /// The user's credentials for this registry, from the docker config.
    async fn credentials(&self) -> Option<Credentials> {
        let config = auth::read_config();
        match auth::source_for(&config, &self.image.registry) {
            Source::None => None,
            Source::Inline(c) => Some(c),
            Source::Helper(name) => auth::from_helper(&name, &self.image.registry).await,
        }
    }

    /// `docker login` for this registry, as the user would type it.
    fn login_command(&self) -> String {
        if self.image.registry == DOCKER_HUB {
            "`docker login`".into()
        } else {
            format!("`docker login {}`", self.image.registry)
        }
    }

    fn needs_login(&self) -> String {
        format!(
            "{} did not let nauvi read {} without a login. If the image is private, run {} \
             on this machine: nauvi uses your docker credentials, never the cluster's pull \
             secrets.",
            self.registry(),
            self.image.name(),
            self.login_command()
        )
    }

    fn refused_credentials(&self) -> String {
        format!(
            "{} refused the credentials in your docker config. Run {} again.",
            self.registry(),
            self.login_command()
        )
    }

    async fn login(&mut self, reply: &Reply) -> Result<(), String> {
        let Some(challenge) = reply.header("www-authenticate").and_then(Challenge::parse) else {
            return Err(self.needs_login());
        };
        let creds = self.credentials().await;
        match challenge.scheme.as_str() {
            "basic" => {
                let c = creds.ok_or_else(|| self.needs_login())?;
                self.had_credentials = true;
                self.auth = Some(c.basic());
                Ok(())
            }
            "bearer" => {
                let realm = challenge
                    .params
                    .get("realm")
                    .and_then(|r| r.parse::<Uri>().ok())
                    .filter(|u| u.authority().is_some())
                    .ok_or_else(|| {
                        format!(
                            "{} asked for a login without a token service.",
                            self.registry()
                        )
                    })?;
                self.http.check(&realm)?;
                let realm_host = host_of(&realm);
                let creds = creds.filter(|_| auth::may_send_credentials(&self.api, &realm_host));
                let mut url = realm.to_string();
                url.push(if realm.query().is_some() { '&' } else { '?' });
                if let Some(service) = challenge.params.get("service") {
                    url.push_str(&format!("service={}&", query_escape(service)));
                }
                url.push_str(&format!(
                    "scope={}",
                    query_escape(&format!("repository:{}:pull", self.image.repository))
                ));
                let token_uri: Uri = url.parse().map_err(|_| {
                    format!(
                        "{} named a token service nauvi cannot use.",
                        self.registry()
                    )
                })?;
                let mut headers = Vec::new();
                if let Some(c) = &creds {
                    if let Ok(mut v) = HeaderValue::from_str(&c.basic()) {
                        v.set_sensitive(true);
                        headers.push((AUTHORIZATION, v));
                    }
                }
                let answer = self
                    .http
                    .send(Method::GET, token_uri, &headers, MAX_TOKEN_BYTES)
                    .await?;
                if answer.status.is_success() {
                    let token = auth::token_of(&answer.body).ok_or_else(|| {
                        format!("{} sent a login token nauvi cannot read.", self.registry())
                    })?;
                    self.had_credentials = creds.is_some();
                    self.auth = Some(format!("Bearer {token}"));
                    return Ok(());
                }
                match (answer.status, creds.is_some()) {
                    (StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, true) => {
                        Err(self.refused_credentials())
                    }
                    (StatusCode::TOO_MANY_REQUESTS, _) => Err(self.rate_limited()),
                    _ => Err(self.needs_login()),
                }
            }
            _ => Err(self.needs_login()),
        }
    }

    fn rate_limited(&self) -> String {
        format!(
            "{} limits how often it answers (429 Too Many Requests). Try again later.",
            self.registry()
        )
    }

    /// Every tag, following `Link` pages on the same host; whether the list
    /// was cut short.
    async fn list_tags(&mut self) -> Result<(Vec<String>, bool), String> {
        let mut next = Some(self.uri(&format!("/v2/{}/tags/list", self.image.repository))?);
        let mut tags = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..MAX_PAGES {
            let Some(uri) = next.take() else {
                return Ok((tags, false));
            };
            if !seen.insert(uri.to_string()) {
                return Ok((tags, false));
            }
            let reply = self.send(Method::GET, uri, None, MAX_LIST_BYTES).await?;
            self.list_status(reply.status)?;
            let page: serde_json::Value = serde_json::from_slice(&reply.body)
                .map_err(|_| format!("{} sent a tag list nauvi cannot read.", self.registry()))?;
            for t in page
                .get("tags")
                .and_then(|t| t.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(t) = t.as_str().filter(|t| reference::is_tag(t)) {
                    tags.push(t.to_string());
                }
            }
            if tags.len() >= MAX_TAGS {
                tags.truncate(MAX_TAGS);
                return Ok((tags, true));
            }
            next = match reply.header("link").and_then(next_link) {
                Some(link) => match resolve(&reply.uri, &link) {
                    Some(u) if u.authority().map(|a| a.as_str()) == Some(self.api.as_str()) => {
                        Some(u)
                    }
                    // A next page on another host is not read.
                    _ => return Ok((tags, true)),
                },
                None => None,
            };
        }
        Ok((tags, next.is_some()))
    }

    fn list_status(&self, status: StatusCode) -> Result<(), String> {
        if status.is_success() {
            return Ok(());
        }
        Err(match status {
            StatusCode::UNAUTHORIZED if self.had_credentials => self.refused_credentials(),
            StatusCode::UNAUTHORIZED => self.needs_login(),
            StatusCode::FORBIDDEN => format!(
                "{} does not allow listing the tags of {} (403 Forbidden).",
                self.registry(),
                self.image.name()
            ),
            StatusCode::NOT_FOUND => format!(
                "{} has no repository {}.",
                self.registry(),
                self.image.repository
            ),
            StatusCode::TOO_MANY_REQUESTS => self.rate_limited(),
            s => format!(
                "{} answered {s} to the tag list of {}.",
                self.registry(),
                self.image.name()
            ),
        })
    }

    /// The tag's digest (`HEAD` of its manifest), `""` if the registry does
    /// not say.
    async fn digest(&mut self) -> String {
        let Ok(uri) = self.uri(&format!(
            "/v2/{}/manifests/{}",
            self.image.repository, self.image.tag
        )) else {
            return String::new();
        };
        match self
            .send(Method::HEAD, uri, Some(MANIFEST_TYPES), 1024)
            .await
        {
            Ok(r) if r.status.is_success() => r
                .header("docker-content-digest")
                .filter(|d| reference::is_digest(d))
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        }
    }
}

/// The `rel="next"` target of a `Link` header.
fn next_link(header: &str) -> Option<String> {
    for part in header.split(',') {
        let (target, params) = part.split_once(';')?;
        let target = target.trim().strip_prefix('<')?.strip_suffix('>')?;
        let is_next = params.split(';').any(|p| {
            let p = p.trim().to_ascii_lowercase();
            p == "rel=\"next\"" || p == "rel=next"
        });
        if is_next {
            return Some(target.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_sentences() {
        assert_eq!(sentence("ghcr.io answered 500"), "ghcr.io answered 500.");
        assert_eq!(
            sentence("nauvi does not contact x."),
            "nauvi does not contact x."
        );
    }

    #[test]
    fn reads_the_next_link() {
        assert_eq!(
            next_link(r#"</v2/a/tags/list?last=x&n=100>; rel="next""#).as_deref(),
            Some("/v2/a/tags/list?last=x&n=100")
        );
        assert_eq!(
            next_link(r#"<https://r/p1>; rel="prev", <https://r/p3>; rel=next"#).as_deref(),
            Some("https://r/p3")
        );
        assert_eq!(next_link(r#"</x>; rel="prev""#), None);
        assert_eq!(next_link("garbage"), None);
    }

    fn data(tags: &[&str], digest: &str) -> RegistryData {
        RegistryData {
            tags: tags.iter().map(|t| t.to_string()).collect(),
            digest: digest.into(),
            ..Default::default()
        }
    }

    #[test]
    fn reports_groups_and_a_repushed_tag() {
        let a = format!("sha256:{}", "a".repeat(64));
        let b = format!("sha256:{}", "b".repeat(64));
        let image = "mongo:7.0.1-jammy";
        let r = ImageRef::parse(image).unwrap();
        let d = data(
            &[
                "7.0.1-jammy",
                "7.0.2-jammy",
                "7.0.2",
                "7.1.0-jammy",
                "8.0.0-jammy",
                "latest",
            ],
            &a,
        );
        let rep = report(image, &r, &format!("docker.io/library/mongo@{b}"), &d);
        assert_eq!(rep.version, "7.0.1");
        assert_eq!(rep.variant, "-jammy");
        assert_eq!(rep.patch.tags[0].tag, "7.0.2-jammy");
        assert_eq!(rep.minor.tags[0].tag, "7.1.0-jammy");
        assert_eq!(rep.major.tags[0].tag, "8.0.0-jammy");
        assert_eq!(rep.other.tags[0].tag, "latest");
        assert_eq!(rep.state, TagState::Updated);
        assert_eq!(rep.tag_count, 6);
        let same = report(image, &r, &format!("docker.io/library/mongo@{a}"), &d);
        assert_eq!(same.state, TagState::Unchanged);
        let unknown = report(image, &r, &a, &d);
        assert_eq!(unknown.state, TagState::Unknown);
        let gone = report(image, &r, "", &data(&["7.0.2-jammy"], ""));
        assert_eq!(gone.state, TagState::Gone);
        let mut cut = data(&["7.0.2-jammy"], "");
        cut.truncated = true;
        assert_eq!(report(image, &r, "", &cut).state, TagState::Unknown);
    }

    #[test]
    fn caps_each_group() {
        let tags: Vec<String> = (2..60).map(|p| format!("1.0.{p}")).collect();
        let d = RegistryData {
            tags,
            ..Default::default()
        };
        let r = ImageRef::parse("x:1.0.1").unwrap();
        let rep = report("x:1.0.1", &r, "", &d);
        assert_eq!(rep.patch.tags.len(), GROUP_MAX);
        assert_eq!(rep.patch.more, 58 - GROUP_MAX as u32);
        assert_eq!(rep.patch.tags[0].tag, "1.0.59");
    }

    #[test]
    fn a_pinned_digest_is_what_runs() {
        let a = format!("sha256:{}", "a".repeat(64));
        let b = format!("sha256:{}", "b".repeat(64));
        let image = format!("ghcr.io/o/app:1.0@{a}");
        let r = ImageRef::parse(&image).unwrap();
        let rep = report(&image, &r, "", &data(&["1.0"], &b));
        assert_eq!(rep.running_digest, a);
        assert_eq!(rep.state, TagState::Updated);
    }
}
