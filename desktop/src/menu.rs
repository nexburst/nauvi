//! The Help menu (#208): Documentation, Report a bug and Open log folder.
//!
//! The windows show it in their header on every platform (the UI calls
//! `cmd_help_open`). On macOS the menu bar's Help menu gets the same items;
//! Linux and Windows get no native menu bar, which would take a row in
//! every window to repeat the header.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

/// An item of the Help menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HelpItem {
    /// The docs of this version, in the browser.
    Documentation,
    /// A new GitHub issue with the diagnostics filled in.
    ReportBug,
    /// The folder with the app log, in the file manager.
    LogFolder,
    /// The docs' page on Ask AI and AI assistants (#376, #466).
    AiAssistants,
}

/// The docs' page on Ask AI, its skill and `nauvi mcp`, relative to the
/// docs' start (`docs/user/src/reference/app/ask-ai.md`).
const AI_DOCS_PAGE: &str = "reference/app/ask-ai.html";

/// Do what `item` says. The URLs and the folder are fixed here: the page
/// only names the item.
pub(crate) fn open<R: Runtime>(app: &AppHandle<R>, item: HelpItem) -> Result<(), String> {
    let opener = app.opener();
    match item {
        HelpItem::Documentation => opener
            .open_url(crate::diagnostics::docs_url(""), None::<&str>)
            .map_err(|e| format!("Could not open the documentation in the browser: {e}")),
        HelpItem::AiAssistants => opener
            .open_url(crate::diagnostics::docs_url(AI_DOCS_PAGE), None::<&str>)
            .map_err(|e| format!("Could not open the documentation in the browser: {e}")),
        HelpItem::ReportBug => opener
            .open_url(crate::diagnostics::bug_report_url(), None::<&str>)
            .map_err(|e| format!("Could not open the bug report page in the browser: {e}")),
        HelpItem::LogFolder => {
            let dir = crate::logging::dir()
                .ok_or("nauvi has no log folder on this system; its log goes to stderr only.")?;
            let file = dir.join(crate::logging::LOG_FILE);
            match log_folder_action(dir, file.is_file(), cfg!(target_os = "macos")) {
                LogFolderAction::Reveal(path) => opener
                    .reveal_item_in_dir(&path)
                    .map_err(|e| format!("Could not show {} in Finder: {e}", path.display())),
                LogFolderAction::Open(path) => opener
                    .open_path(path.display().to_string(), None::<&str>)
                    .map_err(|e| format!("Could not open the log folder {}: {e}", path.display())),
            }
        }
    }
}

/// How Open log folder shows the folder.
#[derive(Debug, PartialEq, Eq)]
enum LogFolderAction {
    /// Select this path in Finder (macOS).
    Reveal(PathBuf),
    /// Open this folder in the file manager (Linux, Windows).
    Open(PathBuf),
}

/// On macOS the log folder is `~/Library/Logs/com.nauvi.app`, named
/// after the bundle id. Launch Services takes a folder ending in `.app` for
/// an application bundle and refuses to open it ("its executable is
/// missing", #321), so there the log is revealed (selected) in Finder
/// instead, or the folder itself if the log is not there yet. Elsewhere the
/// folder is opened as it is.
fn log_folder_action(dir: &Path, file_exists: bool, macos: bool) -> LogFolderAction {
    if !macos {
        return LogFolderAction::Open(dir.to_path_buf());
    }
    if file_exists {
        LogFolderAction::Reveal(dir.join(crate::logging::LOG_FILE))
    } else {
        LogFolderAction::Reveal(dir.to_path_buf())
    }
}

/// macOS: add the items to the menu bar's Help menu and handle them.
#[cfg(target_os = "macos")]
pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) {
    use tauri::menu::{MenuItem, MenuItemKind, PredefinedMenuItem, HELP_SUBMENU_ID};

    const ITEMS: [(&str, &str, HelpItem); 3] = [
        (
            "help-documentation",
            "nauvi Documentation",
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

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "/Users/me/Library/Logs/com.nauvi.app";

    #[test]
    fn macos_reveals_the_log_rather_than_opening_the_app_named_folder() {
        assert_eq!(
            log_folder_action(Path::new(DIR), true, true),
            LogFolderAction::Reveal(Path::new(DIR).join("nauvi.log"))
        );
    }

    #[test]
    fn macos_reveals_the_folder_when_there_is_no_log_yet() {
        assert_eq!(
            log_folder_action(Path::new(DIR), false, true),
            LogFolderAction::Reveal(PathBuf::from(DIR))
        );
    }

    #[test]
    fn linux_and_windows_open_the_folder() {
        let dir = Path::new("/home/me/.local/share/com.nauvi.app/logs");
        for exists in [true, false] {
            assert_eq!(
                log_folder_action(dir, exists, false),
                LogFolderAction::Open(dir.to_path_buf())
            );
        }
    }
}
