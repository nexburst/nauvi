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
    if let Ok(ip) = host.parse::<IpAddr>() {
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

/// Why nauvi does not connect to `ip` as a registry (`None`: it may).
pub(crate) fn ip_refused(ip: IpAddr, allow_loopback: bool) -> Option<&'static str> {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    };
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
