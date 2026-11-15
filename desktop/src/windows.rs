//! One window per cluster: opening windows for a context, their titles,
//! remembering which ones were open, and tearing a window's session down
//! when it closes.

use crate::settings::{SettingsPatch, SettingsStore};
use crate::state::{AppState, ExecSession, MAIN_WINDOW};
use crate::window_state::{self, Rect};
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

/// Where "New window" opens a window from the window `from` (#182):
/// cascaded down and right of it.
pub(crate) fn cascade_from(app: &AppHandle, from: &str) -> Option<Rect> {
    let rect = window_state::window_rect(&app.get_webview_window(from)?)?;
    Some(window_state::cascade(rect, &window_state::monitors(app)))
}

/// Open a new window connected to `context` (`""`: the kubeconfig's
/// current-context), at `rect` (kept on a visible monitor) or the default
/// size. Returns its label.
pub(crate) fn open_window(
    app: &AppHandle,
    context: &str,
    rect: Option<Rect>,
) -> Result<String, String> {
    let label = next_label(app);
    let context = context_arg(context);
    app.state::<AppState>().open(&label, context.clone());
    let rect = rect.map(|r| window_state::on_screen(r, &window_state::monitors(app)));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title(context.as_deref()))
        .disable_drag_drop_handler();
    builder = match rect {
        Some(r) => builder.inner_size(r.width, r.height).position(r.x, r.y),
        None => builder.inner_size(1280.0, 800.0),
    };
    // The same WebView2 arguments as the main window (#93).
    if let Some(args) = crate::webview_args::from_env() {
        builder = builder.additional_browser_args(&args);
    }
    let built = builder.build();
    if let Err(e) = built {
        app.state::<AppState>().close(&label);
        return Err(format!("Could not open a new window: {e}"));
    }
    if let Some(r) = rect {
        window_state::placed(&label, r);
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
    let extras = extra_windows(app.state::<AppState>().contexts(MAIN_WINDOW), except);
    let (labels, contexts) = extras.into_iter().unzip();
    store.update(SettingsPatch {
        windows: Some(contexts),
        ..Default::default()
    });
    // Their sizes and positions, in the same order (#182).
    window_state::set_extras(app, labels);
}

/// The windows to remember, from the open windows by label: the windows
/// opened for a context, in the order they were opened, as (label, context).
fn extra_windows(windows: Vec<(String, Option<String>)>, except: &str) -> Vec<(String, String)> {
    let mut windows: Vec<(u64, String, String)> = windows
        .into_iter()
        .filter(|(label, _)| label != except)
        .filter_map(|(label, ctx)| {
            let n = label.strip_prefix(LABEL_PREFIX)?.parse().ok()?;
            Some((n, label, ctx.unwrap_or_default()))
        })
        .collect();
    windows.sort();
    windows.into_iter().map(|(_, l, ctx)| (l, ctx)).collect()
}

#[cfg(test)]
fn extra_window_contexts(windows: Vec<(String, Option<String>)>, except: &str) -> Vec<String> {
    extra_windows(windows, except)
        .into_iter()
        .map(|(_, ctx)| ctx)
        .collect()
}

/// Reopen the windows that were open when the app last quit, skipping
/// contexts no longer in the kubeconfig. Also titles the main window.
pub(crate) fn restore_windows(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.set_title(&title(None));
    }
    window_state::restore_main(app);
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
    for (n, ctx) in restorable(&remembered, &names) {
        // Where it was (#182), or cascaded from the main window.
        let rect = window_state::restored(Some(n)).or_else(|| cascade_from(app, MAIN_WINDOW));
        if let Err(e) = open_window(app, &ctx, rect) {
            eprintln!("kubeloupe: {e}");
        }
    }
    // Forget what was skipped.
    remember_windows(app, "");
}

/// The remembered contexts still in the kubeconfig, with their index in
/// `remembered` (where their saved rect is).
fn restorable(remembered: &[String], contexts: &[String]) -> Vec<(usize, String)> {
    remembered
        .iter()
        .enumerate()
        .filter(|(_, c)| c.is_empty() || contexts.contains(c))
        .map(|(n, c)| (n, c.clone()))
        .collect()
}

/// On macOS the app keeps running in the Dock when its last window closes
/// (#174); a Dock click opens the main window again (`reopen`). Elsewhere
/// closing the last window quits.
const STAYS_RUNNING_WITHOUT_WINDOWS: bool = cfg!(target_os = "macos");

/// Whether an `ExitRequested` must be stopped: on macOS, when it comes from
/// the last window closing (`code` is `None`), not from `app.exit()` (Quit
/// after "Discard changes?", an update's restart).
pub(crate) fn keep_running(code: Option<i32>) -> bool {
    STAYS_RUNNING_WITHOUT_WINDOWS && code.is_none()
}

/// The window `label` is gone: stop everything it started. If it was the
/// last window and the app quits with it (not on macOS), wait briefly for
/// its shells to end and its node shell pods to be deleted, and keep the
/// remembered windows as they are. Otherwise forget it after
/// `FORGET_DELAY`, unless the app exits by then: windows close one after
/// another when the session logs out, in an order the app doesn't choose,
/// and only a window the user closed alone is forgotten.
pub(crate) fn window_destroyed(app: &AppHandle, label: &str) {
    crate::close_guard::forget(label);
    let sessions = app.state::<AppState>().close(label);
    let others = app.webview_windows().keys().any(|l| l != label);
    if others || STAYS_RUNNING_WITHOUT_WINDOWS {
        crate::state::spawn_closes(sessions);
        if !EXITING.load(Ordering::SeqCst) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FORGET_DELAY).await;
                let left = app.webview_windows().len();
                let exiting = EXITING.load(Ordering::SeqCst);
                if forget_closed_window(exiting, left, STAYS_RUNNING_WITHOUT_WINDOWS) {
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
/// still running with a window open, i.e. the user closed that one window,
/// or (`stays_running`, macOS) still running at all.
fn forget_closed_window(exiting: bool, windows_left: usize, stays_running: bool) -> bool {
    !exiting && (windows_left > 0 || stays_running)
}

/// macOS, a Dock click (`RunEvent::Reopen`): with no window left, open the
/// main window again, on the remembered context, with a fresh session.
#[cfg(target_os = "macos")]
pub(crate) fn reopen(app: &AppHandle) {
    if !app.webview_windows().is_empty() {
        return;
    }
    let Some(config) = app.config().app.windows.first().cloned() else {
        return;
    };
    app.state::<AppState>().reopen(MAIN_WINDOW);
    let built =
        WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.title(title(None)).build());
    if let Err(e) = built {
        eprintln!("kubeloupe: could not open a window: {e}");
    }
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
    window_state::save(app);
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
        assert_eq!(
            restorable(&remembered, &contexts),
            vec![(0, "staging".to_string()), (2, String::new())]
        );
    }

    #[test]
    fn forgets_a_window_closed_alone() {
        // The user closed one extra window; the others are still open.
        assert!(forget_closed_window(false, 1, false));
        assert!(forget_closed_window(false, 3, false));
        // macOS: the app stays in the Dock, so even the last one closed alone.
        assert!(forget_closed_window(false, 0, true));
    }

    #[test]
    fn keeps_windows_closed_by_the_exit() {
        // All windows closed together (logout, "close all"): none left.
        assert!(!forget_closed_window(false, 0, false));
        // Cmd+Q, or the last window closed in the meantime.
        assert!(!forget_closed_window(true, 0, false));
        assert!(!forget_closed_window(true, 0, true));
        // Exiting while a window is still being torn down.
        assert!(!forget_closed_window(true, 1, false));
    }

    #[test]
    fn only_macos_stays_running_and_only_without_an_exit_code() {
        assert_eq!(keep_running(None), cfg!(target_os = "macos"));
        // `app.exit(0)` (Quit after discarding edits) and restarts still exit.
        assert!(!keep_running(Some(0)));
    }

    #[test]
    fn titles_name_the_context() {
        assert_eq!(title(Some("kind-staging")), "kind-staging");
    }
}
