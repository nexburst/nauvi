//! Scanning images with a Trivy or Grype the user installed (#536, ADR
//! 0011): a separate opt-in (Settings → Image security → Source) next to
//! the Trivy Operator's reports.
//!
//! - nauvi never downloads a scanner or a database. The binary (from
//!   `NAUVI_TRIVY`/`NAUVI_GRYPE` or `PATH`) runs only once the user
//!   approved it ([`approval`]); a changed binary is asked about again,
//!   and known malicious releases are refused, also after an approval:
//!   first from the Go build info in the file, before anything of it runs
//!   (Trivy 0.69.4 to 0.69.6 ran their payload even for `version`; a
//!   Trivy whose file names no version is refused too), then
//!   by the version it prints. Nothing of the binary runs before the
//!   approval (not even `version`), and an approval is of the SHA-256 the
//!   user was shown.
//! - Only an image of the listing can be scanned: the reference and digest
//!   come from the pods (untrusted), checked by `local::scan_target`, and
//!   the registry's addresses by `local::check_target_resolves`. The
//!   scanner's file and approval are checked once more right before it
//!   runs (`still_approved`).
//! - One scan at a time in the whole app, cancellable
//!   ([`cmd_image_scan_cancel`]); the child is killed when the scan is
//!   dropped. A scan of every image is the UI calling this one image after
//!   another, only after a click.
//! - Results are kept on disk (the app's cache folder, `image-scans/`) by
//!   scanner and digest, reused while the scanner's and its database's
//!   versions and the platform match.

mod approval;

use super::image_security::{listing, remember_scan, triage_of};
use crate::settings::SettingsStore;
use crate::state::Cluster;
use nauvi::image_security::cache::{create_private_dir, CachedScan, ScanCache};
use nauvi::image_security::go_buildinfo::BuildInfo;
use nauvi::image_security::local::{
    self, file_version_note, find_binary, inspect, refused_build, refused_version, scan_target,
    Fingerprint, ScanOptions, ScannerKind, ScannerVersion,
};
use nauvi::image_security::running::{platform_of, triaged_detail_of_scan};
use nauvi::image_security::triage::Triage;
use nauvi::image_security::{ImageDetail, ImageVulns, VulnsArgs, VulnsSummary};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

/// Where the scanner's approval and results are kept.
#[derive(Debug, Clone)]
pub(crate) struct ScanDirs {
    /// `image-scanner.json` (the approvals) goes here.
    pub(crate) config: PathBuf,
    /// `image-scans/`: the results, and `work/`, the scanner's folder.
    pub(crate) cache: PathBuf,
}

impl ScanDirs {
    pub(crate) fn of(app: &AppHandle) -> Result<Self, String> {
        let config = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("cannot find the app's config folder: {e}"))?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("cannot find the app's cache folder: {e}"))?
            .join("image-scans");
        Ok(Self { config, cache })
    }

    fn approvals(&self) -> PathBuf {
        approval::path_in(&self.config)
    }

    fn results(&self) -> ScanCache {
        ScanCache::new(self.cache.clone())
    }

    /// An empty folder of nauvi's own to run the scanner in, so no
    /// `trivy.yaml` of another folder applies.
    fn work(&self) -> Result<PathBuf, String> {
        let dir = self.cache.join("work");
        create_private_dir(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        Ok(dir)
    }
}

/// What Settings → Image security shows about the scanner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScannerState {
    /// Not on `PATH` and no `NAUVI_TRIVY`/`NAUVI_GRYPE`.
    NotInstalled,
    /// Found, not approved yet.
    Unapproved,
    /// Another binary than the one approved (path or content).
    Changed,
    /// Approved and its version read.
    Ready,
    /// A version nauvi does not run (the approval was dropped).
    Refused,
    /// Approved, but `version` failed.
    Broken,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub(crate) struct ScannerStatus {
    pub(crate) scanner: ScannerKind,
    pub(crate) state: ScannerState,
    /// The binary found, empty when none.
    pub(crate) path: String,
    /// `NAUVI_TRIVY` when it named the path, else `PATH`.
    pub(crate) from: String,
    /// The path approved earlier, when it is another binary.
    pub(crate) approved_path: String,
    /// Read only once approved.
    pub(crate) version: String,
    /// When its database was built, empty when it has none.
    pub(crate) db: String,
    /// What to do, or what is wrong; when ready, where nauvi read its
    /// version if not from its build info (`Version 0.58.1 from its
    /// Homebrew folder.`), else empty.
    pub(crate) message: String,
    /// The file found, so the user sees what they approve:
    /// `48.2 MB, SHA-256 1a2b3c4d5e6f…` (empty when none was read).
    pub(crate) file: String,
    /// The file's full SHA-256 (empty when none was read): the approval
    /// sends it back, so only the file shown can be approved.
    pub(crate) sha256: String,
}

/// Fingerprints by (path, size, time), so a 100 MB binary is hashed again
/// only when it changed; versions by SHA-256.
#[derive(Default)]
struct Known {
    fingerprints: HashMap<FileKey, Inspected>,
    versions: HashMap<String, ScannerVersion>,
}

static KNOWN: Mutex<Option<Known>> = Mutex::new(None);

fn with_known<T>(f: impl FnOnce(&mut Known) -> T) -> T {
    let mut k = KNOWN.lock().unwrap();
    f(k.get_or_insert_with(Known::default))
}

/// What must be unchanged for a file's hash to be reused. On Unix the
/// inode and the change time too: a write can keep the size and set the
/// modification time back, but not the change time, and a swap gives
/// another inode.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FileKey {
    path: String,
    size: u64,
    modified: (i64, u32),
    #[cfg(unix)]
    unix: (u64, u64, i64, i64),
}

/// The key of `path`; `None` where nothing safe is known (Windows: the
/// file is hashed every time).
fn file_key(path: &Path, meta: &std::fs::Metadata) -> Option<FileKey> {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or((0, 0), |d| (d.as_secs() as i64, d.subsec_nanos()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileKey {
            path: path.display().to_string(),
            size: meta.len(),
            modified,
            unix: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = (path, modified);
        None
    }
}

/// A file's fingerprint and the Go build info in it.
#[derive(Debug, Clone)]
struct Inspected {
    fp: Fingerprint,
    build: Option<BuildInfo>,
}

async fn inspect_of(path: &Path) -> Result<Inspected, String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let key = file_key(path, &meta);
    if let Some(known) = key
        .as_ref()
        .and_then(|key| with_known(|k| k.fingerprints.get(key).cloned()))
    {
        return Ok(known);
    }
    let p = path.to_path_buf();
    let (fp, build) = tokio::task::spawn_blocking(move || inspect(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    let known = Inspected { fp, build };
    if let Some(key) = key {
        with_known(|k| k.fingerprints.insert(key, known.clone()));
    }
    Ok(known)
}

#[cfg(test)]
async fn fingerprint_of(path: &Path) -> Result<Fingerprint, String> {
    inspect_of(path).await.map(|i| i.fp)
}

/// Why `found` must not run, from its file alone (a Trivy whose file names
/// no version is refused too).
fn refused_file(scanner: ScannerKind, found: &Inspected) -> Option<String> {
    refused_build(scanner, found.build.as_ref(), Path::new(&found.fp.path))
}

/// What the approval says when the file is not the one shown.
pub(crate) const CHANGED_SINCE_SHOWN: &str = "The file changed since it was shown. Check again.";

fn status(scanner: ScannerKind, state: ScannerState) -> ScannerStatus {
    ScannerStatus {
        scanner,
        state,
        path: String::new(),
        from: String::new(),
        approved_path: String::new(),
        version: String::new(),
        db: String::new(),
        message: String::new(),
        file: String::new(),
        sha256: String::new(),
    }
}

/// `48.2 MB, SHA-256 1a2b3c4d5e6f…`.
pub(crate) fn file_text(fp: &Fingerprint) -> String {
    let size = fp.size as f64;
    let size = if size >= 1024.0 * 1024.0 {
        format!("{:.1} MB", size / (1024.0 * 1024.0))
    } else if size >= 1024.0 {
        format!("{:.1} KB", size / 1024.0)
    } else {
        format!("{} bytes", fp.size)
    };
    let short: String = fp.sha256.chars().take(12).collect();
    format!("{size}, SHA-256 {short}…")
}

/// The scanner found, whether it is approved, and (only then) its version.
/// With `fresh_version`, the version is asked again (a scan may have
/// updated the database).
pub(crate) async fn scanner_status(
    dirs: &ScanDirs,
    scanner: ScannerKind,
    fresh_version: bool,
) -> (ScannerStatus, Option<PathBuf>) {
    let path = match find_binary(scanner) {
        Ok(p) => p,
        Err(message) => {
            let mut s = status(scanner, ScannerState::NotInstalled);
            s.message = message;
            return (s, None);
        }
    };
    let mut s = status(scanner, ScannerState::Unapproved);
    s.path = path.display().to_string();
    s.from = if std::env::var_os(scanner.env_var()).is_some_and(|v| !v.is_empty()) {
        scanner.env_var().to_string()
    } else {
        "PATH".to_string()
    };
    let found = match inspect_of(&path).await {
        Ok(found) => found,
        Err(e) => {
            s.state = ScannerState::Broken;
            s.message = e;
            return (s, None);
        }
    };
    s.file = file_text(&found.fp);
    s.sha256 = found.fp.sha256.clone();
    // Before the approval is even looked at: such a file never runs.
    if let Some(why) = refused_file(scanner, &found) {
        let _ = approval::forget(&dirs.approvals(), scanner);
        s.state = ScannerState::Refused;
        s.message = why;
        return (s, None);
    }
    // Where its version was read, when not from its build info (#561).
    let note = file_version_note(scanner, found.build.as_ref(), Path::new(&found.fp.path));
    let fp = found.fp;
    let Some(ok) = approval::approved(&dirs.approvals(), scanner) else {
        s.message = format!(
            "nauvi runs {} only once you approve this file.",
            scanner.binary()
        );
        return (s, None);
    };
    if ok != fp {
        s.state = ScannerState::Changed;
        s.approved_path = ok.path.clone();
        s.message = if ok.path == fp.path {
            format!(
                "{} changed since you approved it (an update?). Approve it again to use it.",
                s.path
            )
        } else {
            format!(
                "You approved {}, but {} is the one found now. Approve it to use it.",
                ok.path, s.path
            )
        };
        return (s, None);
    }
    let cached = with_known(|k| k.versions.get(&fp.sha256).cloned());
    let version = match cached.filter(|_| !fresh_version) {
        Some(v) => v,
        None => {
            let read = match dirs.work() {
                Ok(work) => local::scanner_version(scanner, &path, &work)
                    .await
                    .map_err(|e| nauvi::error_text(&e)),
                Err(e) => Err(e),
            };
            match read {
                Ok(v) => {
                    with_known(|k| k.versions.insert(fp.sha256.clone(), v.clone()));
                    v
                }
                Err(e) => {
                    s.state = ScannerState::Broken;
                    s.message = e;
                    return (s, None);
                }
            }
        }
    };
    s.version = version.version.clone();
    s.db = version.db.clone();
    if let Some(why) = refused_version(scanner, &version.version) {
        // Never again without a new question.
        let _ = approval::forget(&dirs.approvals(), scanner);
        s.state = ScannerState::Refused;
        s.message = why;
        return (s, None);
    }
    s.state = ScannerState::Ready;
    s.message = note.unwrap_or_default();
    (s, Some(path))
}

/// The scanner of Settings → Image security: where it is, whether it is
/// approved, and its version once it is. Runs nothing before an approval.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_scanner_status(
    app: AppHandle,
    scanner: ScannerKind,
) -> Result<ScannerStatus, String> {
    let dirs = ScanDirs::of(&app)?;
    Ok(scanner_status(&dirs, scanner, false).await.0)
}

/// Approve the binary at `path` with the SHA-256 the prompt showed
/// (`sha256`, from [`ScannerStatus`]) for `scanner`: it must be the one
/// found now, unchanged (the UI cannot approve another file). Returns the
/// new status (a refused version is not kept).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_scanner_approve(
    app: AppHandle,
    scanner: ScannerKind,
    path: String,
    sha256: String,
) -> Result<ScannerStatus, String> {
    let dirs = ScanDirs::of(&app)?;
    approve(&dirs, scanner, &path, &sha256).await
}

pub(crate) async fn approve(
    dirs: &ScanDirs,
    scanner: ScannerKind,
    path: &str,
    sha256: &str,
) -> Result<ScannerStatus, String> {
    let found = find_binary(scanner)?;
    if found.display().to_string() != path {
        return Err(format!(
            "{path} is not the {} nauvi finds now ({}). Check Settings again.",
            scanner.binary(),
            found.display()
        ));
    }
    let file = inspect_of(&found).await?;
    if sha256.is_empty() || !file.fp.sha256.eq_ignore_ascii_case(sha256) {
        return Err(CHANGED_SINCE_SHOWN.to_string());
    }
    if refused_file(scanner, &file).is_none() {
        approval::approve(&dirs.approvals(), scanner, file.fp)?;
    }
    let (s, _) = scanner_status(dirs, scanner, true).await;
    Ok(s)
}

/// Forget the approval of `scanner`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_scanner_forget(
    app: AppHandle,
    scanner: ScannerKind,
) -> Result<ScannerStatus, String> {
    let dirs = ScanDirs::of(&app)?;
    approval::forget(&dirs.approvals(), scanner)?;
    Ok(scanner_status(&dirs, scanner, false).await.0)
}

/// The scan that runs, if any: one at a time in the whole app.
static RUNNING: Mutex<Option<(String, Arc<Notify>)>> = Mutex::new(None);

/// Holds the one scan slot until dropped.
struct Slot;

impl Slot {
    fn take(image: &str) -> Result<(Self, Arc<Notify>), String> {
        let mut r = RUNNING.lock().unwrap();
        if let Some((other, _)) = r.as_ref() {
            return Err(format!(
                "A scan of {other} is running. Wait for it, or cancel it."
            ));
        }
        let cancel = Arc::new(Notify::new());
        *r = Some((image.to_string(), cancel.clone()));
        Ok((Slot, cancel))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        *RUNNING.lock().unwrap() = None;
    }
}

/// Stop the scan that runs (the scanner is killed). Nothing when none runs.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_image_scan_cancel() {
    if let Some((_, cancel)) = RUNNING.lock().unwrap().as_ref() {
        cancel.notify_one();
    }
}

pub(crate) const CANCELLED: &str = "The scan was cancelled.";

/// `work`'s output, unless the scan is cancelled first (then `work` is
/// dropped). A Cancel that came before this is awaited counts too:
/// `notify_one` keeps it.
async fn or_cancelled<T>(
    cancel: &Notify,
    work: impl std::future::Future<Output = T>,
) -> Result<T, String> {
    tokio::select! {
        r = work => Ok(r),
        _ = cancel.notified() => Err(CANCELLED.into()),
    }
}

fn options_of(s: &crate::settings::ImageSecuritySettings) -> ScanOptions {
    ScanOptions {
        db_repository: s.db_repository.clone(),
        skip_db_update: s.skip_db_update,
        server_url: s.server_url.clone(),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Scan one image of the listing of `namespaces` (by its reference and
/// digest as listed) with the approved local scanner, unless a scan of it
/// with the same scanner, database and platform is kept (`refresh` scans
/// again). Returns its findings, filtered by the settings.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_scan(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespaces: Vec<String>,
    image: String,
    digest: String,
    refresh: bool,
) -> Result<ImageDetail, String> {
    let dirs = ScanDirs::of(cluster.app())?;
    let s = settings.get().image_security;
    if !s.source.uses_local() {
        return Err(
            "Scanning on this computer is off. Choose a source with the local scanner in \
             Settings → Image security."
                .into(),
        );
    }
    let list = listing(&cluster, &settings, Some(&dirs), namespaces, false).await?;
    let row = list
        .summary
        .images
        .into_iter()
        .find(|r| r.image == image && r.digest == digest)
        .ok_or_else(|| format!("{image} is no longer in the list; refresh it."))?;
    if !row.running {
        return Err(format!(
            "No pod runs {image} any more: nauvi scans running images only."
        ));
    }
    let (status, path) = scanner_status(&dirs, s.scanner, false).await;
    let Some(path) = path else {
        return Err(match status.state {
            ScannerState::Unapproved => format!(
                "Approve {} in Settings → Image security first.",
                status.path
            ),
            _ => status.message,
        });
    };
    let (_slot, cancel) = Slot::take(&row.image)?;
    let client = cluster.client().await?;
    // Reading the nodes and the registry's lookups can be slow: Cancel
    // stops them too (#583).
    let platform = or_cancelled(&cancel, platform_of(&client, &row)).await?;
    let target = scan_target(&row.image, &row.digest, &platform)?;
    let results = dirs.results();
    let kept = results
        .get(s.scanner, &row.digest)
        .filter(|c| !refresh && c.fresh_for(&status.version, &status.db, &platform));
    let scan = match kept {
        Some(c) => c,
        None => {
            // The registry's addresses (#572): best effort, the scanner
            // resolves the name again.
            or_cancelled(&cancel, local::check_target_resolves(&target)).await??;
            // The file once more, right before it runs (#573): the lookups
            // above took a while.
            let path = still_approved(&dirs, s.scanner, &status, &path).await?;
            let work = dirs.work()?;
            let opts = options_of(&s);
            let run = local::scan(s.scanner, &path, &status.version, &target, &opts, &work);
            let vulns = or_cancelled(&cancel, run)
                .await?
                .map_err(|e| nauvi::error_text(&e))?;
            // The scan may have updated the database.
            let (after, _) = scanner_status(&dirs, s.scanner, true).await;
            let db = if after.db.is_empty() {
                status.db.clone()
            } else {
                after.db
            };
            let scan = CachedScan::new(
                s.scanner,
                &status.version,
                &db,
                &platform,
                &row.digest,
                &target.reference,
                now(),
                &vulns,
            );
            if let Err(e) = results.put(&scan) {
                tracing::warn!("cannot keep the scan of {}: {e}", row.image);
            }
            scan
        }
    };
    remember_scan(&cluster, &scan);
    let (triage, _) = triage_of(&cluster, &s, Some(&dirs)).await;
    Ok(triaged_detail_of_scan(row, &scan, &args_of(&s), &triage))
}

/// The scanner checked again (where it is, its file and its approval) right
/// before it runs: the same file as `before` (at `path`), else why not.
/// Reads only the file (hashed again when it changed): nothing runs.
async fn still_approved(
    dirs: &ScanDirs,
    scanner: ScannerKind,
    before: &ScannerStatus,
    path: &Path,
) -> Result<PathBuf, String> {
    let (now, found) = scanner_status(dirs, scanner, false).await;
    match found {
        Some(p) if p == path && now.sha256 == before.sha256 && now.version == before.version => {
            Ok(p)
        }
        Some(_) => Err(format!(
            "{} changed while the scan was starting. Check Settings → Image security again.",
            scanner.label()
        )),
        None => Err(now.message),
    }
}

pub(crate) fn args_of(s: &crate::settings::ImageSecuritySettings) -> VulnsArgs {
    VulnsArgs {
        namespace: None,
        severity: Some(s.min_severity),
        fixable: s.only_fixable,
    }
}

/// The kept local scans on the rows of `summary` that have no report.
pub(crate) fn overlay(
    dirs: &ScanDirs,
    scanner: ScannerKind,
    summary: &mut VulnsSummary,
    triage: &Triage,
) {
    let results = dirs.results();
    nauvi::image_security::running::overlay_triaged(
        summary,
        |digest| results.get(scanner, digest),
        triage,
    );
}

/// The findings of a row a local scan covers, from the kept scan.
pub(crate) fn kept_detail(
    dirs: &ScanDirs,
    scanner: ScannerKind,
    row: ImageVulns,
    args: &VulnsArgs,
    triage: &Triage,
) -> Result<ImageDetail, String> {
    let scan = dirs.results().get(scanner, &row.digest).ok_or_else(|| {
        format!(
            "The scan of {} is no longer kept; scan it again.",
            row.image
        )
    })?;
    Ok(triaged_detail_of_scan(row, &scan, args, triage))
}

#[cfg(test)]
mod tests;
