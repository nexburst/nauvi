//! Image references (`mongo:7.0.1`, `ghcr.io/org/app@sha256:…`) and the
//! checks on the registry hosts they name.
//!
//! An image name comes from the cluster, so it is untrusted: it is parsed
//! into a registry host, a repository and a tag that only hold the
//! characters the distribution spec allows, and only those parts go into
//! URLs. A host that is a loopback, link-local, multicast or unspecified
//! address (or `localhost`) is refused before any connection.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Docker Hub, as an image name says it (`mongo`, `docker.io/library/mongo`).
pub const DOCKER_HUB: &str = "docker.io";

/// The longest image reference accepted.
const MAX_REFERENCE: usize = 512;

/// One image reference, normalised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// `docker.io` for Docker Hub, else the host and port as written
    /// (`ghcr.io`, `registry.example.com:5000`), lower-case.
    pub registry: String,
    /// The repository path, `library/mongo` for an official image.
    pub repository: String,
    /// The tag (`latest` when the reference names neither a tag nor a
    /// digest; `""` when it only has a digest).
    pub tag: String,
    /// The digest pinned in the reference (`sha256:…`), or `""`.
    pub digest: String,
}

impl ImageRef {
    /// Parse `image` like Docker does. Refuses what is not a valid
    /// reference, saying what is wrong.
    pub fn parse(image: &str) -> Result<Self, String> {
        let text = image.trim();
        if text.is_empty() {
            return Err("No image given.".into());
        }
        if text.len() > MAX_REFERENCE {
            return Err("The image name is too long to be an image reference.".into());
        }
        let shown = shown(text);
        let (rest, digest) = match text.split_once('@') {
            Some((r, d)) => {
                if !is_digest(d) {
                    return Err(format!(
                        "{shown} has a digest that is not sha256:<64 hex digits>."
                    ));
                }
                (r, d.to_string())
            }
            None => (text, String::new()),
        };
        // The tag is after the last `:` that follows the last `/`.
        let slash = rest.rfind('/').map_or(0, |i| i + 1);
        let (name, tag) = match rest[slash..].rfind(':') {
            Some(i) => (&rest[..slash + i], rest[slash + i + 1..].to_string()),
            None => (rest, String::new()),
        };
        if !tag.is_empty() && !is_tag(&tag) {
            return Err(format!("{shown} has a tag that is not valid."));
        }
        let (registry, path) = match name.split_once('/') {
            Some((first, path))
                if first.contains('.') || first.contains(':') || first == "localhost" =>
            {
                (first.to_ascii_lowercase(), path)
            }
            _ => (DOCKER_HUB.to_string(), name),
        };
        let registry = match registry.as_str() {
            "index.docker.io" | "registry-1.docker.io" => DOCKER_HUB.to_string(),
            _ => registry,
        };
        if registry != DOCKER_HUB {
            split_host(&registry).map_err(|e| format!("{shown}: {e}"))?;
        }
        let repository = if registry == DOCKER_HUB && !path.contains('/') {
            format!("library/{path}")
        } else {
            path.to_string()
        };
        if !is_repository(&repository) {
            return Err(format!("{shown} has a repository name that is not valid."));
        }
        let tag = if tag.is_empty() && digest.is_empty() {
            "latest".to_string()
        } else {
            tag
        };
        Ok(Self {
            registry,
            repository,
            tag,
            digest,
        })
    }

    /// `registry/repository`, Docker Hub's official images without
    /// `library/` (`mongo`, `ghcr.io/org/app`).
    pub fn name(&self) -> String {
        if self.registry == DOCKER_HUB {
            match self.repository.strip_prefix("library/") {
                Some(short) => short.to_string(),
                None => self.repository.clone(),
            }
        } else {
            format!("{}/{}", self.registry, self.repository)
        }
    }

    /// `name:tag` (or `name@digest` without a tag).
    pub fn shown(&self) -> String {
        if self.tag.is_empty() {
            format!("{}@{}", self.name(), self.digest)
        } else {
            format!("{}:{}", self.name(), self.tag)
        }
    }

    /// What a table cell shows (the Image column, #547): the last part of
    /// the repository and the tag (`mongo:7.0.1`, `redis:7`), or the start
    /// of the digest without a tag (`app@sha256:4f3c2b1a0d9e`).
    pub fn short(&self) -> String {
        let last = self
            .repository
            .rsplit('/')
            .next()
            .unwrap_or(&self.repository);
        if self.tag.is_empty() {
            let digest: String = self.digest.chars().take("sha256:".len() + 12).collect();
            format!("{last}@{digest}")
        } else {
            format!("{last}:{}", self.tag)
        }
    }

    /// The whole reference, registry included
    /// (`docker.io/library/mongo:7.0.1@sha256:…`).
    pub fn full(&self) -> String {
        let mut out = format!("{}/{}", self.registry, self.repository);
        if !self.tag.is_empty() {
            out.push(':');
            out.push_str(&self.tag);
        }
        if !self.digest.is_empty() {
            out.push('@');
            out.push_str(&self.digest);
        }
        out
    }
}

/// The digest an `imageID` from a pod's status says the container runs,
/// if it names the same repository as `image`: `docker.io/library/mongo@sha256:…`
/// (also with `docker-pullable://`). `None` for a bare image id
/// (`sha256:…`, the local config digest), or one of another repository
/// (`kind load` imports): those cannot be compared with the registry.
pub fn running_digest(image: &ImageRef, image_id: &str) -> Option<String> {
    let id = image_id.trim();
    let id = id.strip_prefix("docker-pullable://").unwrap_or(id);
    let (name, digest) = id.split_once('@')?;
    if !is_digest(digest) {
        return None;
    }
    let of = ImageRef::parse(&format!("{name}@{digest}")).ok()?;
    (of.registry == image.registry && of.repository == image.repository).then(|| digest.to_string())
}

/// `sha256:` and 64 lower-case hex digits.
pub(crate) fn is_digest(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// A tag as the distribution spec allows: `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`.
pub(crate) fn is_tag(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && (b[0].is_ascii_alphanumeric() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// A repository path: components of `[a-z0-9]` joined by `.`, `_`, `__` or
/// `-`, separated by `/`. Nothing that could leave the URL path (`..`,
/// `%`, `?`).
fn is_repository(s: &str) -> bool {
    s.len() <= 255
        && s.split('/').all(|c| {
            let b = c.as_bytes();
            !b.is_empty()
                && b[0].is_ascii_alphanumeric()
                && b[b.len() - 1].is_ascii_alphanumeric()
                && !c.contains("..")
                && b.iter().all(|x| {
                    x.is_ascii_lowercase() || x.is_ascii_digit() || matches!(x, b'.' | b'_' | b'-')
                })
        })
}

/// A reference as shown in a message: control characters dropped.
fn shown(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(120).collect()
}

/// `host[:port]` split, the host checked to be a name or an IP literal
/// (`[::1]:5000` for IPv6).
pub(crate) fn split_host(authority: &str) -> Result<(String, Option<u16>), String> {
    let bad = || format!("{} is not a registry host name.", shown(authority));
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (h, after) = rest.split_once(']').ok_or_else(bad)?;
        match after {
            "" => (h.to_string(), None),
            p => (h.to_string(), Some(p.strip_prefix(':').ok_or_else(bad)?)),
        }
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    let port = match port {
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 && p.bytes().all(|b| b.is_ascii_digit()) => Some(n),
            _ => return Err(bad()),
        },
        None => None,
    };
    if host.parse::<IpAddr>().is_ok() {
        return Ok((host.to_ascii_lowercase(), port));
    }
    if authority.starts_with('[') || !is_host_name(&host) {
        return Err(bad());
    }
    Ok((host.to_ascii_lowercase(), port))
}

fn is_host_name(h: &str) -> bool {
    h.len() <= 253
        && h.split('.').all(|l| {
            let b = l.as_bytes();
            !b.is_empty()
                && b.len() <= 63
                && b[0] != b'-'
                && b[b.len() - 1] != b'-'
                && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
        })
}

/// Cloud metadata endpoints by name. They are plain HTTP (so HTTPS
/// already fails there), but they are never contacted at all.
const METADATA_HOSTS: &[&str] = &["metadata", "metadata.google.internal", "metadata.goog"];

/// Whether nauvi may contact `authority` (`host[:port]`) as a registry. It
/// came from the cluster: refuse a loopback, link-local, multicast,
/// broadcast or unspecified address, `localhost`, and cloud metadata
/// names. `allow_loopback` lets the QA scenario's local registry through
/// (debug builds only, see `super::Hooks`). The addresses a name resolves
/// to are checked again with [`ip_refused`] before the connection.
pub fn check_host(authority: &str, allow_loopback: bool) -> Result<(), String> {
    let (host, _) = split_host(authority)?;
    let refused = |why: &str| {
        Err(format!(
            "nauvi does not contact {}: it is {why}.",
            shown(authority)
        ))
    };
    // `127.1`, `0x7f.1`, `2130706433`: no IP literals to Rust, but the
    // system resolver (and so a scanner) reads them as addresses.
    let ip = host
        .parse::<IpAddr>()
        .ok()
        .or_else(|| legacy_ipv4(&host).map(IpAddr::V4));
    if let Some(ip) = ip {
        return match ip_refused(ip, allow_loopback) {
            Some(why) => refused(why),
            None => Ok(()),
        };
    }
    if host == "localhost" || host.ends_with(".localhost") {
        return if allow_loopback {
            Ok(())
        } else {
            refused("this machine (localhost)")
        };
    }
    if METADATA_HOSTS.contains(&host.as_str()) {
        return refused("a cloud metadata endpoint");
    }
    Ok(())
}

/// Every address `authority`'s name resolves to (from `resolve`) checked
/// with [`ip_refused`], after [`check_host`]: one refused address refuses
/// the host, since a program that resolves the name again may pick that
/// one. For a program nauvi starts (the local scanner, #572), which
/// resolves the name itself: best effort, as its answer can differ (DNS
/// rebinding). A name that does not resolve passes: the program then says
/// it cannot reach it.
pub async fn check_resolved<R, F>(
    authority: &str,
    allow_loopback: bool,
    resolve: R,
) -> Result<(), String>
where
    R: FnOnce(String) -> F,
    F: std::future::Future<Output = std::io::Result<Vec<IpAddr>>>,
{
    check_host(authority, allow_loopback)?;
    let (host, _) = split_host(authority)?;
    if host.parse::<IpAddr>().is_ok() || legacy_ipv4(&host).is_some() {
        return Ok(());
    }
    let Ok(addrs) = resolve(host).await else {
        return Ok(());
    };
    match addrs
        .into_iter()
        .find_map(|a| ip_refused(a, allow_loopback))
    {
        Some(why) => Err(format!(
            "nauvi does not contact {}: it resolves to {why}.",
            shown(authority)
        )),
        None => Ok(()),
    }
}

/// The system resolver, for [`check_resolved`].
pub async fn system_resolve(host: String) -> std::io::Result<Vec<IpAddr>> {
    Ok(tokio::net::lookup_host((host.as_str(), 0))
        .await?
        .map(|a| a.ip())
        .collect())
}

/// The address `inet_aton` (and so `getaddrinfo`) reads in `host` where
/// Rust reads none: one to four parts, each decimal, octal (`0177`) or hex
/// (`0x7f`), the last one filling the bytes left (`127.1` is 127.0.0.1).
/// `None` for anything else.
fn legacy_ipv4(host: &str) -> Option<Ipv4Addr> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let num = |p: &str| -> Option<u64> {
        let (digits, radix) = match p.strip_prefix("0x").or_else(|| p.strip_prefix("0X")) {
            Some(h) => (h, 16),
            None if p.len() > 1 && p.starts_with('0') => (&p[1..], 8),
            None => (p, 10),
        };
        if digits.is_empty() {
            // `0x` alone is 0 to inet_aton; an empty part is no number.
            return (radix == 16).then_some(0);
        }
        if digits.len() > 16 || !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        u64::from_str_radix(digits, radix).ok()
    };
    let nums: Vec<u64> = parts.iter().map(|p| num(p)).collect::<Option<_>>()?;
    let (last, head) = nums.split_last()?;
    if head.iter().any(|n| *n > 255) {
        return None;
    }
    let rest_bits = 8 * (4 - head.len() as u32);
    if *last >= 1u64 << rest_bits {
        return None;
    }
    let v = head.iter().fold(0u64, |v, n| (v << 8) | n);
    Some(Ipv4Addr::from(((v << rest_bits) | last) as u32))
}

/// AWS's instance metadata over IPv6 (Nitro): not link-local, so named.
const AWS_METADATA_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254);

/// Alibaba Cloud's instance metadata: in the shared address space
/// (100.64.0.0/10), not link-local, so named.
const ALIBABA_METADATA: Ipv4Addr = Ipv4Addr::new(100, 100, 100, 200);

/// Why nauvi does not connect to `ip` as a registry (`None`: it may).
pub(crate) fn ip_refused(ip: IpAddr, allow_loopback: bool) -> Option<&'static str> {
    if ip == IpAddr::V6(AWS_METADATA_V6) {
        return Some("a cloud metadata endpoint");
    }
    match ip {
        IpAddr::V6(v6) => match embedded_v4(v6) {
            Some(v4) => v4_refused(v4, allow_loopback),
            None => {
                let local = nat64_local_v4(v6);
                // A position that reads 0.0.0.0 is the zeros around the
                // address at another one; all of them 0.0.0.0 is refused.
                if !local.is_empty() && local.iter().all(|v4| v4.is_unspecified()) {
                    return v4_refused(Ipv4Addr::UNSPECIFIED, allow_loopback);
                }
                local
                    .into_iter()
                    .filter(|v4| !v4.is_unspecified())
                    .find_map(|v4| v4_refused(v4, allow_loopback))
                    .or_else(|| plain_refused(ip, allow_loopback))
            }
        },
        IpAddr::V4(v4) => v4_refused(v4, allow_loopback),
    }
}

fn v4_refused(v4: Ipv4Addr, allow_loopback: bool) -> Option<&'static str> {
    if v4 == ALIBABA_METADATA {
        return Some("a cloud metadata endpoint");
    }
    plain_refused(IpAddr::V4(v4), allow_loopback)
}

fn plain_refused(ip: IpAddr, allow_loopback: bool) -> Option<&'static str> {
    if ip.is_loopback() {
        return (!allow_loopback).then_some("this machine (a loopback address)");
    }
    if ip.is_unspecified()
        || ip.is_multicast()
        || is_link_local(ip)
        || ip == IpAddr::V4(Ipv4Addr::BROADCAST)
    {
        return Some("a link-local, multicast or unspecified address");
    }
    None
}

/// The IPv4 address an IPv6 one stands for, so it is checked as that:
/// IPv4-mapped (`::ffff:a.b.c.d`), NAT64 (`64:ff9b::a.b.c.d`, RFC 6052) and
/// IPv4-compatible (`::a.b.c.d`, deprecated; not `::` or `::1`).
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = v6.segments();
    let [.., a, b, c, d] = v6.octets();
    let last = Ipv4Addr::new(a, b, c, d);
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return Some(last);
    }
    if s[..6] == [0; 6] && !v6.is_unspecified() && !v6.is_loopback() {
        return Some(last);
    }
    None
}

/// The IPv4 addresses an address of the NAT64 local-use prefix
/// `64:ff9b:1::/48` (RFC 8215) may stand for. Its operator picks the prefix
/// length (/48 to /96) and nauvi cannot tell which, so every RFC 6052
/// position that fits under it is checked: /48, /56, /64 (around the
/// reserved octet 8) and /96. Empty for any other address.
fn nat64_local_v4(v6: Ipv6Addr) -> Vec<Ipv4Addr> {
    if v6.segments()[..3] != [0x64, 0xff9b, 1] {
        return Vec::new();
    }
    let o = v6.octets();
    vec![
        Ipv4Addr::new(o[6], o[7], o[9], o[10]),
        Ipv4Addr::new(o[7], o[9], o[10], o[11]),
        Ipv4Addr::new(o[9], o[10], o[11], o[12]),
        Ipv4Addr::new(o[12], o[13], o[14], o[15]),
    ]
}

fn is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80 || v6 == Ipv6Addr::UNSPECIFIED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> ImageRef {
        ImageRef::parse(s).unwrap()
    }

    #[test]
    fn short_and_full_forms_for_the_image_column() {
        let r = |s: &str| ImageRef::parse(s).unwrap();
        assert_eq!(r("mongo:7.0.1").short(), "mongo:7.0.1");
        assert_eq!(r("docker.io/library/mongo:7.0.1").short(), "mongo:7.0.1");
        assert_eq!(r("bitnami/redis:7").short(), "redis:7");
        assert_eq!(r("nginx").short(), "nginx:latest");
        assert_eq!(
            r("registry.k8s.io/kube-apiserver:v1.30.0").short(),
            "kube-apiserver:v1.30.0"
        );
        let d = format!("sha256:{}", "4f".repeat(32));
        assert_eq!(
            r(&format!("ghcr.io/org/app@{d}")).short(),
            "app@sha256:4f4f4f4f4f4f"
        );
        assert_eq!(r(&format!("ghcr.io/org/app:1@{d}")).short(), "app:1");
        assert_eq!(r("mongo:7.0.1").full(), "docker.io/library/mongo:7.0.1");
        assert_eq!(
            r(&format!("ghcr.io/org/app:1@{d}")).full(),
            format!("ghcr.io/org/app:1@{d}")
        );
    }

    #[test]
    fn parses_references_like_docker() {
        let m = p("mongo:7.0.1");
        assert_eq!(
            (m.registry.as_str(), m.repository.as_str(), m.tag.as_str()),
            ("docker.io", "library/mongo", "7.0.1")
        );
        assert_eq!(m.name(), "mongo");
        assert_eq!(p("mongo").tag, "latest");
        assert_eq!(p("bitnami/redis:7").repository, "bitnami/redis");
        assert_eq!(p("docker.io/library/nginx:1.27").shown(), "nginx:1.27");
        assert_eq!(p("index.docker.io/library/nginx").registry, "docker.io");
        let g = p("ghcr.io/org/team/app:v1.2.3-alpine");
        assert_eq!(
            (g.registry.as_str(), g.repository.as_str(), g.tag.as_str()),
            ("ghcr.io", "org/team/app", "v1.2.3-alpine")
        );
        let local = p("registry.example.com:5000/app:1.0");
        assert_eq!(local.registry, "registry.example.com:5000");
        assert_eq!(local.repository, "app");
        let d = format!("sha256:{}", "a".repeat(64));
        let pinned = p(&format!("quay.io/org/app:1.0@{d}"));
        assert_eq!(
            (pinned.tag.as_str(), pinned.digest.as_str()),
            ("1.0", d.as_str())
        );
        let only = p(&format!("quay.io/org/app@{d}"));
        assert_eq!(only.tag, "");
        assert_eq!(only.shown(), format!("quay.io/org/app@{d}"));
        assert_eq!(p("[::1]:5000/app:1").registry, "[::1]:5000");
    }

    #[test]
    fn refuses_what_could_leave_the_url_path() {
        for bad in [
            "",
            "Mongo:1",
            "a/../b:1",
            "mongo:7?x",
            "mongo:-1",
            "mongo@sha256:abc",
            "evil.com/a%2f..:1",
            "evil.com:99999/a:1",
            "evil.com:/a:1",
            "ev il.com/a",
            "evil.com/a b",
            "evil.com/a#b",
            "-evil.com/a",
        ] {
            assert!(ImageRef::parse(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(ImageRef::parse(&"a".repeat(600)).is_err());
    }

    #[test]
    fn nat64_and_ipv4_compatible_forms_are_checked_as_ipv4() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for bad in [
            "64:ff9b::7f00:1", // NAT64 127.0.0.1
            "64:ff9b::127.0.0.1",
            "64:ff9b::a9fe:a9fe", // NAT64 169.254.169.254 (metadata)
            "::127.0.0.1",        // IPv4-compatible loopback
            "::169.254.169.254",
            "::ffff:169.254.169.254",
            "::1",
            "::",
        ] {
            assert!(ip_refused(ip(bad), false).is_some(), "{bad} was allowed");
            assert!(
                check_host(&format!("[{bad}]:443"), false).is_err(),
                "[{bad}]"
            );
        }
        assert!(ip_refused(ip("64:ff9b::7f00:1"), false)
            .unwrap()
            .contains("loopback"));
        assert!(ip_refused(ip("::169.254.169.254"), true)
            .unwrap()
            .contains("link-local"));
        for ok in ["64:ff9b::8.8.8.8", "::8.8.8.8", "2001:db8::1"] {
            assert_eq!(ip_refused(ip(ok), false), None, "{ok}");
        }
    }

    #[test]
    fn nat64_local_use_prefix_is_checked_at_every_prefix_length() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for bad in [
            "64:ff9b:1::7f00:1",          // /96: 127.0.0.1
            "64:ff9b:1::169.254.169.254", // /96: metadata
            "64:ff9b:1:7f00:0:100::",     // /48: 127.0.0.1 (octets 6-7, 9-10)
            "64:ff9b:1:a9:fe:a9fe::",     // /56: 169.254.169.254
            "64:ff9b:1:0:7f:0:100:0",     // /64: 127.0.0.1 (octets 9-12)
            "64:ff9b:1::100.100.100.200", // /96: Alibaba metadata
            "64:ff9b:1::",                // /96: 0.0.0.0
        ] {
            assert!(ip_refused(ip(bad), false).is_some(), "{bad} was allowed");
            assert!(
                check_host(&format!("[{bad}]:443"), false).is_err(),
                "[{bad}]"
            );
        }
        assert!(ip_refused(ip("64:ff9b:1::7f00:1"), false)
            .unwrap()
            .contains("loopback"));
        assert_eq!(ip_refused(ip("64:ff9b:1::7f00:1"), true), None);
        for ok in [
            "64:ff9b:1::8.8.8.8",    // /96: 8.8.8.8
            "64:ff9b:1:808:8:800::", // /48: 8.8.8.8
            "64:ff9b:2::7f00:1",     // outside the /48
        ] {
            assert_eq!(ip_refused(ip(ok), false), None, "{ok}");
        }
    }

    #[test]
    fn alibaba_metadata_is_refused() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for bad in [
            "100.100.100.200",
            "::ffff:100.100.100.200",
            "64:ff9b::100.100.100.200",
        ] {
            let why = ip_refused(ip(bad), true).unwrap();
            assert!(why.contains("metadata"), "{bad}: {why}");
        }
        assert!(check_host("100.100.100.200", true)
            .unwrap_err()
            .contains("a cloud metadata endpoint"));
        // Its neighbours in the shared address space are ordinary.
        assert_eq!(ip_refused(ip("100.100.100.201"), false), None);
        assert_eq!(ip_refused(ip("100.64.0.1"), false), None);
    }

    #[test]
    fn host_checks_refuse_this_machine_and_link_local() {
        for ok in [
            "ghcr.io",
            "registry.example.com:5000",
            "10.0.0.5:5000",
            "192.168.1.2",
            "[2001:db8::1]:443",
        ] {
            assert_eq!(check_host(ok, false), Ok(()), "{ok}");
        }
        for bad in [
            "localhost:5000",
            "foo.localhost",
            "127.0.0.1",
            "127.1.2.3:443",
            "[::1]:5000",
            "[::ffff:127.0.0.1]",
            "169.254.169.254",
            "[fe80::1]",
            "0.0.0.0",
            "[::]",
            "224.0.0.1",
            "255.255.255.255",
            "metadata.google.internal",
            "metadata",
        ] {
            assert!(check_host(bad, false).is_err(), "{bad} was allowed");
        }
        assert_eq!(check_host("127.0.0.1:5443", true), Ok(()));
        assert!(check_host("169.254.169.254", true).is_err());
        for junk in ["", "a..b", "a_b.com", "[::1", "x:0", "x:+1", "[nothost]:1"] {
            assert!(check_host(junk, false).is_err(), "{junk:?}");
        }
    }

    #[test]
    fn short_and_numeric_ipv4_forms_are_checked_as_addresses() {
        for bad in [
            "127.1",
            "127.1:2375",
            "127.0.1",
            "0x7f.1",
            "0177.0.0.1",
            "2130706433",
            "0x7f000001",
            "169.254.43518", // 169.254.169.254
            "0",
            "0.0",
        ] {
            assert!(check_host(bad, false).is_err(), "{bad} was allowed");
        }
        assert!(check_host("127.1", false).unwrap_err().contains("loopback"));
        assert_eq!(legacy_ipv4("127.1"), Some(Ipv4Addr::new(127, 0, 0, 1)));
        assert_eq!(legacy_ipv4("10.1.2"), Some(Ipv4Addr::new(10, 1, 0, 2)));
        assert_eq!(legacy_ipv4("0xa.0x1"), Some(Ipv4Addr::new(10, 0, 0, 1)));
        for not in [
            "ghcr.io",
            "1e100.net",
            "08.1",
            "1.2.3.4.5",
            "256.1",
            "1.2.3.256",
            "1.16777216",
            "4294967296",
            "a.b",
            "",
        ] {
            assert_eq!(legacy_ipv4(not), None, "{not}");
        }
        assert_eq!(check_host("10.1:5000", false), Ok(()));
        assert_eq!(check_host("127.1", true), Ok(()));
    }

    #[test]
    fn aws_ipv6_metadata_is_refused() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for bad in ["fd00:ec2::254", "FD00:EC2:0::254"] {
            let why = ip_refused(ip(bad), true).unwrap();
            assert!(why.contains("metadata"), "{bad}: {why}");
        }
        assert!(check_host("[fd00:ec2::254]:80", true)
            .unwrap_err()
            .contains("a cloud metadata endpoint"));
        // Its neighbours are ordinary unique-local addresses.
        assert_eq!(ip_refused(ip("fd00:ec2::253"), false), None);
        assert_eq!(ip_refused(ip("fd00::254"), false), None);
    }

    /// A fake resolver: no network in unit tests.
    fn answers(
        addrs: &'static [&'static str],
    ) -> impl FnOnce(String) -> std::future::Ready<std::io::Result<Vec<IpAddr>>> {
        move |_| std::future::ready(Ok(addrs.iter().map(|a| a.parse().unwrap()).collect()))
    }

    #[tokio::test]
    async fn names_that_resolve_to_this_machine_or_metadata_are_refused() {
        let e = check_resolved("127.0.0.1.nip.io:8080", false, answers(&["127.0.0.1"]))
            .await
            .unwrap_err();
        assert_eq!(
            e,
            "nauvi does not contact 127.0.0.1.nip.io:8080: it resolves to this machine (a \
             loopback address)."
        );
        // One bad address among good ones is enough.
        let e = check_resolved(
            "evil.example.com",
            false,
            answers(&["140.82.112.3", "fd00:ec2::254"]),
        )
        .await
        .unwrap_err();
        assert!(e.contains("a cloud metadata endpoint"), "{e}");
        let e = check_resolved("x.example.com", false, answers(&["169.254.169.254"]))
            .await
            .unwrap_err();
        assert!(e.contains("link-local"), "{e}");
        // Allowed.
        check_resolved("ghcr.io", false, answers(&["140.82.112.3", "2001:db8::1"]))
            .await
            .unwrap();
        check_resolved("localhost:5443", true, answers(&["127.0.0.1"]))
            .await
            .unwrap();
        // A name that does not resolve: the scanner says so itself.
        check_resolved("nowhere.example", false, |_| {
            std::future::ready(Err(std::io::Error::other("no such host")))
        })
        .await
        .unwrap();
        // The host checks come first, and a literal is not resolved.
        let never =
            |_: String| -> std::future::Ready<std::io::Result<Vec<IpAddr>>> { panic!("resolved") };
        assert!(check_resolved("127.1:2375", false, never).await.is_err());
        check_resolved("10.0.0.5:5000", false, never).await.unwrap();
        check_resolved("10.1:5000", false, never).await.unwrap();
    }

    #[test]
    fn running_digest_only_from_the_same_repository() {
        let d = format!("sha256:{}", "b".repeat(64));
        let busybox = p("busybox:1.36");
        assert_eq!(
            running_digest(&busybox, &format!("docker.io/library/busybox@{d}")),
            Some(d.clone())
        );
        assert_eq!(
            running_digest(&busybox, &format!("docker-pullable://busybox@{d}")),
            Some(d.clone())
        );
        assert_eq!(
            running_digest(&busybox, &d),
            None,
            "a bare image id is the config digest"
        );
        assert_eq!(
            running_digest(
                &busybox,
                &format!("docker.io/library/import-2026-08-26@{d}")
            ),
            None
        );
        assert_eq!(running_digest(&busybox, ""), None);
        assert_eq!(
            running_digest(&busybox, "docker.io/library/busybox@sha256:short"),
            None
        );
    }
}
