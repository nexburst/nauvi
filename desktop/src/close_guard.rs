//! Unsaved edits block closing a window or quitting the app (#173).
//!
//! A window's UI reports whether it holds unsaved edits
//! (`cmd_set_unsaved`). Closing such a window (the close button, Cmd+W,
//! the window manager) or quitting the app (Cmd+Q, the app menu's or the
//! Dock's Quit on macOS) is stopped, and the window is asked to show its
//! "Discard changes?" dialog (`UnsavedCloseRequested`). If the user
//! discards, the UI calls `cmd_discard_and_close` and the close or quit
//! goes on.

use crate::commands::window::UnsavedCloseRequested;
use std::collections::BTreeSet;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

/// Labels of the windows with unsaved edits.
static UNSAVED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn unsaved() -> std::sync::MutexGuard<'static, BTreeSet<String>> {
    UNSAVED.lock().unwrap_or_else(|e| e.into_inner())
}

/// The window `label` has (or no longer has) unsaved edits.
pub(crate) fn set_unsaved(label: &str, value: bool) {
    let mut set = unsaved();
    if value {
        set.insert(label.to_string());
    } else {
        set.remove(label);
    }
}

/// The window `label` is gone.
pub(crate) fn forget(label: &str) {
    set_unsaved(label, false);
}

/// A window is about to close: `true` if it has unsaved edits, in which case
/// the close must be stopped; the window has been asked to confirm.
pub(crate) fn close_blocked<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    let blocked = unsaved().contains(label);
    if blocked {
        ask(app, label.to_string(), false);
    }
    blocked
}

/// The app is about to quit: `true` if a window has unsaved edits, in which
/// case the quit must be stopped; the first such window has been asked.
pub(crate) fn quit_blocked<R: Runtime>(app: &AppHandle<R>) -> bool {
    let open = app.webview_windows();
    let first = first_unsaved(&unsaved(), |l| open.contains_key(l));
    match first {
        Some(label) => {
            ask(app, label, true);
            true
        }
        None => false,
    }
}

/// The first window with unsaved edits that is still open.
fn first_unsaved(set: &BTreeSet<String>, is_open: impl Fn(&str) -> bool) -> Option<String> {
    set.iter().find(|l| is_open(l)).cloned()
}

/// Bring the window to the front and ask it to confirm. Off the event loop's
/// thread: this runs from inside a window event or the app delegate.
fn ask<R: Runtime>(app: &AppHandle<R>, label: String, quit: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let event = UnsavedCloseRequested { quit };
        if let Err(e) = event.emit_to(&app, &label) {
            eprintln!("kubeloupe: could not ask {label} about its unsaved edits: {e}");
        }
    });
}

/// The user discarded the edits of window `label`: go on closing it, or go on
/// quitting (asking the next window with unsaved edits first, if any).
pub(crate) fn discarded<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    quit: bool,
) -> Result<(), String> {
    set_unsaved(label, false);
    if quit {
        if !quit_blocked(app) {
            app.exit(0);
        }
        return Ok(());
    }
    match app.get_webview_window(label) {
        Some(w) => w
            .close()
            .map_err(|e| format!("Could not close the window: {e}")),
        None => Ok(()),
    }
}

/// On macOS, Quit (Cmd+Q, the app menu, the Dock) terminates the app without
/// an event Tauri lets us stop. Answer `applicationShouldTerminate:` on the
/// app delegate instead: cancel while a window has unsaved edits.
#[cfg(target_os = "macos")]
pub(crate) fn install(app: &AppHandle) {
    macos::install(app);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::OnceLock;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// `NSApplicationTerminateReply`.
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _sel: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        match APP.get() {
            Some(app) if super::quit_blocked(app) => TERMINATE_CANCEL,
            _ => TERMINATE_NOW,
        }
    }

    pub(super) fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: called on the main thread once the event loop (and with it
        // tao's app delegate) exists. The method's signature matches
        // `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`
        // (type encoding "Q@:@"). tao's delegate class does not implement it,
        // so `class_addMethod` adds it rather than replacing anything.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if ns_app.is_null() {
                return;
            }
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            let Some(delegate) = delegate.as_ref() else {
                return;
            };
            let cls = delegate.class() as *const AnyClass as *mut AnyClass;
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(should_terminate);
            let added = objc2::ffi::class_addMethod(
                cls,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
            if !added.as_bool() {
                eprintln!("kubeloupe: could not guard Quit against unsaved edits");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(labels: &[&str]) -> BTreeSet<String> {
        labels.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn asks_the_first_open_window_with_unsaved_edits() {
        let s = set(&["cluster-2", "main"]);
        assert_eq!(first_unsaved(&s, |_| true).as_deref(), Some("cluster-2"));
        // A window that closed in the meantime is skipped.
        assert_eq!(first_unsaved(&s, |l| l == "main").as_deref(), Some("main"));
        assert_eq!(first_unsaved(&s, |_| false), None);
        assert_eq!(first_unsaved(&set(&[]), |_| true), None);
    }

    #[test]
    fn tracks_windows_with_unsaved_edits() {
        set_unsaved("t173-a", true);
        assert!(unsaved().contains("t173-a"));
        set_unsaved("t173-a", false);
        assert!(!unsaved().contains("t173-a"));
        set_unsaved("t173-b", true);
        forget("t173-b");
        assert!(!unsaved().contains("t173-b"));
    }
}
