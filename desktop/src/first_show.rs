//! Windows open hidden and show once their page has loaded (#369).
//!
//! WebKitGTK draws a web view that is not in accelerated compositing mode
//! (the mode it starts in) synchronously: on the first draw the UI process
//! asks the web process to paint (`DrawingArea::ForceUpdate`) and waits on
//! the main thread, up to 500 ms, for the result
//! (`DrawingAreaProxyCoordinatedGraphics::forceUpdateIfNeeded`). While a
//! page is loading the web process does not paint, so a window drawn then
//! (before or during the load) blocks the app's main thread for the whole
//! 500 ms: the page started loading about half a second late on X11.
//! A window that is not shown is not drawn, so the windows start hidden
//! (`"visible": false` in `tauri.conf.json`, `.visible(false)` for the
//! cluster windows) and are shown when their page has loaded: the web
//! process paints at once then.
//!
//! In case a page never finishes loading (a broken install, an engine that
//! reports no load), a window still hidden after [`FALLBACK`] is shown
//! anyway.

use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, Webview};

/// How long a window stays hidden at most when its page does not load.
const FALLBACK: Duration = Duration::from_secs(3);

/// Show the window of `webview` if it is still hidden. Called when its page
/// has loaded; on a reload it is already shown and this does nothing.
pub(crate) fn on_load_finished<R: Runtime>(webview: &Webview<R>) {
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
                tracing::warn!("window {label}: its page did not load; shown anyway");
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
