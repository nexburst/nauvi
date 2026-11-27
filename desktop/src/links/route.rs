//! Where an opened link goes (#299).
//!
//! A link arrives as a launch argument (the first launch, or a second one
//! that the single-instance plugin hands over, #202) or, on macOS, as an
//! "open URL" event. It is checked (`parse`), then:
//!
//! - its context must be in the catalog: a link never adds or connects to a
//!   context the user hasn't got. Otherwise the window gets a notice.
//! - before the main window has started, it goes to the main window, which
//!   then starts on the link's context instead of the remembered one;
//! - else to a window already on that context (the main window first);
//! - else a new window opens for the context, as "Open in new window" in
//!   the catalog would. Logging in to it goes through the same gate as any
//!   window (#213): an added kubeconfig's login command still needs the
//!   user's consent, and without it the window shows why it can't connect.
//!
//! The window is brought to the front and told (`LinkPending`) to take its
//! request with `cmd_take_link`: it opens the object's detail panel, which
//! only reads. Nothing a link says is run or changed.

use super::{is_link, parse, ObjectLink};
use crate::state::{AppState, WindowEmitter, MAIN_WINDOW};
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

/// What a window is asked to do.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum LinkRequest {
    /// Show this object.
    Open { link: ObjectLink },
    /// The link could not be opened; say why.
    Notice { message: String },
    /// Show this object, or with an empty name its kind's table: asked by
    /// the window's own Ask AI session with `nauvi show` (#548). The
    /// window says "Opened by Ask AI".
    AskAi { link: ObjectLink },
}

/// A window has a [`LinkRequest`] waiting: take it with `cmd_take_link`.
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
pub(crate) struct LinkPending {}

/// The request waiting for each window, by label (the latest wins).
static PENDING: LazyLock<Mutex<HashMap<String, LinkRequest>>> = LazyLock::new(Default::default);

/// Set when the main window first takes its request, i.e. it has started
/// and picked its context: from then on a link no longer decides it.
static MAIN_STARTED: AtomicBool = AtomicBool::new(false);

/// Open the first link among the launch arguments `args` (the program name
/// first, as in `std::env::args`). Returns whether there was one.
pub(crate) fn open_from_args(app: &AppHandle, args: &[String]) -> bool {
    let Some(link) = args.iter().skip(1).find(|a| is_link(a)) else {
        return false;
    };
    tracing::info!("opened with a nauvi:// link");
    spawn_open(app, link.clone());
    true
}

/// The link this process was started with, if any (Linux and Windows pass
/// it as the only argument).
pub(crate) fn open_launch_link(app: &AppHandle) {
    let args: Vec<String> = std::env::args_os()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    open_from_args(app, &args);
}

/// macOS: the system asked the running app to open `urls`.
#[cfg(target_os = "macos")]
pub(crate) fn opened(app: &AppHandle, urls: &[url::Url]) {
    if let Some(link) = urls.iter().find(|u| is_link(u.as_str())) {
        tracing::info!("asked to open a nauvi:// link");
        spawn_open(app, link.as_str().to_string());
    }
}

/// Off the caller's thread: the single-instance callback and the macOS
/// event run on the main thread, and building a window there can deadlock
/// on Windows.
fn spawn_open(app: &AppHandle, link: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(one_at_a_time(move || open(&app, &link)));
}

/// Links are routed one after another: a window opened for one link is
/// built (and found by the next) before the next link looks for a window
/// on its context, so links arriving together open one window, not one each.
static ROUTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn one_at_a_time<T>(f: impl FnOnce() -> T) -> T {
    let _turn = ROUTING.lock().await;
    f()
}

/// The link `raw`, checked, for a context in the catalog; else the notice
/// to show.
fn checked(app: &AppHandle, raw: &str) -> Result<ObjectLink, String> {
    let link = parse(raw).map_err(|e| {
        tracing::warn!("refused a link: {e}");
        format!("This nauvi link can't be opened: {e}. Nothing was opened.")
    })?;
    if app
        .state::<AppState>()
        .sources
        .catalog()
        .find(&link.context)
        .is_none()
    {
        tracing::warn!("a link names a context that is not in the kubeconfigs");
        return Err(format!(
            "This link is for the context {}, which is not in your kubeconfigs. Nothing was opened.",
            link.context
        ));
    }
    Ok(link)
}

/// A link clicked in an Ask AI terminal (#548): what the window that shows
/// it does with it, there and then. The window itself checks that the
/// link is for its context; a link never opens another window from there.
pub(crate) fn check(app: &AppHandle, raw: &str) -> LinkRequest {
    match checked(app, raw) {
        Ok(link) => LinkRequest::Open { link },
        Err(message) => LinkRequest::Notice { message },
    }
}

fn open(app: &AppHandle, raw: &str) {
    let link = match checked(app, raw) {
        Ok(link) => link,
        Err(message) => {
            deliver(app, None, LinkRequest::Notice { message });
            return;
        }
    };
    let state = app.state::<AppState>();
    let catalog = state.sources.catalog();
    let request = LinkRequest::Open { link: link.clone() };
    if deliver_to_starting_main(app, &request) {
        return;
    }
    let on_context = state
        .contexts("")
        .into_iter()
        .filter(|(label, _)| app.get_webview_window(label).is_some())
        .filter(|(_, selected)| {
            catalog
                .resolve(selected.as_deref())
                .is_ok_and(|t| t.id == link.context)
        })
        .map(|(label, _)| label);
    let label = pick_window(on_context.collect());
    let label = match label {
        Some(label) => label,
        None => {
            let rect = crate::windows::cascade_from(app, MAIN_WINDOW);
            match crate::windows::open_window(app, &link.context, rect) {
                Ok(label) => label,
                Err(message) => {
                    deliver(app, None, LinkRequest::Notice { message });
                    return;
                }
            }
        }
    };
    deliver(app, Some(label), request);
}

/// The main window first, then the one opened first.
fn pick_window(mut labels: Vec<String>) -> Option<String> {
    if labels.iter().any(|l| l == MAIN_WINDOW) {
        return Some(MAIN_WINDOW.to_string());
    }
    labels.sort_by_key(|l| (l.len(), l.clone()));
    labels.into_iter().next()
}

/// Before the main window has started, it takes the link (and starts on
/// its context). Checked and queued under one lock with `take`, so the
/// link is never queued just after the window looked.
fn deliver_to_starting_main(app: &AppHandle, request: &LinkRequest) -> bool {
    {
        let mut pending = PENDING.lock().unwrap();
        if MAIN_STARTED.load(Ordering::SeqCst) || app.get_webview_window(MAIN_WINDOW).is_none() {
            return false;
        }
        pending.insert(MAIN_WINDOW.to_string(), request.clone());
    }
    notify(app, MAIN_WINDOW);
    true
}

/// Queue `request` for window `label` (`None`: the main window, else any),
/// tell it and bring it to the front.
fn deliver(app: &AppHandle, label: Option<String>, request: LinkRequest) {
    let label = label.or_else(|| front_window(app));
    let Some(label) = label else {
        tracing::warn!("no window to show a link in");
        return;
    };
    PENDING.lock().unwrap().insert(label.clone(), request);
    notify(app, &label);
}

/// Queue `request` for window `label` and tell it, without bringing it to
/// the front: `nauvi show` (#548) never takes the focus from what the user
/// is doing in another app.
pub(crate) fn deliver_quiet(app: &AppHandle, label: &str, request: LinkRequest) {
    PENDING.lock().unwrap().insert(label.to_string(), request);
    WindowEmitter::new(app.clone(), label.to_string()).emit(LinkPending {});
}

/// The window a notice goes to: the main window, else the first one; on
/// macOS with none left, the main window again.
fn front_window(app: &AppHandle) -> Option<String> {
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    if labels.is_empty() {
        return reopen_main(app);
    }
    pick_window(labels)
}

#[cfg(target_os = "macos")]
fn reopen_main(app: &AppHandle) -> Option<String> {
    crate::windows::reopen(app);
    Some(MAIN_WINDOW.to_string())
}

#[cfg(not(target_os = "macos"))]
fn reopen_main(_app: &AppHandle) -> Option<String> {
    None
}

fn notify(app: &AppHandle, label: &str) {
    WindowEmitter::new(app.clone(), label.to_string()).emit(LinkPending {});
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The request waiting for window `label`, if any. The main window's first
/// call marks it started.
pub(crate) fn take(label: &str) -> Option<LinkRequest> {
    let mut pending = PENDING.lock().unwrap();
    if label == MAIN_WINDOW {
        MAIN_STARTED.store(true, Ordering::SeqCst);
    }
    pending.remove(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_main_window_then_the_first_opened() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            pick_window(l(&["cluster-2", "main"])).as_deref(),
            Some("main")
        );
        assert_eq!(
            pick_window(l(&["cluster-10", "cluster-9"])).as_deref(),
            Some("cluster-9")
        );
        assert_eq!(pick_window(vec![]), None);
    }

    /// Two links for one context at once: as `open`, each looks for a built
    /// window and opens one if there is none, and building takes a while.
    /// Routed one at a time, the second finds the first one's window.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn links_arriving_together_open_one_window() {
        use std::sync::Arc;
        let built: Arc<Mutex<Vec<String>>> = Arc::default();
        let route = |built: Arc<Mutex<Vec<String>>>| {
            tokio::spawn(one_at_a_time(move || {
                if let Some(w) = built.lock().unwrap().first().cloned() {
                    return w;
                }
                // Building the window: not visible to others until done.
                std::thread::sleep(std::time::Duration::from_millis(200));
                let label = format!("cluster-{}", built.lock().unwrap().len() + 1);
                built.lock().unwrap().push(label.clone());
                label
            }))
        };
        let (a, b) = tokio::join!(route(built.clone()), route(built.clone()));
        assert_eq!(a.unwrap(), b.unwrap(), "both links go to one window");
        assert_eq!(built.lock().unwrap().len(), 1, "one window opened");
    }

    #[test]
    fn a_request_is_taken_once() {
        PENDING.lock().unwrap().insert(
            "cluster-test".into(),
            LinkRequest::Notice {
                message: "x".into(),
            },
        );
        assert!(take("cluster-test").is_some());
        assert!(take("cluster-test").is_none());
    }
}
