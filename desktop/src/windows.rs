//! One window per cluster: opening windows for a context, their titles,
//! remembering which ones were open, and tearing a window's session down
//! when it closes.

use crate::settings::{SettingsPatch, SettingsStore};
use crate::state::{AppState, SessionCleanup, MAIN_WINDOW};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Labels of the windows opened for a context; `capabilities/default.json`
/// grants `cluster-*` the same permissions as `main`.
const LABEL_PREFIX: &str = "cluster-";

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

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
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title(context.as_deref()))
        .inner_size(1280.0, 800.0)
        .disable_drag_drop_handler()
        .build();
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
    let names: Vec<String> = kube::config::Kubeconfig::read()
        .map(|k| k.contexts.into_iter().map(|c| c.name).collect())
        .unwrap_or_default();
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
/// last window (the app is quitting), wait briefly for its node shell pods
/// to be deleted and keep the remembered windows as they are.
pub(crate) fn window_destroyed(app: &AppHandle, label: &str) {
    let cleanups = app.state::<AppState>().close(label);
    let others = app.webview_windows().keys().any(|l| l != label);
    if others {
        crate::state::spawn_cleanups(cleanups);
        remember_windows(app, label);
    } else {
        run_cleanups_now(cleanups);
    }
}

/// Run node shell cleanups and wait for them, bounded, so a dead cluster
/// cannot keep the app from exiting.
/// Before the app quits (or an update's installer replaces it): write
/// settings changed in the last moments, and stop what windows still have
/// open (kill the local shells, delete their temp kubeconfigs and the node
/// shell pods).
pub(crate) fn before_exit(app: &AppHandle) {
    if let Some(store) = app.try_state::<Arc<SettingsStore>>() {
        store.flush();
    }
    run_cleanups_now(app.state::<AppState>().close_all());
}

pub(crate) fn run_cleanups_now(cleanups: Vec<SessionCleanup>) {
    if cleanups.is_empty() {
        return;
    }
    tauri::async_runtime::block_on(async {
        let all = futures::future::join_all(cleanups.into_iter().map(|c| c.run()));
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
    fn titles_name_the_context() {
        assert_eq!(title(Some("kind-staging")), "kind-staging");
    }
}
