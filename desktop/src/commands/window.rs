//! Windows: each one is connected to its own cluster (see `windows.rs`).

use crate::windows;
use tauri::AppHandle;

/// Open a new window connected to `context` (`""`: the kubeconfig's
/// current-context), with the context's name as its title. Its streams,
/// terminals and forwards are its own: switching or closing another window
/// does not touch them.
#[tauri::command]
#[specta::specta]
// Async: building a window from a sync command deadlocks on Windows.
pub(crate) async fn cmd_open_window(app: AppHandle, context: String) -> Result<(), String> {
    windows::open_window(&app, &context).map(|_| ())
}
