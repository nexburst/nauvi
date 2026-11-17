//! One running app per user (#202): a second launch hands over to the
//! running one, which brings its window to the front, and exits. Two copies
//! would both write `settings.json` and lose each other's changes.
//!
//! The second launch's context is ignored: it only focuses the app that is
//! already running. Its one argument that counts is a `nauvi://` link
//! (#299, `links.rs`), which the running app opens.
//!
//! On Linux the running app owns a D-Bus name on the session bus. The name
//! includes the config directory, so apps with their own settings (another
//! `HOME` or `XDG_CONFIG_HOME`, like the QA profiles) don't see each other.
//! Without a session bus the plugin starts the app normally. Windows (a named
//! mutex) and macOS (a socket in /tmp) key on the identifier alone.

use crate::state::MAIN_WINDOW;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Wry};

/// The plugin; register it before the other plugins, so a second launch
/// exits before anything else starts.
pub(crate) fn plugin(identifier: &str) -> TauriPlugin<Wry> {
    // A second launch with a nauvi:// link (#299) goes to the window
    // the link is for; any other second launch focuses the app.
    let builder = tauri_plugin_single_instance::Builder::new().callback(|app, args, _cwd| {
        if !crate::links::open_from_args(app, &args) {
            focus(app);
        }
    });
    #[cfg(target_os = "linux")]
    let builder = builder.dbus_id(dbus_id(identifier, &linux_config_dir()));
    #[cfg(not(target_os = "linux"))]
    let _ = identifier;
    builder.build()
}

/// Bring the running app to the front: the main window, else the first
/// cluster window; on macOS with no window left, open the main window again.
fn focus(app: &AppHandle) {
    tracing::info!("another launch; bringing the running app to the front");
    let windows = app.webview_windows();
    let window = windows
        .get(MAIN_WINDOW)
        .or_else(|| windows.values().min_by_key(|w| w.label().to_string()));
    let Some(window) = window else {
        #[cfg(target_os = "macos")]
        crate::windows::reopen(app);
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// `app_config_dir()`'s parent on Linux, before the app exists:
/// `$XDG_CONFIG_HOME` when it is absolute, else `$HOME/.config`.
#[cfg(target_os = "linux")]
fn linux_config_dir() -> String {
    config_dir(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn config_dir(xdg_config_home: Option<&str>, home: Option<&str>) -> String {
    match xdg_config_home {
        Some(dir) if dir.starts_with('/') => dir.trim_end_matches('/').to_string(),
        _ => format!("{}/.config", home.unwrap_or("").trim_end_matches('/')),
    }
}

/// `<identifier>.c<hash of the config dir>`: a valid D-Bus name element
/// (letters and digits, not starting with a digit). FNV-1a, so every build
/// of the app gets the same name for the same directory.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn dbus_id(identifier: &str, config_dir: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in config_dir.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{identifier}.c{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_follows_xdg() {
        assert_eq!(config_dir(Some("/x/cfg/"), Some("/home/a")), "/x/cfg");
        // A relative XDG_CONFIG_HOME is ignored, as in the dirs crate.
        assert_eq!(config_dir(Some("cfg"), Some("/home/a")), "/home/a/.config");
        assert_eq!(config_dir(None, Some("/home/a/")), "/home/a/.config");
    }

    #[test]
    fn dbus_id_is_stable_and_per_directory() {
        let a = dbus_id("com.nauvi.app", "/home/a/.config");
        assert_eq!(a, dbus_id("com.nauvi.app", "/home/a/.config"));
        assert_ne!(a, dbus_id("com.nauvi.app", "/home/b/.config"));
        let last = a.rsplit('.').next().unwrap();
        assert!(a.starts_with("com.nauvi.app.c"));
        assert_eq!(last.len(), 17);
        assert!(last.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
