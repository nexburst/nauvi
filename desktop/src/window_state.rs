//! Window size and position (#182): remembered across restarts in
//! `window-state.json` next to the settings, for the main window and for the
//! extra windows in the order of `Settings::windows`. A window opened with
//! "New window" is cascaded from the window it was opened from, so it doesn't
//! cover it. Restored and cascaded positions are kept on a visible monitor.
//!
//! In logical pixels; the position is the window's outer top-left, the size
//! its inner size, as `WebviewWindowBuilder::position` / `inner_size` take
//! them.

use crate::state::MAIN_WINDOW;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewWindow};

/// How far a new window is moved down and right from the one it was opened from.
const CASCADE: f64 = 32.0;
/// At least this much of the title bar stays on a monitor.
const GRAB_WIDTH: f64 = 100.0;
const GRAB_HEIGHT: f64 = 30.0;
/// Moves and resizes are written this long after the last one.
const SAVE_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// The file's content.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    main: Option<Rect>,
    /// The extra windows, in the order of `Settings::windows`.
    #[serde(default)]
    windows: Vec<Option<Rect>>,
}

#[derive(Default)]
struct Inner {
    path: Option<PathBuf>,
    /// What the last run saved, for `restored`.
    loaded: Saved,
    /// The last known rect of every window, by label (kept after it closes:
    /// at exit the windows may already be gone).
    rects: HashMap<String, Rect>,
    /// The labels of the extra windows remembered in the settings, in order.
    extras: Vec<String>,
    generation: u64,
}

static STATE: Mutex<Option<Inner>> = Mutex::new(None);

fn state() -> MutexGuard<'static, Option<Inner>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn with<T>(f: impl FnOnce(&mut Inner) -> T) -> T {
    f(state().get_or_insert_with(Inner::default))
}

/// Read what the last run saved (`path`: `None` keeps nothing).
pub(crate) fn init(path: Option<PathBuf>) {
    let loaded = path.as_deref().map(load).unwrap_or_default();
    with(|s| {
        s.path = path;
        s.loaded = loaded;
    });
}

fn load(path: &Path) -> Saved {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// The saved rect of the main window (`None`) or of the `n`th remembered
/// extra window.
pub(crate) fn restored(extra: Option<usize>) -> Option<Rect> {
    with(|s| match extra {
        None => s.loaded.main,
        Some(n) => s.loaded.windows.get(n).copied().flatten(),
    })
}

/// The extra windows remembered in the settings changed (`labels`, in their
/// order): save their rects in that order.
pub(crate) fn set_extras<R: Runtime>(app: &AppHandle<R>, labels: Vec<String>) {
    with(|s| s.extras = labels);
    schedule_save(app);
}

/// A window was placed at `rect` when it was built.
pub(crate) fn placed(label: &str, rect: Rect) {
    with(|s| s.rects.insert(label.to_string(), rect));
}

/// The window `label` is about to close: keep its rect as it is now (a move
/// just before may not be saved yet).
pub(crate) fn capture<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(r) = app.get_webview_window(label).as_ref().and_then(window_rect) {
        placed(label, r);
    }
}

/// A window moved or was resized: save soon.
pub(crate) fn changed<R: Runtime>(app: &AppHandle<R>) {
    schedule_save(app);
}

fn schedule_save<R: Runtime>(app: &AppHandle<R>) {
    let generation = with(|s| {
        s.generation += 1;
        s.generation
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_DELAY).await;
        if with(|s| s.generation) == generation {
            save(&app);
        }
    });
}

/// Write the rects now (the app is exiting, or after a move).
pub(crate) fn save<R: Runtime>(app: &AppHandle<R>) {
    // The open windows' current rects first; closed ones keep their last.
    for (label, w) in app.webview_windows() {
        if let Some(r) = window_rect(&w) {
            placed(&label, r);
        }
    }
    let (path, saved) = with(|s| {
        let saved = Saved {
            main: s.rects.get(MAIN_WINDOW).copied().or(s.loaded.main),
            windows: s.extras.iter().map(|l| s.rects.get(l).copied()).collect(),
        };
        (s.path.clone(), saved)
    });
    let Some(path) = path else { return };
    if let Err(e) = write(&path, &saved) {
        eprintln!("kubeloupe: could not save {}: {e}", path.display());
    }
}

fn write(path: &Path, saved: &Saved) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(saved)?)?;
    std::fs::rename(tmp, path)
}

/// A window's rect, or `None` while it is minimized, maximized or full
/// screen (its normal rect is the one to keep).
pub(crate) fn window_rect<R: Runtime>(w: &WebviewWindow<R>) -> Option<Rect> {
    if w.is_minimized().unwrap_or(false)
        || w.is_maximized().unwrap_or(false)
        || w.is_fullscreen().unwrap_or(false)
    {
        return None;
    }
    let scale = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Rect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

/// The monitors' work areas, in logical pixels, the primary one first.
pub(crate) fn monitors<R: Runtime>(app: &AppHandle<R>) -> Vec<Rect> {
    let primary = app.primary_monitor().ok().flatten();
    let all = app.available_monitors().unwrap_or_default();
    let mut list: Vec<_> = primary.into_iter().chain(all).collect();
    list.dedup_by(|a, b| a.position() == b.position() && a.size() == b.size());
    list.iter()
        .map(|m| {
            let area = m.work_area();
            let scale = m.scale_factor();
            let pos = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            Rect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

/// The last rect of the window `label` in this run (kept after it closed),
/// or for the main window the one saved by the last run.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn last(label: &str) -> Option<Rect> {
    with(|s| {
        let saved = (label == MAIN_WINDOW).then_some(s.loaded.main).flatten();
        s.rects.get(label).copied().or(saved)
    })
}

/// Move the main window to its saved rect, if there is one.
pub(crate) fn restore_main<R: Runtime>(app: &AppHandle<R>) {
    let (Some(w), Some(r)) = (app.get_webview_window(MAIN_WINDOW), restored(None)) else {
        return;
    };
    let r = on_screen(r, &monitors(app));
    let _ = w.set_size(LogicalSize::new(r.width, r.height));
    let _ = w.set_position(LogicalPosition::new(r.x, r.y));
    placed(MAIN_WINDOW, r);
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// The monitor that shows enough of `r`'s title bar to grab it.
fn showing(r: Rect, monitors: &[Rect]) -> Option<Rect> {
    monitors.iter().copied().find(|m| {
        overlap(r.x, r.x + r.width, m.x, m.x + m.width) >= GRAB_WIDTH.min(r.width)
            && r.y >= m.y
            && r.y + GRAB_HEIGHT <= m.y + m.height
    })
}

/// `r` kept where it is if its title bar is on a monitor, otherwise centred
/// on the first (primary) monitor; never larger than that monitor.
pub(crate) fn on_screen(r: Rect, monitors: &[Rect]) -> Rect {
    let Some(first) = monitors.first().copied() else {
        return r;
    };
    let (m, keep) = match showing(r, monitors) {
        Some(m) => (m, true),
        None => (first, false),
    };
    let width = r.width.min(m.width);
    let height = r.height.min(m.height);
    if keep {
        return Rect { width, height, ..r };
    }
    Rect {
        x: m.x + (m.width - width) / 2.0,
        y: m.y + (m.height - height) / 2.0,
        width,
        height,
    }
}

/// Where a window opened from the window at `from` goes: `CASCADE` down and
/// right of it, back to the monitor's top-left corner when that would run
/// off the monitor.
pub(crate) fn cascade(from: Rect, monitors: &[Rect]) -> Rect {
    let next = Rect {
        x: from.x + CASCADE,
        y: from.y + CASCADE,
        ..from
    };
    let Some(m) = showing(from, monitors) else {
        return on_screen(next, monitors);
    };
    let fits = next.x + next.width <= m.x + m.width && next.y + next.height <= m.y + m.height;
    if fits {
        next
    } else {
        on_screen(
            Rect {
                x: m.x,
                y: m.y,
                ..from
            },
            monitors,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 875.0,
    };

    #[test]
    fn keeps_a_window_that_is_on_screen() {
        let w = r(200.0, 70.0, 1100.0, 700.0);
        assert_eq!(on_screen(w, &[SCREEN]), w);
        // Partly off the right edge, title bar still grabbable.
        let w = r(1300.0, 70.0, 1100.0, 700.0);
        assert_eq!(on_screen(w, &[SCREEN]), w);
    }

    #[test]
    fn brings_back_a_window_from_a_monitor_that_is_gone() {
        // Saved on a second monitor to the right that is unplugged now.
        let w = on_screen(r(2000.0, 100.0, 1200.0, 760.0), &[SCREEN]);
        assert_eq!(w, r(120.0, 57.5, 1200.0, 760.0));
        // Title bar above the screen.
        let w = on_screen(r(100.0, -200.0, 800.0, 600.0), &[SCREEN]);
        assert_eq!(w, r(320.0, 137.5, 800.0, 600.0));
    }

    #[test]
    fn shrinks_a_window_larger_than_its_monitor() {
        let w = on_screen(r(0.0, 0.0, 2560.0, 1400.0), &[SCREEN]);
        assert_eq!(w, r(0.0, 0.0, 1440.0, 875.0));
    }

    #[test]
    fn uses_the_second_monitor_when_the_window_is_on_it() {
        let right = r(1440.0, 0.0, 1920.0, 1080.0);
        let w = r(1600.0, 100.0, 1280.0, 800.0);
        assert_eq!(on_screen(w, &[SCREEN, right]), w);
    }

    #[test]
    fn without_monitors_nothing_changes() {
        let w = r(-5000.0, 0.0, 10.0, 10.0);
        assert_eq!(on_screen(w, &[]), w);
    }

    #[test]
    fn cascades_down_and_right() {
        let from = r(80.0, 30.0, 1280.0, 797.0);
        let small = r(0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(cascade(from, &[small]), r(112.0, 62.0, 1280.0, 797.0));
    }

    #[test]
    fn cascades_back_to_the_corner_at_the_monitor_edge() {
        // The 1440x875 screen of the issue: the second window still fits,
        // a third would run off the bottom.
        let first = r(80.0, 30.0, 1280.0, 797.0);
        let second = cascade(first, &[SCREEN]);
        assert_eq!(second, r(112.0, 62.0, 1280.0, 797.0));
        assert_eq!(cascade(second, &[SCREEN]), r(0.0, 0.0, 1280.0, 797.0));
    }

    #[test]
    fn remembers_a_closed_windows_last_rect() {
        // What the Dock reopen (macOS) puts the main window back at.
        placed("t182-closed", r(10.0, 20.0, 900.0, 600.0));
        assert_eq!(last("t182-closed"), Some(r(10.0, 20.0, 900.0, 600.0)));
        assert_eq!(last("t182-never"), None);
    }

    #[test]
    fn saved_state_round_trips_and_tolerates_old_or_bad_files() {
        let dir = std::env::temp_dir().join(format!("kubeloupe-ws-{}", std::process::id()));
        let path = dir.join("window-state.json");
        let saved = Saved {
            main: Some(r(1.0, 2.0, 3.0, 4.0)),
            windows: vec![None, Some(r(5.0, 6.0, 7.0, 8.0))],
        };
        write(&path, &saved).unwrap();
        assert_eq!(load(&path), saved);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Saved::default());
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(load(&path), Saved::default());
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(load(&path), Saved::default());
    }
}
