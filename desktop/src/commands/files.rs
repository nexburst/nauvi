//! Saving files the user asked for through the native save dialog (#221).
//!
//! The dialog runs here, not in the webview: the webview gets no dialog or
//! filesystem permission, so it can only hand over content and a suggested
//! name, and the user picks where it goes.

use std::path::PathBuf;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Ask where to save a CSV file (starting in Downloads, with `filename`
/// suggested) and write `content` there. Returns the path written, or `None`
/// when the user cancelled the dialog.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_save_csv(
    window: tauri::WebviewWindow,
    filename: String,
    content: String,
) -> Result<Option<String>, String> {
    let name = safe_filename(&filename, "csv");
    let Some(path) = ask_save_path(&window, &name).await? else {
        return Ok(None);
    };
    let path = with_extension(path, "csv");
    std::fs::write(&path, content)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

async fn ask_save_path(
    window: &tauri::WebviewWindow,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Export to CSV")
        .set_file_name(name)
        .add_filter("CSV", &["csv"]);
    if let Some(dir) = downloads_dir(window) {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx
        .await
        .map_err(|_| "The save dialog closed unexpectedly".to_string())?;
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map(Some)
            .map_err(|e| format!("Cannot save there: {e}")),
    }
}

/// Where the dialog starts: the Downloads folder. On Linux `download_dir`
/// only knows it from `user-dirs.dirs` (XDG); without one, GTK would start
/// in the app's working directory, so fall back to `~/Downloads`.
fn downloads_dir(window: &tauri::WebviewWindow) -> Option<PathBuf> {
    let paths = window.path();
    paths
        .download_dir()
        .ok()
        .into_iter()
        .chain(paths.home_dir().ok().map(|h| h.join("Downloads")))
        .find(|d| d.is_dir())
}

/// A file name that is safe on every platform: ASCII letters, digits, `-`,
/// `_` and `.`, never starting with a dot, ending in `.<ext>`.
fn safe_filename(name: &str, ext: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_start_matches('.');
    let stem = if safe.is_empty() { "export" } else { safe };
    let suffix = format!(".{ext}");
    if stem.to_ascii_lowercase().ends_with(&suffix) {
        stem.to_string()
    } else {
        format!("{stem}{suffix}")
    }
}

/// Add `.<ext>` when the name the user typed has no extension (GTK does not
/// add the filter's extension itself).
fn with_extension(path: PathBuf, ext: &str) -> PathBuf {
    if path.extension().is_some() {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_replaces_unsafe_characters() {
        assert_eq!(
            safe_filename("pods kind/test.csv", "csv"),
            "pods_kind_test.csv"
        );
        assert_eq!(
            safe_filename("../../etc/passwd", "csv"),
            "_.._etc_passwd.csv"
        );
        assert_eq!(safe_filename("", "csv"), "export.csv");
        assert_eq!(safe_filename("...", "csv"), "export.csv");
        assert_eq!(safe_filename("pods", "csv"), "pods.csv");
    }

    #[test]
    fn with_extension_keeps_a_chosen_extension() {
        assert_eq!(
            with_extension("/a/pods".into(), "csv"),
            PathBuf::from("/a/pods.csv")
        );
        assert_eq!(
            with_extension("/a/pods.CSV".into(), "csv"),
            PathBuf::from("/a/pods.CSV")
        );
        assert_eq!(
            with_extension("/a/pods.txt".into(), "csv"),
            PathBuf::from("/a/pods.txt")
        );
    }
}
