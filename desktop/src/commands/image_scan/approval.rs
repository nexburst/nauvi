//! Which scanner binary the user approved (#536), like the login commands
//! of added kubeconfigs (#201): kept in `image-scanner.json` in the app's
//! config folder, one per scanner, by [`Fingerprint`] (path, size, time,
//! SHA-256). A binary that changed in any of them is asked about again.

use nauvi::image_security::cache::write_private;
use nauvi::image_security::local::{Fingerprint, ScannerKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    scanner: ScannerKind,
    binary: Fingerprint,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    approved: Vec<Entry>,
}

/// The approval file in `config_dir`.
pub(crate) fn path_in(config_dir: &Path) -> PathBuf {
    config_dir.join("image-scanner.json")
}

fn load(path: &Path) -> File {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(path: &Path, f: &File) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    write_private(path, &serde_json::to_vec_pretty(f).unwrap_or_default())
        .map_err(|e| format!("Could not save the approval in {}: {e}", path.display()))
}

/// The binary approved for `scanner`, if any.
pub(crate) fn approved(path: &Path, scanner: ScannerKind) -> Option<Fingerprint> {
    load(path)
        .approved
        .into_iter()
        .find(|e| e.scanner == scanner)
        .map(|e| e.binary)
}

/// Approve `binary` for `scanner` (replacing an earlier one).
pub(crate) fn approve(
    path: &Path,
    scanner: ScannerKind,
    binary: Fingerprint,
) -> Result<(), String> {
    let mut f = load(path);
    f.approved.retain(|e| e.scanner != scanner);
    f.approved.push(Entry { scanner, binary });
    save(path, &f)
}

/// Forget the approval of `scanner`.
pub(crate) fn forget(path: &Path, scanner: ScannerKind) -> Result<(), String> {
    let mut f = load(path);
    let before = f.approved.len();
    f.approved.retain(|e| e.scanner != scanner);
    if f.approved.len() == before {
        return Ok(());
    }
    save(path, &f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(path: &str, sha: &str) -> Fingerprint {
        Fingerprint {
            path: path.into(),
            size: 1,
            modified: 2,
            sha256: sha.into(),
        }
    }

    #[test]
    fn one_per_scanner_and_forgotten() {
        let dir = std::env::temp_dir().join(format!("nauvi-536-approval-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = path_in(&dir);
        assert_eq!(approved(&p, ScannerKind::Trivy), None);
        approve(&p, ScannerKind::Trivy, fp("/a/trivy", "1")).unwrap();
        approve(&p, ScannerKind::Grype, fp("/a/grype", "2")).unwrap();
        approve(&p, ScannerKind::Trivy, fp("/b/trivy", "3")).unwrap();
        assert_eq!(approved(&p, ScannerKind::Trivy), Some(fp("/b/trivy", "3")));
        assert_eq!(approved(&p, ScannerKind::Grype), Some(fp("/a/grype", "2")));
        forget(&p, ScannerKind::Trivy).unwrap();
        assert_eq!(approved(&p, ScannerKind::Trivy), None);
        assert!(approved(&p, ScannerKind::Grype).is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // A broken file is no approval.
        std::fs::write(&p, "{").unwrap();
        assert_eq!(approved(&p, ScannerKind::Grype), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
