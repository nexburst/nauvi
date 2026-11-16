//! The Help menu, About and the app log (#208).

use crate::diagnostics::{self, Diagnostics};
use crate::menu::{self, HelpItem};
use tauri::{AppHandle, Webview};

/// The version, commit, OS and webview, and the text "Copy diagnostics"
/// copies.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_diagnostics() -> Diagnostics {
    diagnostics::collect()
}

/// Open the documentation, a prefilled bug report or the log folder.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_help_open(app: AppHandle, item: HelpItem) -> Result<(), String> {
    menu::open(&app, item)
}

/// Write an error the UI caught to the app log. `source`: where it was
/// caught (`boundary`, `error`, `rejection`).
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_log_ui_error(webview: Webview, source: String, message: String, stack: String) {
    crate::logging::ui_error(webview.label(), &source, &message, &stack);
}
