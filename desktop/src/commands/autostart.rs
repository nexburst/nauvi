//! Start at login (#330): read and change the OS entry (`autostart.rs`).
//!
//! The OS entry is the setting: nothing is kept in `settings.json`, so
//! removing the entry by hand is seen here. It is off until the user turns
//! it on. The webview only says on or off: the program and its arguments
//! are chosen in `autostart.rs`.

use crate::autostart::AutoStart;
use tauri::State;

/// Whether the app starts when the user logs in.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_autostart_enabled(autostart: State<'_, AutoStart>) -> Result<bool, String> {
    autostart
        .is_enabled()
        .map_err(|e| format!("Could not read the start-at-login setting: {e}"))
}

/// Turn start at login on or off; returns the state afterwards.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_autostart_set(
    autostart: State<'_, AutoStart>,
    enabled: bool,
) -> Result<bool, String> {
    autostart.set(enabled).map_err(|e| {
        let what = if enabled { "turn on" } else { "turn off" };
        format!("Could not {what} start at login: {e}")
    })?;
    tracing::info!(
        "start at login turned {}",
        if enabled { "on" } else { "off" }
    );
    autostart
        .is_enabled()
        .map_err(|e| format!("Could not read the start-at-login setting: {e}"))
}
