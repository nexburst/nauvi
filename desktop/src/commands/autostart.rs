//! Start at login (#330), with tauri-plugin-autostart: an XDG autostart
//! entry (`~/.config/autostart/<app>.desktop`) on Linux, a Launch Agent on
//! macOS, a `Run` registry value on Windows.
//!
//! The OS entry is the setting: nothing is kept in `settings.json`, so
//! removing the entry by hand is seen here. It is off until the user turns
//! it on. Only these two commands reach the plugin: the webview gets no
//! autostart permission, so it cannot change the entry's command or
//! arguments.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// Whether the app starts when the user logs in.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("Could not read the start-at-login setting: {e}"))
}

/// Turn start at login on or off; returns the state afterwards.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| {
        let what = if enabled { "turn on" } else { "turn off" };
        format!("Could not {what} start at login: {e}")
    })?;
    tracing::info!(
        "start at login turned {}",
        if enabled { "on" } else { "off" }
    );
    manager
        .is_enabled()
        .map_err(|e| format!("Could not read the start-at-login setting: {e}"))
}
