//! A scanner's version from where a package manager installed it (#561):
//! for a Trivy whose Go build info names none. Homebrew builds Trivy from
//! its source tarball with `-trimpath` (so the build info has neither a
//! module version nor its `-ldflags`), but installs it in a folder named
//! by its version; so does Nix. Only for a file whose build info names
//! Trivy's module (#573): Grype needs no version before it runs, and a
//! Grype, or any other program, in a `Cellar/trivy` folder is refused by
//! its module, whatever the folder says.
//!
//! Only the path nauvi already resolved (links followed) is read, and only
//! these exact shapes:
//!
//! - Homebrew: `<prefix>/Cellar/trivy/<version>[_N]/bin/trivy` (any prefix:
//!   `/opt/homebrew`, `/usr/local`, `/home/linuxbrew/.linuxbrew`);
//! - Nix: `/nix/store/<32-character hash>-trivy-<version>/bin/trivy`.
//!
//! Versions are digits and dots only (`0.58.1`, Homebrew's `_N` revision
//! dropped).

use std::path::{Component, Path};

/// Where the version came from, as the UI says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Homebrew,
    Nix,
}

impl Store {
    /// `its Homebrew folder`.
    pub fn place(self) -> &'static str {
        match self {
            Store::Homebrew => "its Homebrew folder",
            Store::Nix => "its Nix store path",
        }
    }
}

/// `major.minor.patch`, digits only.
fn strict_version(s: &str) -> Option<&str> {
    let parts: Vec<&str> = s.split('.').collect();
    (parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit())))
    .then_some(s)
}

/// Homebrew's `0.58.1` or `0.58.1_2` (a revision of the same version).
fn homebrew_version(s: &str) -> Option<&str> {
    let (v, rev) = match s.split_once('_') {
        Some((v, rev)) => (v, Some(rev)),
        None => (s, None),
    };
    if let Some(rev) = rev {
        if rev.is_empty() || rev.len() > 4 || !rev.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    strict_version(v)
}

/// Nix's base32 alphabet (no e, o, u, t).
fn nix_hash(s: &str) -> bool {
    s.len() == 32
        && s.bytes().all(
            |b| matches!(b, b'0'..=b'9' | b'a'..=b'd' | b'f'..=b'n' | b'p'..=b's' | b'v'..=b'z'),
        )
}

/// The version of the `program` (`trivy`) at `path`, from a package
/// manager's folder, and which one. `None` for any other path.
pub fn version_from_path(path: &Path, program: &str) -> Option<(String, Store)> {
    let mut parts = Vec::new();
    for c in path.components() {
        match c {
            Component::RootDir | Component::Prefix(_) => parts.clear(),
            Component::Normal(p) => parts.push(p.to_str()?),
            Component::CurDir | Component::ParentDir => return None,
        }
    }
    // `…/<dir>/bin/<program>`.
    let [rest @ .., dir, "bin", name] = parts.as_slice() else {
        return None;
    };
    if *name != program {
        return None;
    }
    if let [.., "Cellar", formula] = rest {
        if *formula == program {
            return homebrew_version(dir).map(|v| (v.to_string(), Store::Homebrew));
        }
    }
    if let ["nix", "store"] = rest {
        let (hash, name) = dir.split_once('-')?;
        let version = name.strip_prefix(program)?.strip_prefix('-')?;
        if nix_hash(hash) {
            return strict_version(version).map(|v| (v.to_string(), Store::Nix));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(p: &str) -> Option<(String, Store)> {
        version_from_path(Path::new(p), "trivy")
    }

    const HASH: &str = "0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn";

    #[test]
    fn homebrew_folders() {
        for prefix in ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"] {
            assert_eq!(
                v(&format!("{prefix}/Cellar/trivy/0.58.1/bin/trivy")),
                Some(("0.58.1".into(), Store::Homebrew)),
                "{prefix}"
            );
        }
        assert_eq!(
            v("/opt/homebrew/Cellar/trivy/0.69.5_1/bin/trivy"),
            Some(("0.69.5".into(), Store::Homebrew))
        );
    }

    #[test]
    fn nix_store_paths() {
        assert_eq!(
            v(&format!("/nix/store/{HASH}-trivy-0.58.1/bin/trivy")),
            Some(("0.58.1".into(), Store::Nix))
        );
    }

    #[test]
    fn lookalikes_do_not_match() {
        for p in [
            // Not Homebrew's shape.
            "/opt/homebrew/Cellar/trivy/0.58.1/libexec/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58.1/bin/sub/trivy",
            "/home/me/Cellar-old/trivy/0.58.1/bin/trivy",
            "/home/me/Cellar/0.58.1/bin/trivy",
            "/opt/homebrew/Cellar/trivy-evil/0.58.1/bin/trivy",
            "/opt/homebrew/Cellar/other/0.58.1/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58.1/bin/trivy-evil",
            "/opt/homebrew/Cellar/trivy/HEAD-abc123/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58.1.2/bin/trivy",
            "/opt/homebrew/Cellar/trivy/v0.58.1/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58.1-rc1/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58.1_/bin/trivy",
            "/opt/homebrew/Cellar/trivy/0.58.1_a/bin/trivy",
            "/opt/homebrew/Cellar/trivy/../trivy/0.58.1/bin/trivy",
            "Cellar/trivy/0.58.1/bin/trivy-x",
            // Not Nix's.
            "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4h-trivy-0.58.1/bin/trivy",
            "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hnn-trivy-0.58.1/bin/trivy",
            "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4he-trivy-0.58.1/bin/trivy",
            "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivy-evil-0.58.1/bin/trivy",
            "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivyx-0.58.1/bin/trivy",
            "/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivy-0.58.1-bin/bin/trivy",
            "/home/me/nix/store/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivy-0.58.1/bin/trivy",
            "/nix/store/x/0c3dk1fz9jq2gv8a6yx5zqr7mfbwl4hn-trivy-0.58.1/bin/trivy",
            // Neither.
            "/usr/local/bin/trivy",
            "/home/me/go/bin/trivy",
            "/opt/trivy-0.58.1/bin/trivy",
        ] {
            assert_eq!(v(p), None, "{p}");
        }
        // Another program's folder is not Trivy's.
        assert_eq!(
            version_from_path(
                Path::new("/opt/homebrew/Cellar/trivy/0.58.1/bin/trivy"),
                "grype"
            ),
            None
        );
    }
}
