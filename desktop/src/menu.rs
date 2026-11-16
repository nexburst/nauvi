//! The Help menu (#208): Documentation, Report a bug and Open log folder.
//!
//! The windows show it in their header on every platform (the UI calls
//! `cmd_help_open`). On macOS the menu bar's Help menu gets the same items;
//! Linux and Windows get no native menu bar, which would take a row in
//! every window to repeat the header.

use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

/// An item of the Help menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HelpItem {
    /// The README, in the browser.
    Documentation,
    /// A new GitHub issue with the diagnostics filled in.
    ReportBug,
    /// The folder with the app log, in the file manager.
    LogFolder,
}

/// Do what `item` says. The URLs and the folder are fixed here: the page
/// only names the item.
pub(crate) fn open<R: Runtime>(app: &AppHandle<R>, item: HelpItem) -> Result<(), String> {
    let opener = app.opener();
    match item {
        HelpItem::Documentation => opener
            .open_url(crate::diagnostics::DOCS_URL, None::<&str>)
            .map_err(|e| format!("Could not open the documentation in the browser: {e}")),
        HelpItem::ReportBug => opener
            .open_url(crate::diagnostics::bug_report_url(), None::<&str>)
            .map_err(|e| format!("Could not open the bug report page in the browser: {e}")),
        HelpItem::LogFolder => {
            let dir = crate::logging::dir().ok_or(
                "kubeloupe has no log folder on this system; its log goes to stderr only.",
            )?;
            opener
                .open_path(dir.display().to_string(), None::<&str>)
                .map_err(|e| format!("Could not open the log folder {}: {e}", dir.display()))
        }
    }
}

/// macOS: add the items to the menu bar's Help menu and handle them.
#[cfg(target_os = "macos")]
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
    use tauri::menu::{MenuItem, MenuItemKind, PredefinedMenuItem, HELP_SUBMENU_ID};

    const ITEMS: [(&str, &str, HelpItem); 3] = [
        (
            "help-documentation",
            "kubeloupe Documentation",
            HelpItem::Documentation,
        ),
        ("help-report-bug", "Report a Bug…", HelpItem::ReportBug),
        ("help-log-folder", "Open Log Folder", HelpItem::LogFolder),
    ];
    let Some(MenuItemKind::Submenu(help)) = app.menu().and_then(|m| m.get(HELP_SUBMENU_ID)) else {
        tracing::warn!("the menu bar has no Help menu");
        return;
    };
    for (i, (id, label, _)) in ITEMS.iter().enumerate() {
        if i == 2 {
            if let Ok(sep) = PredefinedMenuItem::separator(app) {
                let _ = help.append(&sep);
            }
        }
        match MenuItem::with_id(app, *id, *label, true, None::<&str>) {
            Ok(item) => {
                let _ = help.append(&item);
            }
            Err(e) => tracing::warn!("could not add {label} to the Help menu: {e}"),
        }
    }
    app.on_menu_event(|app, event| {
        if let Some((_, _, item)) = ITEMS.iter().find(|(id, _, _)| event.id() == *id) {
            if let Err(e) = open(app, *item) {
                tracing::warn!("{e}");
            }
        }
    });
}

/// Linux and Windows: no menu bar (the header has the Help menu).
#[cfg(not(target_os = "macos"))]
pub(crate) fn install<R: Runtime>(_app: &AppHandle<R>) {}
