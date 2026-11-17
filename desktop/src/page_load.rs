//! A real page load in a window (#205). F5 and Ctrl+R run the app's
//! Refresh and the engine's menu (with its Reload) is suppressed, but the
//! page can still be reloaded (the dev server, a stray navigation). The
//! page that started the window's streams, shells and forwards is gone
//! then, so they are stopped and the window starts over with a fresh
//! session on the same context.

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, Runtime, Webview};

use crate::state::AppState;

pub(crate) fn on_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Started {
        return;
    }
    let label = webview.label();
    // The start-up budget (QA `multicluster`) times the app until this line.
    tracing::info!("window {label}: page load started");
    let Some(sessions) = webview.app_handle().state::<AppState>().page_load(label) else {
        return;
    };
    tracing::info!("window {label} reloaded; its session starts over");
    // The unsaved edits were in the old page.
    crate::close_guard::forget(label);
    crate::state::spawn_closes(sessions);
}
