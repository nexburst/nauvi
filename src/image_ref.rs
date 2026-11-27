//! Container image references (`mongo:7.0.1`, `ghcr.io/org/app@sha256:…`)
//! split into registry, repository, tag and digest, the way the container
//! runtime reads them.
//!
//! Used by the tables' Image column (#547), and meant for anything else that
//! reasons about images (available tags, #539).
//!
//! - The first part of the name is a registry when it has a `.` or a `:`,
//!   or is `localhost`, and more parts follow; else the registry is
//!   `docker.io`, and a one-part name there is under `library/`.
//! - The tag follows the last `:` after the last `/`; the digest follows
//!   `@`. A reference with neither is pulled as `latest`.

/// The registry of a reference without one.
pub const DEFAULT_REGISTRY: &str = "docker.io";

/// A parsed image reference. Empty `tag` or `digest`: not given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// `docker.io`, `ghcr.io`, `localhost:5000`.
    pub registry: String,
    /// `library/mongo`, `org/app`.
    pub repository: String,
    pub tag: String,
    /// `sha256:…`.
    pub digest: String,
}

impl ImageRef {
    /// Parse `reference` (spaces around it are ignored). Never fails: text
    /// that is not a valid reference still splits somewhere sensible.
    pub fn parse(reference: &str) -> ImageRef {
        let reference = reference.trim();
        let (name, digest) = match reference.split_once('@') {
            Some((n, d)) => (n, d.to_string()),
            None => (reference, String::new()),
        };
        let slash = name.rfind('/').map_or(0, |i| i + 1);
        let (name, tag) = match name[slash..].rfind(':') {
            Some(i) => (&name[..slash + i], name[slash + i + 1..].to_string()),
            None => (name, String::new()),
        };
        let (registry, repository) = match name.split_once('/') {
            Some((first, rest))
                if first.contains('.') || first.contains(':') || first == "localhost" =>
            {
                (first.to_string(), rest.to_string())
            }
            _ => (DEFAULT_REGISTRY.to_string(), name.to_string()),
        };
        let repository = if registry == DEFAULT_REGISTRY && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository
        };
        ImageRef {
            registry,
            repository,
            tag,
            digest,
        }
    }

    /// The tag pulled: the one given, or `latest` when there is neither a
    /// tag nor a digest. Empty for a digest without a tag.
    pub fn tag_or_latest(&self) -> &str {
        if self.tag.is_empty() && self.digest.is_empty() {
            "latest"
        } else {
            &self.tag
        }
    }

    /// The repository as people write it: without `docker.io/library/`
    /// (`mongo`), with the rest of the path (`bitnami/redis`).
    pub fn display_repository(&self) -> &str {
        if self.registry == DEFAULT_REGISTRY {
            self.repository
                .strip_prefix("library/")
                .unwrap_or(&self.repository)
        } else {
            &self.repository
        }
    }

    /// What a table cell shows: the last part of the repository and the
    /// tag (`mongo:7.0.1`, `app:latest`), or the start of the digest when
    /// there is no tag (`app@sha256:4f3c2b1a0d9e`).
    pub fn short(&self) -> String {
        let repo = self.display_repository();
        let last = repo.rsplit('/').next().unwrap_or(repo);
        let tag = self.tag_or_latest();
        if !tag.is_empty() {
            return format!("{last}:{tag}");
        }
        let digest: String = self.digest.chars().take("sha256:".len() + 12).collect();
        format!("{last}@{digest}")
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

/// The digest of a container status's `imageID`
/// (`docker.io/library/mongo@sha256:…`, `docker-pullable://…@sha256:…`,
/// or a bare `sha256:…`), if it has one.
pub fn digest_of_image_id(image_id: &str) -> Option<&str> {
    let d = image_id.rsplit('@').next()?;
    let (algo, hex) = d.split_once(':')?;
    let algo_ok = !algo.is_empty() && algo.chars().all(|c| c.is_ascii_alphanumeric());
    let hex_ok = hex.len() >= 32 && hex.chars().all(|c| c.is_ascii_hexdigit());
    (algo_ok && hex_ok).then_some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(r: &str) -> (String, String, String, String) {
        let i = ImageRef::parse(r);
        (i.registry, i.repository, i.tag, i.digest)
    }

    #[test]
    fn splits_registry_repository_tag_and_digest() {
        let s = |a: &str| a.to_string();
        assert_eq!(
            parts("mongo:7.0.1"),
            (s("docker.io"), s("library/mongo"), s("7.0.1"), s(""))
        );
        assert_eq!(
            parts("bitnami/redis"),
            (s("docker.io"), s("bitnami/redis"), s(""), s(""))
        );
        assert_eq!(
            parts("ghcr.io/org/team/app:v2@sha256:abc"),
            (s("ghcr.io"), s("org/team/app"), s("v2"), s("sha256:abc"))
        );
        assert_eq!(
            parts("localhost:5000/app"),
            (s("localhost:5000"), s("app"), s(""), s(""))
        );
        assert_eq!(
            parts("localhost/app:1"),
            (s("localhost"), s("app"), s("1"), s(""))
        );
        // A port is not a tag.
        assert_eq!(
            parts("registry.local:5000/team/app"),
            (s("registry.local:5000"), s("team/app"), s(""), s(""))
        );
        assert_eq!(
            parts("docker.io/library/nginx:1.27"),
            parts("nginx:1.27"),
            "the same image written in full"
        );
        assert_eq!(
            parts("  app@sha256:ff "),
            (s("docker.io"), s("library/app"), s(""), s("sha256:ff"))
        );
    }

    #[test]
    fn short_and_full_forms() {
        let short = |r: &str| ImageRef::parse(r).short();
        assert_eq!(short("mongo:7.0.1"), "mongo:7.0.1");
        assert_eq!(short("docker.io/library/mongo:7.0.1"), "mongo:7.0.1");
        assert_eq!(short("bitnami/redis:7"), "redis:7");
        assert_eq!(
            short("registry.k8s.io/kube-apiserver:v1.30.0"),
            "kube-apiserver:v1.30.0"
        );
        assert_eq!(short("nginx"), "nginx:latest");
        assert_eq!(
            short("ghcr.io/org/app@sha256:4f3c2b1a0d9e8f7a6b5c"),
            "app@sha256:4f3c2b1a0d9e"
        );
        assert_eq!(short("ghcr.io/org/app:1@sha256:4f3c"), "app:1");

        let full = |r: &str| ImageRef::parse(r).full();
        assert_eq!(full("mongo:7.0.1"), "docker.io/library/mongo:7.0.1");
        assert_eq!(full("nginx"), "docker.io/library/nginx");
        assert_eq!(
            full("ghcr.io/org/app:1@sha256:4f"),
            "ghcr.io/org/app:1@sha256:4f"
        );
        assert_eq!(
            ImageRef::parse("bitnami/redis").display_repository(),
            "bitnami/redis"
        );
        assert_eq!(ImageRef::parse("mongo").display_repository(), "mongo");
        assert_eq!(ImageRef::parse("app@sha256:1").tag_or_latest(), "");
    }

    #[test]
    fn digest_of_a_status_image_id() {
        let d = format!("sha256:{}", "ab".repeat(32));
        assert_eq!(
            digest_of_image_id(&format!("docker.io/library/mongo@{d}")),
            Some(d.as_str())
        );
        assert_eq!(
            digest_of_image_id(&format!("docker-pullable://mongo@{d}")),
            Some(d.as_str())
        );
        assert_eq!(digest_of_image_id(&d), Some(d.as_str()));
        assert_eq!(digest_of_image_id("mongo:7"), None);
        assert_eq!(digest_of_image_id(""), None);
        assert_eq!(digest_of_image_id("docker.io/library/mongo:7"), None);
    }
}
