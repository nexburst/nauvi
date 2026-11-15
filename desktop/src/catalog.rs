//! The kubeconfig sources of the cluster catalog (#78): the default
//! kubeconfig plus the files and folders added in the app (kept in
//! Settings), shared by every window's session. A background thread polls
//! them and tells the windows when a file changes.

use kubeloupe::catalog::{
    default_kubeconfig_paths, expand_home, load_catalog, sources_fingerprint, Catalog, CatalogInput,
};
use kubeloupe::ContextTarget;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_specta::Event;

/// How often the files are checked for changes.
const POLL_EVERY: Duration = Duration::from_secs(3);

#[derive(Default)]
pub(crate) struct KubeconfigSources {
    /// The added files and folders, pasted files included, in order.
    extra: Mutex<Vec<PathBuf>>,
    /// Where pasted kubeconfigs are saved (`None`: no config directory).
    pasted_dir: Mutex<Option<PathBuf>>,
}

impl KubeconfigSources {
    /// Set the added sources (paths as saved in Settings; `~` is expanded).
    pub(crate) fn set_extra(&self, paths: &[String]) {
        *self.extra.lock().unwrap() = paths.iter().map(|p| expand_home(p)).collect();
    }

    pub(crate) fn set_pasted_dir(&self, dir: Option<PathBuf>) {
        *self.pasted_dir.lock().unwrap() = dir;
    }

    pub(crate) fn pasted_dir(&self) -> Option<PathBuf> {
        self.pasted_dir.lock().unwrap().clone()
    }

    fn input(&self) -> CatalogInput {
        CatalogInput::here(self.extra.lock().unwrap().clone(), self.pasted_dir())
    }

    /// Every context and source, read from the files now.
    pub(crate) fn catalog(&self) -> Catalog {
        load_catalog(&self.input())
    }

    /// Which file and context the context id `id` connects with (`None`:
    /// the default kubeconfig's current-context).
    pub(crate) fn resolve(&self, id: Option<&str>) -> Result<ContextTarget, String> {
        self.catalog().resolve(id).map_err(|e| e.to_string())
    }

    /// The files and folders whose changes the windows hear about.
    fn watched(&self) -> Vec<PathBuf> {
        let mut paths = default_kubeconfig_paths();
        paths.extend(self.extra.lock().unwrap().iter().cloned());
        paths
    }
}

/// Sent to every window when a kubeconfig source changes (a file edited,
/// added to a folder, or a source added or removed).
#[derive(Debug, Clone, serde::Serialize, specta::Type, tauri_specta::Event)]
pub(crate) struct KubeconfigsChanged {
    pub(crate) generation: u32,
}

/// Tell every window the contexts may have changed.
pub(crate) fn announce(app: &AppHandle) {
    static GENERATION: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let _ = KubeconfigsChanged { generation }.emit(app);
}

/// Poll the sources in the background for as long as the app runs.
pub(crate) fn watch(app: AppHandle, sources: Arc<KubeconfigSources>) {
    std::thread::spawn(move || {
        let mut last = sources_fingerprint(&sources.watched());
        loop {
            std::thread::sleep(POLL_EVERY);
            let now = sources_fingerprint(&sources.watched());
            if now != last {
                last = now;
                announce(&app);
            }
        }
    });
}
