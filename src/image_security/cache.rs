//! The local scanner's results on disk (#536): one file per scanner and
//! image digest, holding the scanner's and its database's versions and the
//! platform. A scan is reused only while all of them still match
//! ([`CachedScan::fresh_for`]); the listing shows the newest one either
//! way, with its age.
//!
//! The folder and its files are readable only by the user. It holds at
//! most [`MAX_ENTRIES`] scans; older ones go first.

use super::local::{is_digest, ScannerKind};
use super::trivy_operator::safe_link;
use super::{Severity, SeverityCounts, Vulnerability};
use crate::text::single_line;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Scans kept.
pub const MAX_ENTRIES: usize = 500;
/// A cache file larger than this is not read.
const MAX_FILE: u64 = 64 * 1024 * 1024;

/// One vulnerability as kept on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedVuln {
    pub id: String,
    pub package: String,
    pub installed_version: String,
    pub fixed_version: String,
    pub severity: Severity,
    pub score: f64,
    pub title: String,
    pub link: String,
}

/// One scan of one image digest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedScan {
    pub scanner: ScannerKind,
    pub scanner_version: String,
    /// The scanner's database version (when it was built).
    pub db_version: String,
    /// `linux/amd64`, empty for the scanner's default.
    pub platform: String,
    pub digest: String,
    /// The reference that was scanned (`docker.io/library/nginx@sha256:…`).
    pub reference: String,
    /// Unix seconds.
    pub scanned_at: i64,
    pub vulnerabilities: Vec<CachedVuln>,
}

impl CachedScan {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        scanner: ScannerKind,
        scanner_version: &str,
        db_version: &str,
        platform: &str,
        digest: &str,
        reference: &str,
        scanned_at: i64,
        vulns: &[Vulnerability],
    ) -> Self {
        CachedScan {
            scanner,
            scanner_version: scanner_version.to_string(),
            db_version: db_version.to_string(),
            platform: platform.to_string(),
            digest: digest.to_string(),
            reference: reference.to_string(),
            scanned_at,
            vulnerabilities: vulns
                .iter()
                .map(|v| CachedVuln {
                    id: v.id.clone(),
                    package: v.package.clone(),
                    installed_version: v.installed_version.clone(),
                    fixed_version: v.fixed_version.clone(),
                    severity: v.severity,
                    score: v.score,
                    title: v.title.clone(),
                    link: v.link.clone(),
                })
                .collect(),
        }
    }

    /// Its vulnerabilities, cleaned again (the file could have been
    /// edited).
    pub fn vulnerabilities(&self) -> Vec<Vulnerability> {
        self.vulnerabilities
            .iter()
            .map(|v| Vulnerability {
                id: single_line(&v.id),
                package: single_line(&v.package),
                installed_version: single_line(&v.installed_version),
                fixed_version: single_line(&v.fixed_version),
                severity: v.severity,
                score: if v.score.is_finite() { v.score } else { 0.0 },
                title: single_line(&v.title),
                link: safe_link(&v.link),
            })
            .collect()
    }

    /// All counts, and those with a fix.
    pub fn counts(&self) -> (SeverityCounts, SeverityCounts) {
        let mut all = SeverityCounts::default();
        let mut fixable = SeverityCounts::default();
        for v in &self.vulnerabilities {
            all.add(v.severity);
            if !v.fixed_version.trim().is_empty() {
                fixable.add(v.severity);
            }
        }
        (all, fixable)
    }

    /// `Trivy 0.58.1`.
    pub fn scanner_text(&self) -> String {
        single_line(&format!(
            "{} {}",
            self.scanner.label(),
            self.scanner_version
        ))
    }

    /// Whether this scan can stand for a new one: same scanner version,
    /// database and platform.
    pub fn fresh_for(&self, scanner_version: &str, db_version: &str, platform: &str) -> bool {
        self.scanner_version == scanner_version
            && self.db_version == db_version
            && self.platform == platform
    }
}

/// The folder of scans.
#[derive(Debug, Clone)]
pub struct ScanCache {
    dir: PathBuf,
}

impl ScanCache {
    pub fn new(dir: PathBuf) -> Self {
        ScanCache { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self, scanner: ScannerKind, digest: &str) -> Option<PathBuf> {
        let hex = digest.strip_prefix("sha256:").filter(|_| is_digest(digest))?;
        Some(self.dir.join(format!("{}-{hex}.json", scanner.binary())))
    }

    /// The newest scan of `digest` by `scanner`, if any.
    pub fn get(&self, scanner: ScannerKind, digest: &str) -> Option<CachedScan> {
        let path = self.file(scanner, digest)?;
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MAX_FILE {
            return None;
        }
        let scan: CachedScan = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
        (scan.digest == digest && scan.scanner == scanner).then_some(scan)
    }

    /// Keep `scan` (replacing the one of its digest), then drop the oldest
    /// beyond [`MAX_ENTRIES`].
    pub fn put(&self, scan: &CachedScan) -> std::io::Result<()> {
        let Some(path) = self.file(scan.scanner, &scan.digest) else {
            return Err(std::io::Error::other("not a sha256 digest"));
        };
        create_private_dir(&self.dir)?;
        write_private(&path, &serde_json::to_vec(scan).unwrap_or_default())?;
        self.prune(MAX_ENTRIES);
        Ok(())
    }

    fn prune(&self, keep: usize) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        if files.len() <= keep {
            return;
        }
        files.sort();
        let extra = files.len() - keep;
        for (_, p) in files.into_iter().take(extra) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// `dir` (and its parents), the last one readable only by the user.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write `bytes` to `path` through a temp file renamed over it, readable
/// only by the user.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    {
        let mut f = options.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(c: char) -> String {
        format!("sha256:{}", c.to_string().repeat(64))
    }

    fn vuln(id: &str, sev: Severity, fixed: &str) -> Vulnerability {
        Vulnerability {
            id: id.into(),
            package: "openssl".into(),
            installed_version: "1".into(),
            fixed_version: fixed.into(),
            severity: sev,
            score: 7.0,
            title: "t".into(),
            link: "https://example.com".into(),
        }
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nauvi-536-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn kept_by_scanner_and_digest_and_fresh_by_versions() {
        let d = dir("keep");
        let cache = ScanCache::new(d.join("scans"));
        let vulns = [
            vuln("CVE-1", Severity::Critical, "2"),
            vuln("CVE-2", Severity::High, ""),
        ];
        let scan = CachedScan::new(
            ScannerKind::Trivy,
            "0.58.1",
            "2026-11-25",
            "linux/amd64",
            &digest('a'),
            "docker.io/library/nginx@sha256:aaa",
            100,
            &vulns,
        );
        assert!(cache.get(ScannerKind::Trivy, &digest('a')).is_none());
        cache.put(&scan).unwrap();
        let got = cache.get(ScannerKind::Trivy, &digest('a')).unwrap();
        assert_eq!(got, scan);
        assert_eq!(got.vulnerabilities(), vulns);
        let (all, fix) = got.counts();
        assert_eq!((all.critical, all.high, fix.critical, fix.high), (1, 1, 1, 0));
        assert_eq!(got.scanner_text(), "Trivy 0.58.1");
        assert!(got.fresh_for("0.58.1", "2026-11-25", "linux/amd64"));
        assert!(!got.fresh_for("0.58.1", "2026-11-26", "linux/amd64"), "a newer DB");
        assert!(!got.fresh_for("0.58.2", "2026-11-25", "linux/amd64"));
        assert!(!got.fresh_for("0.58.1", "2026-11-25", "linux/arm64"));
        // Another scanner, another digest: nothing.
        assert!(cache.get(ScannerKind::Grype, &digest('a')).is_none());
        assert!(cache.get(ScannerKind::Trivy, &digest('b')).is_none());
        // Not a digest: never a path.
        assert!(cache.get(ScannerKind::Trivy, "../../etc/passwd").is_none());
        assert!(cache.get(ScannerKind::Trivy, "sha256:../x").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&d.join("scans")), 0o700);
            let file = d.join("scans").join(format!("trivy-{}.json", "a".repeat(64)));
            assert_eq!(mode(&file), 0o600);
        }
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_file_of_another_digest_is_not_taken() {
        let d = dir("swap");
        let cache = ScanCache::new(d.clone());
        let scan = CachedScan::new(ScannerKind::Grype, "0.84.0", "", "", &digest('c'), "r", 1, &[]);
        cache.put(&scan).unwrap();
        // Renamed to another digest's name: refused.
        std::fs::rename(
            d.join(format!("grype-{}.json", "c".repeat(64))),
            d.join(format!("grype-{}.json", "d".repeat(64))),
        )
        .unwrap();
        assert!(cache.get(ScannerKind::Grype, &digest('d')).is_none());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn the_oldest_go_first() {
        let d = dir("prune");
        let cache = ScanCache::new(d.clone());
        for (i, c) in ['1', '2', '3', '4'].into_iter().enumerate() {
            let scan =
                CachedScan::new(ScannerKind::Trivy, "1", "", "", &digest(c), "r", i as i64, &[]);
            cache.put(&scan).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        cache.prune(2);
        assert!(cache.get(ScannerKind::Trivy, &digest('1')).is_none());
        assert!(cache.get(ScannerKind::Trivy, &digest('2')).is_none());
        assert!(cache.get(ScannerKind::Trivy, &digest('4')).is_some());
        let _ = std::fs::remove_dir_all(d);
    }
}
