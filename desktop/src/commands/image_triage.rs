//! Ignores and known exploited vulnerabilities (#537, ADR 0011 amendment).
//!
//! - The ignores: nauvi's own (Settings → Image security, each with a
//!   scope and a reason) and the lines of a `.trivyignore` the user points
//!   to, read when a listing is made.
//! - CISA's KEV catalogue: downloaded only while its setting is on (off by
//!   default), from `www.cisa.gov` only, over https, with no proxy and no
//!   redirect to another host, at most 16 MB. Nothing about the clusters or
//!   images is sent: it is one static file. A compact copy is kept in the
//!   app's cache folder and downloaded again when a listing is made a day
//!   later. Debug builds only: `NAUVI_KEV_URL` (an `https://` URL) and
//!   `NAUVI_KEV_CA` (a PEM file, then the only CA trusted) point it at the
//!   QA scenario's local server.

use super::image_scan::ScanDirs;
use crate::kubectl_fetch::HttpsFetch;
use crate::settings::{ImageSecuritySettings, SettingsStore};
use nauvi::image_security::ignore::{parse_trivyignore, IgnoreFile, MAX_FILE};
use nauvi::image_security::kev::{self, KevCatalog, KEV_HOST, KEV_URL};
use nauvi::image_security::triage::Triage;
use nauvi::kubectl_download::DownloadBase;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

pub(crate) const URL_ENV: &str = "NAUVI_KEV_URL";
pub(crate) const CA_ENV: &str = "NAUVI_KEV_CA";

/// The folder of the kept catalogue, in the app's cache folder.
const KEV_FOLDER: &str = "known-exploited";

/// Where the catalogue is kept.
pub(crate) fn kev_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join(KEV_FOLDER))
        .map_err(|e| format!("cannot find the app's cache folder: {e}"))
}

/// [`kev_dir`] next to the local scans' folder (`image-scans`).
pub(crate) fn kev_dir_of(dirs: &ScanDirs) -> PathBuf {
    dirs.cache
        .parent()
        .map_or_else(|| dirs.cache.join(KEV_FOLDER), |p| p.join(KEV_FOLDER))
}

/// One download at a time; after a failed one, none for an hour (a
/// listing is made often, the catalogue changes once a day).
static DOWNLOAD: tokio::sync::Mutex<Option<std::time::Instant>> =
    tokio::sync::Mutex::const_new(None);
const RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(3600);

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// The ignore file's ignores, or why it cannot be read.
fn read_ignore_file(path: &str) -> Result<IgnoreFile, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!(
            "The ignore file {path} is not a full path; choose it again."
        ));
    }
    let meta =
        std::fs::metadata(p).map_err(|e| format!("Cannot read the ignore file {path}: {e}."))?;
    if !meta.is_file() {
        return Err(format!("The ignore file {path} is not a file."));
    }
    if meta.len() > MAX_FILE {
        return Err(format!(
            "The ignore file {path} is larger than 1 MB; it was not read."
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Cannot read the ignore file {path}: {e}."))?;
    let name = p
        .file_name()
        .map_or(".trivyignore".into(), |n| n.to_string_lossy().into_owned());
    Ok(parse_trivyignore(&String::from_utf8_lossy(&bytes), &name))
}

/// What a listing of cluster `context` applies, and the notes it shows
/// (an ignore file that cannot be read).
pub(crate) fn triage_for(
    s: &ImageSecuritySettings,
    context: &str,
    kev_dir: Option<&Path>,
) -> (Triage, Vec<String>) {
    let mut notes = Vec::new();
    let mut rules = s.ignores.clone();
    if !s.ignore_file.is_empty() {
        match read_ignore_file(&s.ignore_file) {
            Ok(f) => rules.extend(f.rules),
            Err(e) => notes.push(e),
        }
    }
    let kev = match (s.kev_download, kev_dir) {
        (true, Some(dir)) => kev::load(dir).map(|c| c.ids()).unwrap_or_default(),
        _ => Default::default(),
    };
    let triage = Triage {
        rules,
        kev,
        context: context.to_string(),
        now: now(),
    };
    (triage, notes)
}

/// The catalogue's address: KEV_URL, or in a debug build `URL_ENV`'s, with
/// `CA_ENV`'s CA.
fn source_from(
    debug: bool,
    url: Option<String>,
    ca: Option<std::ffi::OsString>,
) -> Result<(DownloadBase, String, Option<Vec<u8>>), String> {
    let url = url.filter(|u| debug && !u.trim().is_empty());
    let Some(url) = url else {
        let base = DownloadBase::parse(&format!("https://{KEV_HOST}"))?;
        return Ok((base, KEV_URL.to_string(), None));
    };
    let url = url.trim().to_string();
    let origin = url
        .strip_prefix("https://")
        .map(|rest| rest.split('/').next().unwrap_or_default())
        .ok_or_else(|| format!("{URL_ENV} must be an https:// address."))?;
    let base =
        DownloadBase::parse(&format!("https://{origin}")).map_err(|e| format!("{URL_ENV}: {e}"))?;
    let ca = match ca.filter(|c| !c.is_empty()) {
        Some(path) => Some(
            std::fs::read(&path)
                .map_err(|e| format!("{CA_ENV}: cannot read {}: {e}", path.to_string_lossy()))?,
        ),
        None => None,
    };
    Ok((base, url, ca))
}

/// Download the catalogue now and keep it in `dir`.
async fn download_kev(dir: &Path) -> Result<KevCatalog, String> {
    let (base, url, ca) = source_from(
        cfg!(debug_assertions),
        std::env::var(URL_ENV).ok(),
        std::env::var_os(CA_ENV),
    )?;
    let fetch = HttpsFetch::new(&base, None, ca.as_deref())?;
    tracing::info!("downloading the KEV catalogue from {url}");
    kev::download(&fetch, &url, dir, now()).await
}

/// Before a listing: download the catalogue when it is on and the kept one
/// is missing or a day old. A failure is a note; the old copy stays.
pub(crate) async fn refresh_kev(s: &ImageSecuritySettings, dir: Option<&Path>) -> Option<String> {
    let dir = dir.filter(|_| s.kev_download)?;
    if kev::load(dir).is_some_and(|c| !c.stale(now())) {
        return None;
    }
    let mut failed = DOWNLOAD.lock().await;
    // Another listing may have downloaded it meanwhile.
    let kept = kev::load(dir);
    if kept.as_ref().is_some_and(|c| !c.stale(now())) {
        return None;
    }
    if failed.is_some_and(|t| t.elapsed() < RETRY_AFTER) {
        return None;
    }
    let result = download_kev(dir).await;
    *failed = result.is_err().then(std::time::Instant::now);
    match result {
        Ok(_) => None,
        Err(e) => Some(match kept {
            Some(c) => format!(
                "Could not update the list of known exploited vulnerabilities ({e}); using the \
                 one of {}.",
                c.version
            ),
            None => format!(
                "Could not download the list of known exploited vulnerabilities: {e}"
            ),
        }),
    }
}

/// What Settings → Image security shows about the ignores and the
/// catalogue.
#[derive(Debug, Clone, Default, serde::Serialize, specta::Type)]
pub(crate) struct TriageStatus {
    /// The ignore file's ignores (0 without a file).
    pub(crate) file_rules: u32,
    /// Why the ignore file cannot be read, empty when it can (or none is
    /// set).
    pub(crate) file_error: String,
    /// Its lines that were not understood (at most 20).
    pub(crate) file_skipped: Vec<String>,
    /// A catalogue is kept (and used while the setting is on).
    pub(crate) kev_kept: bool,
    /// `2026.11.25`.
    pub(crate) kev_version: String,
    /// How many vulnerabilities it lists.
    pub(crate) kev_count: u32,
    /// When it was downloaded (unix seconds), 0 when none is kept.
    pub(crate) kev_fetched_at: i64,
    /// The address it comes from.
    pub(crate) kev_url: String,
}

fn status_of(s: &ImageSecuritySettings, dir: Option<&Path>) -> TriageStatus {
    let mut out = TriageStatus {
        kev_url: KEV_URL.to_string(),
        ..Default::default()
    };
    if !s.ignore_file.is_empty() {
        match read_ignore_file(&s.ignore_file) {
            Ok(f) => {
                out.file_rules = f.rules.len() as u32;
                out.file_skipped = f.skipped;
            }
            Err(e) => out.file_error = e,
        }
    }
    if let Some(c) = dir.and_then(kev::load) {
        out.kev_kept = true;
        out.kev_version = c.version;
        out.kev_count = c.entries.len() as u32;
        out.kev_fetched_at = c.fetched_at;
    }
    out
}

/// The ignore file's state and the kept catalogue. Reads only local files.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_image_triage_status(
    app: AppHandle,
    settings: State<'_, Arc<SettingsStore>>,
) -> TriageStatus {
    let dir = kev_dir(&app).ok();
    status_of(&settings.get().image_security, dir.as_deref())
}

/// Download the catalogue now (Settings → Image security). Refused while
/// its setting is off.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_kev_update(
    app: AppHandle,
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<TriageStatus, String> {
    let s = settings.get().image_security;
    if !s.kev_download {
        return Err(
            "Downloading the list of known exploited vulnerabilities is off. Turn it on in \
             Settings → Image security first."
                .into(),
        );
    }
    let dir = kev_dir(&app)?;
    let mut failed = DOWNLOAD.lock().await;
    let result = download_kev(&dir).await;
    *failed = result.is_err().then(std::time::Instant::now);
    result?;
    Ok(status_of(&s, Some(&dir)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_only_use_cisa() {
        let (base, url, ca) = source_from(
            false,
            Some("https://127.0.0.1:8443/kev.json".into()),
            Some("/nonexistent.pem".into()),
        )
        .unwrap();
        assert_eq!(base.host(), KEV_HOST);
        assert_eq!(url, KEV_URL);
        assert!(ca.is_none());
    }

    #[test]
    fn the_debug_override_is_https_only() {
        let (base, url, _) =
            source_from(true, Some("https://127.0.0.1:8443/kev.json".into()), None).unwrap();
        assert_eq!(base.host(), "127.0.0.1");
        assert_eq!(url, "https://127.0.0.1:8443/kev.json");
        assert!(source_from(true, Some("http://127.0.0.1/kev.json".into()), None).is_err());
        assert!(source_from(true, Some("https://u:p@h/kev.json".into()), None).is_err());
    }

    #[test]
    fn an_ignore_file_is_read_and_its_problems_said() {
        let dir = std::env::temp_dir().join(format!("nauvi-537-ign-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".trivyignore");
        std::fs::write(&file, "# not used\nCVE-2026-1001\nbad line here\n").unwrap();
        let mut s = ImageSecuritySettings {
            ignore_file: file.display().to_string(),
            ..Default::default()
        };
        let (t, notes) = triage_for(&s, "kind", None);
        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(t.rules.len(), 1);
        assert_eq!(t.rules[0].reason, "not used");
        assert!(t.kev.is_empty(), "off: no catalogue");
        let st = status_of(&s, None);
        assert_eq!(st.file_rules, 1);
        assert_eq!(st.file_skipped.len(), 1);
        assert!(!st.kev_kept);

        s.ignore_file = dir.join("missing").display().to_string();
        let (_, notes) = triage_for(&s, "kind", None);
        assert!(notes[0].starts_with("Cannot read the ignore file"), "{notes:?}");
        s.ignore_file = "relative/.trivyignore".into();
        assert!(status_of(&s, None).file_error.contains("not a full path"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn nothing_is_downloaded_while_it_is_off() {
        let dir = std::env::temp_dir().join(format!("nauvi-537-kevoff-{}", std::process::id()));
        let s = ImageSecuritySettings::default();
        assert!(refresh_kev(&s, Some(&dir)).await.is_none());
        assert!(!dir.exists(), "nothing was written");
    }
}
