//! In-app updates (#30) with tauri-plugin-updater: check the release's
//! `latest.json`, then (only when the user clicks Install) download, verify,
//! install and restart. The rules are in `updater.rs`.

use crate::settings::SettingsStore;
use crate::state::WindowEmitter;
use crate::updater::{self, InstallSupport};
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

/// How long the check and the download may take before giving up.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// At most this often a progress event while downloading.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// The update found by the last check, waiting for a click on Install.
#[derive(Default)]
pub(crate) struct UpdaterState {
    pending: Mutex<Option<(Update, bool)>>,
    installing: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateStatus {
    /// No check ran: see `note`.
    Skipped,
    UpToDate,
    Available,
}

/// What a check found. Fields that do not apply are empty.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct UpdateCheck {
    pub(crate) status: UpdateStatus,
    /// The version running now.
    pub(crate) current_version: String,
    /// The version offered (when `available`).
    pub(crate) version: String,
    /// The release notes from `latest.json`.
    pub(crate) notes: String,
    /// The release page, for the notes and for installing by hand.
    pub(crate) release_url: String,
    /// Whether Install works here (see `updater::install_support`).
    pub(crate) can_install: bool,
    /// Why the check was skipped, or why Install is not offered.
    pub(crate) note: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdatePhase {
    Downloading,
    /// Downloaded and verified; installing, then restarting.
    Installing,
}

/// Progress of `cmd_update_install`, sent to the window that started it.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub(crate) struct UpdateProgress {
    pub(crate) phase: UpdatePhase,
    /// Bytes downloaded so far.
    pub(crate) downloaded: u64,
    /// The download's size in bytes (`0`: not known).
    pub(crate) total: u64,
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Check for a newer release. `startup`: the check on start, which the
/// "Check for updates on start" setting turns off. Debug builds only check
/// when `KUBELOUPE_UPDATE_ENDPOINT` points them at a test `latest.json`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_update_check(
    app: AppHandle,
    settings: State<'_, Arc<SettingsStore>>,
    updates: State<'_, UpdaterState>,
    startup: bool,
) -> Result<UpdateCheck, String> {
    let debug = cfg!(debug_assertions);
    let endpoint = updater::endpoint_override(debug, std::env::var(updater::ENDPOINT_ENV).ok())?;
    let current = current_version(&app);
    let mut result = UpdateCheck {
        status: UpdateStatus::Skipped,
        current_version: current.clone(),
        version: String::new(),
        notes: String::new(),
        release_url: updater::RELEASES_URL.to_string(),
        can_install: false,
        note: String::new(),
    };
    if let Some(skip) = updater::skip_reason(
        startup,
        settings.get().check_updates,
        debug,
        endpoint.is_some(),
    ) {
        result.note = skip.message();
        return Ok(result);
    }

    let exiting = app.clone();
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .version_comparator(|current, release| updater::is_newer(&current, &release.version))
        // Windows: installing quits the app to run the installer.
        .on_before_exit(move || crate::windows::before_exit(&exiting));
    if let Some(url) = endpoint {
        builder = builder
            .endpoints(vec![url])
            .map_err(|e| format!("Could not use {}: {e}", updater::ENDPOINT_ENV))?;
    }
    let found = builder
        .build()
        .map_err(|e| format!("Could not set up the update check: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?;

    let Some(update) = found else {
        *updates.pending.lock().unwrap() = None;
        result.status = UpdateStatus::UpToDate;
        return Ok(result);
    };
    let exe = updater::exe_path(
        debug,
        std::env::var(updater::EXE_PATH_ENV).ok(),
        std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    );
    let InstallSupport { can_install, note } = updater::install_support(
        &exe,
        tauri::utils::platform::bundle_type(),
        tauri_plugin_updater::target().as_deref().unwrap_or(""),
        &updater::platform_keys(&update.raw_json),
    );
    result.status = UpdateStatus::Available;
    result.version = update.version.clone();
    result.notes = update.body.clone().unwrap_or_default();
    result.release_url = updater::release_page(&update.version);
    result.can_install = can_install;
    result.note = note;
    *updates.pending.lock().unwrap() = Some((update, can_install));
    Ok(result)
}

/// Download the update found by the last check, verify its signature,
/// install it and restart. Progress arrives as `UpdateProgress` events.
/// Only runs when the user clicks Install.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_update_install(
    app: AppHandle,
    webview: tauri::Webview,
    updates: State<'_, UpdaterState>,
) -> Result<(), String> {
    let Some((mut update, can_install)) = updates.pending.lock().unwrap().clone() else {
        return Err("There is no update to install. Check for updates first.".into());
    };
    if !can_install {
        return Err(format!(
            "This copy of kubeloupe cannot install updates itself. Download {} from {}.",
            update.version,
            updater::release_page(&update.version)
        ));
    }
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err("The update is already being installed.".into());
    }
    let out = WindowEmitter::new(app.clone(), webview.label().to_string());
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let result = download_and_install(update, &out).await;
    updates.installing.store(false, Ordering::SeqCst);
    result?;
    // Through the event loop, so `RunEvent::Exit` saves the settings and
    // stops the sessions first.
    app.request_restart();
    Ok(())
}

async fn download_and_install(update: Update, out: &WindowEmitter) -> Result<(), String> {
    let mut downloaded: u64 = 0;
    let mut last = Instant::now() - PROGRESS_EVERY;
    out.emit(UpdateProgress {
        phase: UpdatePhase::Downloading,
        downloaded: 0,
        total: 0,
    });
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    out.emit(UpdateProgress {
                        phase: UpdatePhase::Downloading,
                        downloaded,
                        total: total.unwrap_or(0),
                    });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("Could not download kubeloupe {}: {e}", update.version))?;
    let size = bytes.len() as u64;
    out.emit(UpdateProgress {
        phase: UpdatePhase::Installing,
        downloaded: size,
        total: size,
    });
    // Installing can block (a privileged dpkg, writing the AppImage).
    let version = update.version.clone();
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| format!("Could not install kubeloupe {version}: {e}"))?
        .map_err(|e| format!("Could not install kubeloupe {version}: {e}"))
}

/// Registers the state the commands use.
pub(crate) fn manage(app: &AppHandle) {
    app.manage(UpdaterState::default());
}
