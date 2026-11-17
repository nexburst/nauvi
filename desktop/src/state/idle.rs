//! Idle disconnect (ADR 0007). Every [`REAP_EVERY`] the reaper looks at the
//! clusters each window is connected to but does not show. One that nothing
//! keeps connected ([`Pin`]) and that no command touched for
//! `idle_disconnect_minutes` (Settings; `0`: never) is disconnected: its
//! client and prober, its discovered kinds, its usage history and its
//! caches are dropped. The session stays, so the next command for that
//! cluster connects it again (with the stored answer about its login
//! command, #201). Clusters that sign in through a plugin that may ask
//! the user are never disconnected (`nauvi::plugin_login`). Each window hears about its clusters through
//! [`ClusterStateChanged`].
//!
//! The reaper also forgets sessions a window left whose drains are gone (a
//! drain that failed before it was registered, say).

use super::{AppState, ClusterSession, WindowEmitter};
use crate::settings::SettingsStore;
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

/// How often the reaper runs.
pub(crate) const REAP_EVERY: Duration = Duration::from_secs(30);

/// What keeps a cluster connected while the window does not show it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Pin {
    PortForward,
    /// An exec, attach, debug or node shell.
    Terminal,
    LocalShell,
    LogStream,
    Drain,
    /// It signs in through a plugin that may ask the user (a browser for
    /// OIDC or SSO, say): never disconnected.
    PluginLogin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ClusterState {
    Connected,
    /// Disconnected because it was idle; the next command connects again.
    Idle,
    /// The window disconnected it (`cmd_cluster_disconnect`).
    Disconnected,
}

/// A cluster the window does not show changed state, or what keeps it
/// connected changed. Sent to that window only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClusterStateChanged {
    pub(crate) cluster: String,
    pub(crate) state: ClusterState,
    /// What keeps it connected (`[]` when nothing does, or it is not
    /// connected).
    pub(crate) pinned_by: Vec<Pin>,
}

/// Milliseconds on a monotonic clock, never 0 (0 is "not touched yet").
#[derive(Clone)]
pub(crate) struct Clock(Arc<dyn Fn() -> u64 + Send + Sync>);

impl Default for Clock {
    fn default() -> Self {
        let start = Instant::now();
        Self(Arc::new(move || start.elapsed().as_millis() as u64 + 1))
    }
}

impl Clock {
    pub(crate) fn now(&self) -> u64 {
        (self.0)()
    }
}

/// A session's idle bookkeeping.
#[derive(Default)]
pub(crate) struct IdleMark {
    /// [`Clock::now`] of its last command (0: none yet).
    last_used: AtomicU64,
    /// The reaper disconnected it and it has not connected since.
    idle: AtomicBool,
    /// What the reaper last told the window (`None`: nothing yet, or it
    /// was shown since).
    reported: Mutex<Option<(ClusterState, Vec<Pin>)>>,
}

impl IdleMark {
    pub(crate) fn touch(&self, now: u64) {
        self.last_used.fetch_max(now, Ordering::Relaxed);
    }

    /// Its client was built: if the reaper had disconnected it, wake the
    /// reaper to tell the window it is connected again.
    pub(crate) fn connected(&self) {
        if self.idle.swap(false, Ordering::SeqCst) {
            wake().notify_one();
        }
    }

    /// How long it has been untouched at `now`. A session never touched
    /// counts from the first time it is asked.
    fn untouched(&self, now: u64) -> u64 {
        let last =
            match self
                .last_used
                .compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => now,
                Err(last) => last,
            };
        now.saturating_sub(last)
    }

    /// Remember `report`; whether it differs from the last one.
    fn report(&self, report: Option<(ClusterState, Vec<Pin>)>) -> bool {
        let mut last = self.reported.lock().unwrap();
        let changed = report.is_some() && *last != report;
        *last = report;
        changed
    }
}

/// Wakes the reaper early (a cluster connected again).
fn wake() -> &'static tokio::sync::Notify {
    static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

impl ClusterSession {
    /// What keeps it connected (plugin logins aside).
    pub(crate) fn pinned_by(&self) -> Vec<Pin> {
        let mut pins = Vec::new();
        if !self.forwards.lock().unwrap().is_empty() {
            pins.push(Pin::PortForward);
        }
        if !self.exec_sessions.lock().unwrap().is_empty() {
            pins.push(Pin::Terminal);
        }
        if !self.local_shells.lock().unwrap().is_empty() {
            pins.push(Pin::LocalShell);
        }
        if self.log_streams.running() > 0 {
            pins.push(Pin::LogStream);
        }
        if self.has_live_drain() {
            pins.push(Pin::Drain);
        }
        pins
    }

    /// Drop the client and prober, the discovered kinds, the usage history
    /// and the caches (and any watch, though a cluster the window does not
    /// show runs none). Whether there was a client to drop: not while a
    /// command is building one.
    pub(crate) fn disconnect_idle(&self) -> bool {
        let Ok(mut slot) = self.client.try_lock() else {
            return false;
        };
        if slot.take().is_none() {
            return false;
        }
        self.idle.idle.store(true, Ordering::SeqCst);
        drop(slot);
        for task in super::take_all(&self.watches).into_values() {
            task.abort();
        }
        std::mem::take(&mut *self.kinds.lock().unwrap());
        *self.usage.lock().unwrap() = nauvi::UsageHistory::new();
        *self.prometheus.lock().unwrap() = None;
        self.access.clear();
        true
    }

    /// Whether it has a client (busy building one counts).
    fn has_client(&self) -> Option<bool> {
        self.client.try_lock().ok().map(|c| c.is_some())
    }
}

/// How the reaper treats the clusters of one pass.
pub(crate) struct Reap<'a> {
    pub(crate) now: u64,
    /// Untouched this long, a cluster nothing keeps connected is
    /// disconnected (`None`: never, only report).
    pub(crate) idle_after: Option<Duration>,
    /// Whether cluster `id` signs in through a plugin that may ask.
    pub(crate) plugin_login: &'a dyn Fn(&str) -> bool,
}

impl AppState {
    #[cfg(test)]
    pub(crate) fn with_clock(clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            clock: Clock(Arc::new(clock)),
            ..Default::default()
        }
    }

    /// One pass of the reaper. Returns what to tell which window.
    pub(crate) fn reap(&self, pass: &Reap) -> Vec<(String, ClusterStateChanged)> {
        let windows: Vec<(String, Vec<Arc<ClusterSession>>, Arc<ClusterSession>)> = {
            let mut windows = self.windows.lock().unwrap();
            windows
                .iter_mut()
                .map(|(label, w)| {
                    w.prune_left();
                    let hidden = w
                        .clusters
                        .iter()
                        .filter(|(id, _)| **id != w.visible)
                        .map(|(_, s)| s.clone())
                        .collect();
                    (label.clone(), hidden, w.visible())
                })
                .collect()
        };
        let mut out = Vec::new();
        for (label, hidden, visible) in windows {
            // Shown: told again once it is hidden.
            visible.idle.report(None);
            for session in hidden {
                if let Some(change) = reap_one(&session, pass) {
                    out.push((label.clone(), change));
                }
            }
        }
        out.sort_by(|a, b| (&a.0, &a.1.cluster).cmp(&(&b.0, &b.1.cluster)));
        out
    }
}

/// Reap one hidden session; what to report, if it changed.
fn reap_one(session: &ClusterSession, pass: &Reap) -> Option<ClusterStateChanged> {
    if session.is_closed() {
        return None;
    }
    let mut pinned_by = session.pinned_by();
    if (pass.plugin_login)(session.id()) {
        pinned_by.push(Pin::PluginLogin);
    }
    let untouched = Duration::from_millis(session.idle.untouched(pass.now));
    let state = match session.has_client()? {
        true => {
            let expired = pass.idle_after.is_some_and(|after| untouched >= after);
            if expired && pinned_by.is_empty() && session.disconnect_idle() {
                ClusterState::Idle
            } else {
                ClusterState::Connected
            }
        }
        false if session.idle.idle.load(Ordering::SeqCst) => ClusterState::Idle,
        // Never connected (or it failed): nothing to say.
        false => return None,
    };
    if state == ClusterState::Idle {
        pinned_by.clear();
    }
    let report = Some((state, pinned_by.clone()));
    session.idle.report(report).then(|| ClusterStateChanged {
        cluster: session.id().to_string(),
        state,
        pinned_by,
    })
}

/// The window was told it disconnected cluster `id` itself.
pub(crate) fn disconnected(app: &AppHandle, label: &str, id: &str) {
    WindowEmitter::new(app.clone(), label.to_string()).emit(ClusterStateChanged {
        cluster: id.to_string(),
        state: ClusterState::Disconnected,
        pinned_by: Vec::new(),
    });
}

/// Run the reaper for as long as the app runs.
pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut every =
            tokio::time::interval_at(tokio::time::Instant::now() + REAP_EVERY, REAP_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            // A reconnect only reports; the timer also disconnects.
            let disconnect = tokio::select! {
                _ = every.tick() => true,
                _ = wake().notified() => false,
            };
            run_pass(&app, disconnect);
        }
    });
}

fn run_pass(app: &AppHandle, disconnect: bool) {
    let state = app.state::<AppState>();
    let minutes = app
        .try_state::<Arc<SettingsStore>>()
        .map_or(0, |s| s.get().idle_disconnect_minutes);
    let catalog = state.sources.catalog();
    let plugin_login = |id: &str| catalog.find(id).is_some_and(|c| c.plugin_login);
    let pass = Reap {
        now: state.clock.now(),
        idle_after: (disconnect && minutes > 0)
            .then(|| Duration::from_secs(u64::from(minutes) * 60)),
        plugin_login: &plugin_login,
    };
    for (label, change) in state.reap(&pass) {
        if change.state == ClusterState::Idle {
            tracing::info!(
                "disconnected idle cluster {} in window {label}; {} cluster sessions still connected",
                change.cluster,
                state.live_sessions()
            );
        }
        WindowEmitter::new(app.clone(), label).emit(change);
    }
}

#[cfg(test)]
mod tests;
