//! Windows: each one is connected to its own cluster (see `windows.rs`).

use crate::{close_guard, windows};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Webview};

/// Open a new window connected to `context` (`""`: the kubeconfig's
/// current-context), with the context's name as its title. Its streams,
/// terminals and forwards are its own: switching or closing another window
/// does not touch them.
#[tauri::command]
#[specta::specta]
// Async: building a window from a sync command deadlocks on Windows.
pub(crate) async fn cmd_open_window(
    app: AppHandle,
    webview: Webview,
    context: String,
) -> Result<(), String> {
    // Cascaded from this window, so it doesn't cover it (#182).
    let rect = windows::cascade_from(&app, webview.label());
    windows::open_window(&app, &context, rect).map(|_| ())
}

/// This window has (or no longer has) unsaved edits: closing it or quitting
/// the app asks first (#173, `close_guard.rs`).
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_set_unsaved(webview: Webview, unsaved: bool) {
    close_guard::set_unsaved(webview.label(), unsaved);
}

/// Zoom this window's page to `percent` (#207; kept within 50-200). The
/// frontend remembers the value in the settings and sets it on start.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_set_zoom(webview: Webview, percent: u32) -> Result<(), String> {
    let (min, max) = crate::settings::ZOOM_RANGE;
    webview
        .set_zoom(f64::from(percent.clamp(min, max)) / 100.0)
        .map_err(|e| format!("Could not zoom the window: {e}"))
}

/// The user discarded this window's unsaved edits after an
/// `UnsavedCloseRequested`: go on closing the window (`quit`: quitting the
/// app).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_discard_and_close(
    app: AppHandle,
    webview: Webview,
    quit: bool,
) -> Result<(), String> {
    close_guard::discarded(&app, webview.label(), quit)
}

/// Closing this window (`quit`: quitting the app) was stopped because it has
/// unsaved edits: ask the user, and call `cmd_discard_and_close` if they
/// discard them.
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
pub(crate) struct UnsavedCloseRequested {
    pub(crate) quit: bool,
}
