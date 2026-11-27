//! Image security (#534, ADR 0011): the images of the namespaces shown
//! with what the Trivy Operator's VulnerabilityReports say about them.
//!
//! Off by default (Settings → Image security, and per cluster). While it
//! is off nothing is read. While it is on, the reports are read when the
//! Image security view, the Overview, a pod or workload panel or the Vulns
//! column is shown (#535): one listing per context, kept in the
//! [`ClusterSession`] (dropped with it, and on an idle disconnect) for
//! `cache_ttl_hours`, which all of them share. No watch, no polling.
//!
//! With a local scanner as a source (#536, `image_scan`), the listing is
//! the pods' images (without the operator, or when it is the only source)
//! and the kept local scans are put on the rows no report covers.

use super::image_scan::{self, ScanDirs};
use crate::settings::image_security::VulnSource;
use crate::settings::SettingsStore;
use crate::state::{Cluster, ClusterSession};
use nauvi::image_security::cache::CachedScan;
use nauvi::image_security::local::ScannerKind;
use nauvi::image_security::running::{apply_scan, running_images};
use nauvi::image_security::{
    image_detail_of, image_vulns_in_namespaces, ImageDetail, ScanSource, VulnsArgs, VulnsState,
    VulnsSummary,
};
use nauvi::resources;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

/// Why nothing is read while it is off.
pub(crate) const OFF: &str = "Image security is off for this cluster. Turn it on in Settings → \
     Image security, or in this cluster's settings.";

/// The last listing of a cluster.
pub(crate) struct VulnsCache {
    /// The namespaces it was made for, sorted (empty: all).
    namespaces: Vec<String>,
    /// The source and scanner it was made with (#536).
    source: VulnSource,
    scanner: ScannerKind,
    at: Instant,
    /// When it was read, unix seconds.
    read_at: i64,
    summary: VulnsSummary,
}

#[cfg(test)]
impl VulnsCache {
    /// A listing of nothing, for tests.
    pub(crate) fn empty() -> Self {
        Self {
            namespaces: Vec::new(),
            source: VulnSource::Cluster,
            scanner: ScannerKind::Trivy,
            at: Instant::now(),
            read_at: 0,
            summary: tests::empty_summary(),
        }
    }
}

/// What the view shows: the listing and when its reports were read.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub(crate) struct ImageSecurityList {
    pub(crate) summary: VulnsSummary,
    /// When nauvi read the reports (unix seconds): the listing may come
    /// from the cache.
    pub(crate) read_at: i64,
}

fn enabled(cluster: &ClusterSession, settings: &SettingsStore) -> bool {
    cluster
        .context_id()
        .is_ok_and(|id| settings.get().image_security_enabled(&id))
}

fn sorted(mut namespaces: Vec<String>) -> Vec<String> {
    namespaces.retain(|n| !n.is_empty());
    namespaces.sort();
    namespaces.dedup();
    namespaces
}

/// The listing of `namespaces`, from the cache while it is younger than
/// the setting's hours (and `refresh` is false). `dirs`: where the local
/// scans are kept (none: they are not shown).
pub(crate) async fn listing(
    cluster: &ClusterSession,
    settings: &SettingsStore,
    dirs: Option<&ScanDirs>,
    namespaces: Vec<String>,
    refresh: bool,
) -> Result<ImageSecurityList, String> {
    if !enabled(cluster, settings) {
        return Err(OFF.to_string());
    }
    let namespaces = sorted(namespaces);
    let s = settings.get().image_security;
    let ttl = Duration::from_secs(u64::from(s.cache_ttl_hours) * 3600);
    if !refresh {
        if let Some(c) = cluster.image_security.lock().unwrap().as_ref() {
            if c.namespaces == namespaces
                && c.source == s.source
                && c.scanner == s.scanner
                && c.at.elapsed() < ttl
            {
                return Ok(ImageSecurityList {
                    summary: c.summary.clone(),
                    read_at: c.read_at,
                });
            }
        }
    }
    let client = cluster.client().await?;
    // Whether the CRD exists comes from the kinds the window discovered.
    let mut kinds = cluster.kinds.lock().unwrap().clone();
    if kinds.is_empty() {
        kinds = resources::discover(&client)
            .await
            .map_err(|e| nauvi::error_text(&e))?;
        *cluster.kinds.lock().unwrap() = kinds.clone();
    }
    let mut summary = if s.source.uses_cluster() {
        image_vulns_in_namespaces(&client, &kinds, &namespaces, &VulnsArgs::default())
            .await
            .map_err(|e| nauvi::error_text(&e))?
    } else {
        empty_local()
    };
    if let (true, Some(dirs)) = (s.source.uses_local(), dirs) {
        // No reports to read (no operator, or not allowed): the pods'
        // images, for the local scanner.
        if matches!(
            summary.state,
            VulnsState::NoOperator | VulnsState::Forbidden
        ) || summary.source == ScanSource::LocalScanner
        {
            let mut notes = std::mem::take(&mut summary.notes);
            if summary.state == VulnsState::Forbidden {
                notes.push(
                    "Not allowed to read the Trivy Operator's reports here: only local scans \
                     are shown."
                        .into(),
                );
            }
            summary = running_images(&client, &namespaces)
                .await
                .map_err(|e| nauvi::error_text(&e))?;
            summary.notes.extend(notes);
        }
        image_scan::overlay(dirs, s.scanner, &mut summary);
        // Images the local scanner can scan: a list, not "not scanned yet".
        if summary.state == VulnsState::NoReports && !summary.images.is_empty() {
            summary.state = VulnsState::Ok;
        }
    }
    let read_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    // Not kept if the window left the cluster meanwhile.
    if !cluster.is_closed() {
        *cluster.image_security.lock().unwrap() = Some(VulnsCache {
            namespaces,
            source: s.source,
            scanner: s.scanner,
            at: Instant::now(),
            read_at,
            summary: summary.clone(),
        });
    }
    Ok(ImageSecurityList { summary, read_at })
}

/// The images running in `namespaces` (none: all namespaces) and the
/// reports about them, unfiltered (the view applies the settings).
/// `refresh` reads the reports again instead of using the cache.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_security_summary(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespaces: Vec<String>,
    refresh: bool,
) -> Result<ImageSecurityList, String> {
    let dirs = ScanDirs::of(cluster.app()).ok();
    listing(&cluster, &settings, dirs.as_ref(), namespaces, refresh).await
}

/// A listing to fill with the pods' images (the local scanner only).
fn empty_local() -> VulnsSummary {
    VulnsSummary {
        source: ScanSource::LocalScanner,
        state: VulnsState::Ok,
        namespace: String::new(),
        namespaces_read: Vec::new(),
        images: Vec::new(),
        forbidden_namespaces: Vec::new(),
        all_namespaces_allowed: false,
        unscanned: 0,
        notes: Vec::new(),
    }
}

/// Put a local scan on its rows of the kept listing (#536), so the view
/// shows it without reading the reports again.
pub(crate) fn remember_scan(cluster: &ClusterSession, scan: &CachedScan) {
    if let Some(c) = cluster.image_security.lock().unwrap().as_mut() {
        let s = &mut c.summary;
        for row in s.images.iter_mut().filter(|r| {
            r.digest == scan.digest && (!r.scanned || r.source == ScanSource::LocalScanner)
        }) {
            apply_scan(row, scan);
        }
        nauvi::image_security::report::sort_rows(&mut s.images);
        s.unscanned = s.images.iter().filter(|r| !r.scanned).count() as u32;
        if s.state == VulnsState::NoReports && s.unscanned < s.images.len() as u32 {
            s.state = VulnsState::Ok;
        }
    }
}

/// One image of the listing of `namespaces` (by its reference and digest
/// as listed) with its newest full report, filtered by the settings'
/// severity and "only fixable".
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_security_image(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespaces: Vec<String>,
    image: String,
    digest: String,
) -> Result<ImageDetail, String> {
    let dirs = ScanDirs::of(cluster.app()).ok();
    let list = listing(&cluster, &settings, dirs.as_ref(), namespaces, false).await?;
    let row = list
        .summary
        .images
        .into_iter()
        .find(|r| r.image == image && r.digest == digest)
        .ok_or_else(|| format!("{image} is no longer in the list; refresh it."))?;
    let s = settings.get().image_security;
    let args = image_scan::args_of(&s);
    if row.source == ScanSource::LocalScanner && row.scanned {
        let dirs = dirs.ok_or("cannot find the app's cache folder")?;
        return image_scan::kept_detail(&dirs, s.scanner, row, &args);
    }
    let client = cluster.client().await?;
    image_detail_of(&client, row, &args)
        .await
        .map_err(|e| nauvi::error_text(&e))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::catalog::KubeconfigSources;
    use crate::settings::ImageSecurityMode;

    /// A session on context `id` of an added kubeconfig in a temp dir.
    fn session(id: &str) -> (ClusterSession, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("nauvi-534-{id}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("kubeconfig.yaml");
        std::fs::write(
            &file,
            format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {{server: \"https://127.0.0.1:1\"}}\nusers:\n- name: u\n  user: {{token: t}}\ncontexts:\n- name: {id}\n  context: {{cluster: c, user: u}}\n"
            ),
        )
        .unwrap();
        let sources = Arc::new(KubeconfigSources::default());
        sources.set_extra(&[file.display().to_string()]);
        (
            ClusterSession::new(id.into(), Some(id.into()), sources),
            dir,
        )
    }

    pub(crate) fn empty_summary() -> VulnsSummary {
        VulnsSummary {
            source: nauvi::image_security::ScanSource::TrivyOperator,
            state: nauvi::image_security::VulnsState::NoReports,
            namespace: String::new(),
            namespaces_read: vec![],
            images: vec![],
            forbidden_namespaces: vec![],
            all_namespaces_allowed: false,
            unscanned: 0,
            notes: vec![],
        }
    }

    /// Off by default: no client is built, nothing is cached. Turned on
    /// for the cluster, the cache answers for the same namespaces.
    #[tokio::test]
    async fn nothing_is_read_while_it_is_off() {
        let (cluster, dir) = session("nauvi-534-on");
        let settings = SettingsStore::open(None);
        let err = listing(&cluster, &settings, None, vec![], false)
            .await
            .unwrap_err();
        assert_eq!(err, OFF);
        assert!(cluster.image_security.lock().unwrap().is_none());

        let id = cluster.context_id().unwrap();
        settings.modify(|s| {
            s.contexts.entry(id.clone()).or_default().image_security = ImageSecurityMode::On;
        });
        *cluster.image_security.lock().unwrap() = Some(VulnsCache {
            namespaces: vec!["a".into(), "b".into()],
            source: VulnSource::Cluster,
            scanner: ScannerKind::Trivy,
            at: Instant::now(),
            read_at: 7,
            summary: empty_summary(),
        });
        let got = listing(
            &cluster,
            &settings,
            None,
            vec!["b".into(), "a".into(), "a".into()],
            false,
        )
        .await
        .unwrap();
        assert_eq!(got.read_at, 7);

        // Off for this cluster although on for the app.
        settings.modify(|s| {
            s.image_security.enabled = true;
            s.contexts.entry(id).or_default().image_security = ImageSecurityMode::Off;
        });
        let err = listing(
            &cluster,
            &settings,
            None,
            vec!["a".into(), "b".into()],
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err, OFF);
        let _ = std::fs::remove_dir_all(dir);
    }
}
