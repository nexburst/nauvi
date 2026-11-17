//! Windows open hidden and show once their page starts loading (#369).
//!
//! WebKitGTK paints a mapped web view synchronously: the first draw of the
//! window waits on the main thread, with a 500 ms timeout, for the web
//! process's first update. When the window is drawn before the web process
//! is ready, that wait runs into its timeout, and the page starts loading
//! about half a second late (seen on X11, on about one start in ten, and on
//! every start when `setup` takes 20 ms longer). A window that is not shown
//! is not drawn, so the windows start hidden (`"visible": false` in
//! `tauri.conf.json`, `.visible(false)` for the cluster windows) and are
//! shown when their page starts loading: the web process is running then.
//!
//! In case a page never starts loading (a broken install, an engine that
//! reports no load), a window still hidden after [`FALLBACK`] is shown
//! anyway.

use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, Webview};

/// How long a window stays hidden at most when its page does not start
/// loading.
const FALLBACK: Duration = Duration::from_secs(3);

/// Show the window of `webview` if it is still hidden. Called when its page
/// starts loading; on a reload it is already shown and this does nothing.
pub(crate) fn on_load_started<R: Runtime>(webview: &Webview<R>) {
    if let Some(w) = webview.app_handle().get_webview_window(webview.label()) {
        show_if_hidden(&w);
    }
}

/// Show window `label` after [`FALLBACK`] if it is still hidden then.
pub(crate) fn fallback<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(FALLBACK);
        if let Some(w) = app.get_webview_window(&label) {
            if show_if_hidden(&w) {
                tracing::warn!("window {label}: its page did not start loading; shown anyway");
            }
        }
    });
}

/// Whether it showed the window.
fn show_if_hidden<R: Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    if window.is_visible().unwrap_or(true) {
        return false;
    }
    window.show().is_ok()
}
