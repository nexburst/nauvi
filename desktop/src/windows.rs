//! One window per cluster: opening windows for a context, their titles,
//! remembering which ones were open, and tearing a window's session down
//! when it closes.

use crate::settings::{SettingsPatch, SettingsStore};
use crate::state::{AppState, ExecSession, MAIN_WINDOW};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Labels of the windows opened for a context; `capabilities/default.json`
/// grants `cluster-*` the same permissions as `main`.
const LABEL_PREFIX: &str = "cluster-";

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// Set once the app has started to exit (the last window closed, an
/// `ExitRequested`, or `before_exit`): from then on a closing window is part
/// of the exit and stays remembered (#126).
static EXITING: AtomicBool = AtomicBool::new(false);

/// How long a closed extra window stays remembered before it is forgotten.
/// When the session logs out or the window manager closes all windows, the
/// other windows close within milliseconds, the app exits and the list of
/// windows open when the exit began is kept (#126).
const FORGET_DELAY: Duration = Duration::from_secs(2);

/// The window title: the context's name, or the kubeconfig's
/// current-context when `context` is `None`.
pub(crate) fn title(context: Option<&str>) -> String {
    let current = || {
        kube::config::Kubeconfig::read()
            .ok()
            .and_then(|k| k.current_context)
    };
    match context {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => current().unwrap_or_else(|| "kubeloupe".to_string()),
    }
}

/// `""` means the kubeconfig's current-context, as in the settings.
fn context_arg(context: &str) -> Option<String> {
    Some(context.to_string()).filter(|c| !c.is_empty())
}

fn next_label(app: &AppHandle) -> String {
    loop {
        let label = format!(
            "{LABEL_PREFIX}{}",
            NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
        );
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
}

/// Open a new window connected to `context` (`""`: the kubeconfig's
/// current-context). Returns its label.
pub(crate) fn open_window(app: &AppHandle, context: &str) -> Result<String, String> {
    let label = next_label(app);
    let context = context_arg(context);
    app.state::<AppState>().open(&label, context.clone());
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title(context.as_deref()))
        .inner_size(1280.0, 800.0)
        .disable_drag_drop_handler();
    // The same WebView2 arguments as the main window (#93).
    if let Some(args) = crate::webview_args::from_env() {
        builder = builder.additional_browser_args(&args);
    }
    let built = builder.build();
    if let Err(e) = built {
        app.state::<AppState>().close(&label);
        return Err(format!("Could not open a new window: {e}"));
    }
    remember_windows(app, "");
    Ok(label)
}

/// A window switched to `context`: retitle it, and remember the new
/// context if it is one of the extra windows.
pub(crate) fn context_changed(app: &AppHandle, label: &str, context: Option<&str>) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_title(&title(context));
    }
    if label != MAIN_WINDOW {
        remember_windows(app, "");
    }
}

/// Save the contexts of the extra windows (all but `main` and `except`),
/// so they reopen on the next start.
fn remember_windows(app: &AppHandle, except: &str) {
    let Some(store) = app.try_state::<Arc<SettingsStore>>() else {
        return;
    };
    store.update(SettingsPatch {
        windows: Some(extra_window_contexts(
            app.state::<AppState>().contexts(MAIN_WINDOW),
            except,
        )),
        ..Default::default()
    });
}

/// The contexts to remember, from the open windows by label: the windows
/// opened for a context, in the order they were opened.
fn extra_window_contexts(windows: Vec<(String, Option<String>)>, except: &str) -> Vec<String> {
    let mut windows: Vec<(u64, String)> = windows
        .into_iter()
        .filter(|(label, _)| label != except)
        .filter_map(|(label, ctx)| {
            let n = label.strip_prefix(LABEL_PREFIX)?.parse().ok()?;
            Some((n, ctx.unwrap_or_default()))
        })
        .collect();
    windows.sort();
    windows.into_iter().map(|(_, ctx)| ctx).collect()
}

/// Reopen the windows that were open when the app last quit, skipping
/// contexts no longer in the kubeconfig. Also titles the main window.
pub(crate) fn restore_windows(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.set_title(&title(None));
    }
    let Some(store) = app.try_state::<Arc<SettingsStore>>() else {
        return;
    };
    // Context ids, from the added kubeconfig sources too (#78).
    let names: Vec<String> = app
        .state::<AppState>()
        .sources
        .catalog()
        .contexts
        .into_iter()
        .map(|c| c.name)
        .collect();
    let remembered = store.get().windows;
    for ctx in restorable(&remembered, &names) {
        if let Err(e) = open_window(app, &ctx) {
            eprintln!("kubeloupe: {e}");
        }
    }
    // Forget what was skipped.
    remember_windows(app, "");
}

fn restorable(remembered: &[String], contexts: &[String]) -> Vec<String> {
    remembered
        .iter()
        .filter(|c| c.is_empty() || contexts.contains(c))
        .cloned()
        .collect()
}

/// The window `label` is gone: stop everything it started. If it was the
/// last window (the app is quitting), wait briefly for its shells to end
/// and its node shell pods to be deleted, and keep the remembered windows
/// as they are. Otherwise forget it after `FORGET_DELAY`, unless the app
/// exits by then: windows close one after another when the session logs
/// out, in an order the app doesn't choose, and only a window the user
/// closed alone is forgotten.
pub(crate) fn window_destroyed(app: &AppHandle, label: &str) {
    crate::close_guard::forget(label);
    let sessions = app.state::<AppState>().close(label);
    let others = app.webview_windows().keys().any(|l| l != label);
    if others {
        crate::state::spawn_closes(sessions);
        if !EXITING.load(Ordering::SeqCst) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FORGET_DELAY).await;
                let left = app.webview_windows().len();
                if forget_closed_window(EXITING.load(Ordering::SeqCst), left) {
                    // `close` above already dropped the window from the state.
                    remember_windows(&app, "");
                }
            });
        }
    } else {
        exit_started();
        close_now(sessions);
    }
}

/// After `FORGET_DELAY`: forget a closed extra window only if the app is
/// still running with a window open, i.e. the user closed that one window.
fn forget_closed_window(exiting: bool, windows_left: usize) -> bool {
    !exiting && windows_left > 0
}

/// The app is exiting (`RunEvent::ExitRequested`, e.g. Cmd+Q or the last
/// window closed): windows closing from now on stay remembered.
pub(crate) fn exit_started() {
    EXITING.store(true, Ordering::SeqCst);
}

/// Before the app quits (or an update's installer replaces it): write
/// settings changed in the last moments, and stop what windows still have
/// open (kill the local shells, delete their temp kubeconfigs and the node
/// shell pods).
pub(crate) fn before_exit(app: &AppHandle) {
    exit_started();
    if let Some(store) = app.try_state::<Arc<SettingsStore>>() {
        store.flush();
    }
    close_now(app.state::<AppState>().close_all());
}

/// Close terminal sessions and wait for them, bounded, so a dead cluster
/// cannot keep the app from exiting.
pub(crate) fn close_now(sessions: Vec<ExecSession>) {
    if sessions.is_empty() {
        return;
    }
    tauri::async_runtime::block_on(async {
        let all = futures::future::join_all(sessions.into_iter().map(|s| s.close()));
        let _ = tokio::time::timeout(Duration::from_secs(5), all).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(label: &str, ctx: Option<&str>) -> (String, Option<String>) {
        (label.to_string(), ctx.map(str::to_string))
    }

    #[test]
    fn remembers_the_extra_windows_in_opening_order() {
        let open = vec![
            w("cluster-10", Some("prod")),
            w("cluster-2", None),
            w("cluster-3", Some("staging")),
            w("odd", Some("x")),
        ];
        assert_eq!(
            extra_window_contexts(open.clone(), ""),
            vec!["", "staging", "prod"]
        );
        assert_eq!(extra_window_contexts(open, "cluster-3"), vec!["", "prod"]);
    }

    #[test]
    fn restores_only_contexts_that_still_exist() {
        let remembered = vec!["staging".to_string(), "gone".to_string(), String::new()];
        let contexts = vec!["staging".to_string(), "prod".to_string()];
        assert_eq!(restorable(&remembered, &contexts), vec!["staging", ""]);
    }

    #[test]
    fn forgets_a_window_closed_alone() {
        // The user closed one extra window; the others are still open.
        assert!(forget_closed_window(false, 1));
        assert!(forget_closed_window(false, 3));
    }

    #[test]
    fn keeps_windows_closed_by_the_exit() {
        // All windows closed together (logout, "close all"): none left.
        assert!(!forget_closed_window(false, 0));
        // Cmd+Q, or the last window closed in the meantime.
        assert!(!forget_closed_window(true, 0));
        // Exiting while a window is still being torn down.
        assert!(!forget_closed_window(true, 1));
    }

    #[test]
    fn titles_name_the_context() {
        assert_eq!(title(Some("kind-staging")), "kind-staging");
    }
}
