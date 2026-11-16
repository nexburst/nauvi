//! The files behind the catalog: the default kubeconfig paths, the
//! kubeconfig files in a folder, pasted kubeconfigs and a fingerprint to
//! notice changes.

use crate::errors::chain_text;
use anyhow::{anyhow, bail, Context as _, Result};
use kube::config::Kubeconfig;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Files in a folder source larger than this are not kubeconfigs.
const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024;

/// The default kubeconfig files: those in `KUBECONFIG`, else
/// `~/.kube/config`, as kubectl reads them.
pub fn default_kubeconfig_paths() -> Vec<PathBuf> {
    let from_env: Vec<PathBuf> = std::env::var_os("KUBECONFIG")
        .map(|v| {
            std::env::split_paths(&v)
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if !from_env.is_empty() {
        return from_env;
    }
    home::home_dir()
        .map(|h| vec![h.join(".kube").join("config")])
        .unwrap_or_default()
}

/// `~` or `~/…` at the start of `path` is the home directory.
pub fn expand_home(path: &str) -> PathBuf {
    let path = path.trim();
    let rest = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"))
    };
    match (rest, home::home_dir()) {
        (Some(""), Some(home)) => home,
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// The files of a folder source, by name: regular files, not hidden, not
/// too large to be a kubeconfig. Subfolders are not read.
pub fn folder_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| {
            std::fs::metadata(e.path())
                .map(|m| m.is_file() && m.len() <= MAX_FILE_SIZE)
                .unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    Ok(files)
}

/// What is wrong with `path` as a new source (`Ok`: a readable kubeconfig
/// file with contexts, or a folder).
pub fn check_source(path: &Path) -> Result<()> {
    let meta =
        std::fs::metadata(path).map_err(|e| anyhow!("cannot add {}: {e}", path.display()))?;
    if meta.is_dir() {
        std::fs::read_dir(path)
            .map_err(|e| anyhow!("cannot read the folder {}: {e}", path.display()))?;
        return Ok(());
    }
    let kc = Kubeconfig::read_from(path).map_err(|e| {
        anyhow!(
            "{} is not a kubeconfig file: {}",
            path.display(),
            chain_text(&e)
        )
    })?;
    if kc.contexts.is_empty() {
        bail!("{} has no contexts", path.display());
    }
    Ok(())
}

/// Save a pasted kubeconfig in `dir` (created if needed) as a new file only
/// the user can read (`0600`), and return its path. `name` names the file
/// (default: the first context). Fails, writing nothing, unless the text
/// is a kubeconfig with at least one context.
pub fn save_pasted_kubeconfig(dir: &Path, yaml: &str, name: &str) -> Result<PathBuf> {
    let kc = Kubeconfig::from_yaml(yaml)
        .map_err(|e| anyhow!("The pasted text is not a kubeconfig: {}", chain_text(&e)))?;
    let Some(first) = kc.contexts.first() else {
        bail!("The pasted kubeconfig has no contexts.");
    };
    let base = slug(if name.trim().is_empty() {
        &first.name
    } else {
        name
    });
    create_private_dir(dir)?;
    for n in 1..1000 {
        let file = if n == 1 {
            format!("{base}.yaml")
        } else {
            format!("{base}-{n}.yaml")
        };
        let path = dir.join(file);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = match options.open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).with_context(|| format!("cannot save {}", path.display())),
        };
        f.write_all(yaml.as_bytes())
            .and_then(|()| f.sync_all())
            .with_context(|| format!("cannot save {}", path.display()))?;
        return Ok(path);
    }
    bail!(
        "cannot save the kubeconfig in {}: too many files",
        dir.display()
    )
}

fn create_private_dir(dir: &Path) -> Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .with_context(|| format!("cannot create {}", dir.display()))
}

/// A file name from `name`: letters, digits, `-`, `_` and `.`; at most 60.
fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .take(60)
        .collect();
    let s = s.trim_matches(|c| c == '-' || c == '.').to_string();
    if s.is_empty() {
        "kubeconfig".to_string()
    } else {
        s
    }
}

/// Changes when any of the files (or, for folders, their entries) is
/// added, removed, resized or touched.
pub fn sources_fingerprint(paths: &[PathBuf]) -> u64 {
    let mut h = DefaultHasher::new();
    for path in paths {
        path.hash(&mut h);
        stamp(path, &mut h);
        if path.is_dir() {
            for f in folder_files(path).unwrap_or_default() {
                f.hash(&mut h);
                stamp(&f, &mut h);
            }
        }
    }
    h.finish()
}

fn stamp(path: &Path, h: &mut DefaultHasher) {
    match std::fs::metadata(path) {
        Ok(m) => {
            m.len().hash(h);
            m.modified().ok().hash(h);
        }
        Err(_) => 0u8.hash(h),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_file_names() {
        assert_eq!(
            slug("arn:aws:eks:eu-west-1:1:cluster/prod"),
            "arn-aws-eks-eu-west-1-1-cluster-prod"
        );
        assert_eq!(slug("../.."), "kubeconfig");
        assert_eq!(slug(""), "kubeconfig");
        assert_eq!(slug("kind-dev"), "kind-dev");
    }

    #[test]
    fn home_is_expanded() {
        let home = home::home_dir().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/k/a.yaml"), home.join("k/a.yaml"));
        assert_eq!(expand_home(" /etc/kc "), PathBuf::from("/etc/kc"));
        assert_eq!(expand_home("~other/x"), PathBuf::from("~other/x"));
    }
}
