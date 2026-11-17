//! What the commands share (ADR 0007). A window holds one
//! [`ClusterSession`] per cluster it is connected to ([`WindowClusters`]),
//! one of them visible. A session's context never changes: it has its
//! client, and the streams, terminals, forwards and watches started for
//! that cluster from that window. Switching context opens another session.
//! [`AppState`] holds the windows by label; commands get the session of the
//! cluster they name through the [`Cluster`] argument.

use crate::catalog::{Approved, KubeconfigSources};
use crate::local_shell::LocalShell;
use crate::log_streams::LogStreams;
use kube::api::TerminalSize;
use kube::Client;
use nauvi::client_for_context_with;
use nauvi::liveness::Prober;
use nauvi::resources::ResourceKind;
use nauvi::UsageHistory;
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{AppHandle, EventTarget, Manager};

pub(crate) mod idle;
pub(crate) mod mutation;

/// Why something started for a cluster is dropped: the window left it
/// (switched to another context, disconnected it, closed or reloaded).
pub(crate) const SWITCHED: &str = "the window is no longer connected to this cluster";

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_session(prefix: &str) -> String {
    format!(
        "{}-{}",
        prefix,
        NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) struct ExecSession {
    pub(crate) stdin_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    pub(crate) size_tx: Option<futures::channel::mpsc::Sender<TerminalSize>>,
    pub(crate) task: JoinHandle<()>,
    /// What to remove when the session ends (a node shell's pod).
    pub(crate) cleanup: Option<SessionCleanup>,
    /// End the shell when the session is closed (exec and debug shells).
    /// Off for attach, where closing detaches and the main process keeps
    /// running (#88), and for node shells, whose pod is deleted anyway.
    pub(crate) end_on_close: bool,
}

impl ExecSession {
    /// Stop the session: end its shell (bounded, see
    /// [`nauvi::end_shell`]), stop its pumps and run its cleanup.
    pub(crate) async fn close(mut self) {
        if self.end_on_close {
            nauvi::end_shell(&self.stdin_tx, &mut self.task).await;
        }
        self.task.abort();
        if let Some(c) = self.cleanup {
            c.run().await;
        }
    }
}

/// A pod a terminal session created and must delete when it ends: closed,
/// shell exited, context switched, window closed or app quit.
#[derive(Clone)]
pub(crate) struct SessionCleanup {
    pub(crate) client: Client,
    pub(crate) namespace: String,
    pub(crate) pod: String,
}

impl SessionCleanup {
    pub(crate) async fn run(self) {
        let _ =
            nauvi::node_shell::delete_node_shell(&self.client, &self.namespace, &self.pod).await;
    }
}

/// A running port-forward; dropping it stops it.
pub(crate) struct ForwardSession {
    pub(crate) forward: nauvi::PortForward,
    /// Epoch milliseconds, to list forwards in the order they started.
    pub(crate) started_at: u64,
    /// The saved forward it runs (#217).
    pub(crate) saved_id: String,
    /// Its URL is `https://`.
    pub(crate) https: bool,
}

/// One window's connection to one cluster, and everything started from it
/// for that cluster. Its context never changes.
#[derive(Default)]
pub(crate) struct ClusterSession {
    /// The cluster's id: its context's catalog id, which the UI names it
    /// by (`""` when there is none, e.g. without a kubeconfig).
    id: String,
    /// Its context (`None` = the kubeconfig's current-context).
    context: Option<String>,
    /// Where context ids are looked up (shared by all windows).
    sources: Arc<KubeconfigSources>,
    /// Client for the context, built lazily, with the liveness prober all
    /// its watches share (#90). Both are cheap to clone.
    client: tokio::sync::Mutex<Option<(Client, Prober)>>,
    /// Running log streams (pod and workload), by stream id.
    pub(crate) log_streams: LogStreams,
    /// Open terminal sessions, by session id.
    pub(crate) exec_sessions: Mutex<HashMap<String, ExecSession>>,
    /// Local shells (dock tabs), by session id. Dropping one kills the
    /// shell and deletes its temp kubeconfig.
    pub(crate) local_shells: Mutex<HashMap<String, LocalShell>>,
    /// Active port-forwards, by session id.
    pub(crate) forwards: Mutex<HashMap<String, ForwardSession>>,
    /// Running resource watchers (and overview feeds), by watch id.
    pub(crate) watches: Mutex<HashMap<String, JoinHandle<()>>>,
    /// What the last discovery found, so watches can look up their columns.
    pub(crate) kinds: Mutex<Vec<ResourceKind>>,
    /// Running node drains, by drain id.
    pub(crate) drains: Mutex<HashMap<String, JoinHandle<()>>>,
    /// Usage history of the cluster (#47).
    pub(crate) usage: Mutex<UsageHistory>,
    /// The Prometheus found for the cluster (#47).
    pub(crate) prometheus: Mutex<Option<crate::commands::prometheus::PromCache>>,
    /// Answers of the action access checks (#340).
    pub(crate) access: nauvi::action_access::AccessCache,
    /// When it was last used, and what the idle reaper reported (ADR 0007).
    idle: idle::IdleMark,
    /// Set once the window left the cluster (switched, disconnected, closed
    /// or reloaded): whatever a command still in flight adds afterwards is
    /// stopped right away instead of leaking, and no client is built.
    closed: AtomicBool,
}

impl ClusterSession {
    /// A session on `context`, named `id` (see [`AppState::key_of`]).
    pub(crate) fn new(
        id: String,
        context: Option<String>,
        sources: Arc<KubeconfigSources>,
    ) -> Self {
        Self {
            id,
            context,
            sources,
            ..Default::default()
        }
    }

    /// A session that is already closed: for a window that is gone, or a
    /// cluster the window is not connected to (a late call after a switch).
    fn closed(id: &str, sources: Arc<KubeconfigSources>) -> Self {
        let context = Some(id.to_string()).filter(|c| !c.is_empty());
        let s = Self::new(id.to_string(), context, sources);
        s.closed.store(true, Ordering::SeqCst);
        s.log_streams.close();
        s
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// The id the UI names this cluster by.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn selected_context(&self) -> Option<String> {
        self.context.clone()
    }

    /// The catalog id of the context, which per-context settings are keyed
    /// by. Reads the kubeconfig files; no login.
    pub(crate) fn context_id(&self) -> Result<String, String> {
        self.context_id_of(self.context.as_deref())
    }

    /// [`Self::context_id`] of `selected` (`None`: the kubeconfig's
    /// current-context).
    pub(crate) fn context_id_of(&self, selected: Option<&str>) -> Result<String, String> {
        self.sources
            .catalog()
            .resolve(selected)
            .map(|t| t.id)
            .map_err(|e| e.to_string())
    }

    /// The context and its client: `Err` if the window left the cluster
    /// while the client was built (#217).
    pub(crate) async fn context_client(&self) -> Result<(Option<String>, Client), String> {
        let client = self.client().await?;
        if self.is_closed() {
            return Err(SWITCHED.into());
        }
        Ok((self.selected_context(), client))
    }

    /// The cached client for the context, building it on first use.
    pub(crate) async fn client(&self) -> Result<Client, String> {
        Ok(self.watch_client().await?.0)
    }

    /// [`Self::client`] and the prober its watches share, so the API server
    /// is probed about once per 10 s however many watches are open.
    pub(crate) async fn watch_client(&self) -> Result<(Client, Prober), String> {
        let mut slot = self.client.lock().await;
        // A session the window left builds no client: a late call must not
        // log in again (or reach another cluster).
        if self.is_closed() {
            return Err(SWITCHED.into());
        }
        if let Some(c) = slot.as_ref() {
            return Ok(c.clone());
        }
        // A GUI can't answer an exec plugin's prompts.
        let selected = self.context.as_deref();
        let c = match selected {
            // The default kubeconfig's current-context, or in-cluster config.
            None => client_for_context_with(None, false).await,
            // An added kubeconfig's login command runs once allowed (#201),
            // from the file as it was read for that check (#242).
            Some(id) => self.sources.approved(Some(id))?.client().await,
        }
        .map_err(|e| nauvi::error_text(&e))?;
        let server = self.sources.server(selected);
        let c = (c.clone(), Prober::for_server(c, &server));
        *slot = Some(c.clone());
        self.idle.connected();
        Ok(c)
    }

    /// The context, for what runs outside the client (helm, local shells),
    /// so it reaches the same cluster as the app.
    ///
    /// Helm and kubectl in a local shell run the exec plugin themselves, so
    /// an added kubeconfig's login command must be allowed first (#201),
    /// as for the client, and they get [`Approved::flat`], the context as
    /// it was read for that check, never the added file itself (#242).
    pub(crate) fn target(&self) -> Result<Approved, String> {
        Ok(self.sources.approved(self.context.as_deref())?)
    }

    /// Stop every stream, local shell, forward and watch. Returns the
    /// terminal sessions, still to close: ending their shells and deleting
    /// node shell pods takes the network.
    pub(crate) fn stop_all(&self) -> Vec<ExecSession> {
        self.log_streams.stop_all();
        let sessions = take_all(&self.exec_sessions).into_values().collect();
        // Dropping a local shell kills it and deletes its temp kubeconfig.
        drop(take_all(&self.local_shells));
        // Dropping a forward stops it.
        drop(take_all(&self.forwards));
        for task in take_all(&self.watches).into_values() {
            task.abort();
        }
        sessions
    }

    /// The window switched away from this cluster: refuse what is added
    /// from now on and stop everything but the drains, which outlive a
    /// context switch (not their window). Returns the terminal sessions
    /// still to close.
    pub(crate) fn leave(&self) -> Vec<ExecSession> {
        self.closed.store(true, Ordering::SeqCst);
        self.log_streams.close();
        // Its client goes with it once the last command holding it ends.
        if let Ok(mut slot) = self.client.try_lock() {
            *slot = None;
        }
        self.stop_all()
    }

    /// Mark the session closed and stop everything in it for good, drains
    /// included.
    pub(crate) fn close(&self) -> Vec<ExecSession> {
        let sessions = self.leave();
        for task in take_all(&self.drains).into_values() {
            task.abort();
        }
        sessions
    }

    /// `(namespace, pod)` of the node shells this session has open.
    pub(crate) fn node_shell_pods(&self) -> Vec<(String, String)> {
        self.exec_sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(|s| s.cleanup.as_ref())
            .map(|c| (c.namespace.clone(), c.pod.clone()))
            .collect()
    }

    /// The saved ids of the forwards running in this session.
    fn saved_forwards(&self) -> Vec<String> {
        self.forwards
            .lock()
            .unwrap()
            .values()
            .map(|f| f.saved_id.clone())
            .collect()
    }

    pub(crate) fn add_watch(&self, id: String, task: JoinHandle<()>) {
        if let Some(old) = self.insert(&self.watches, id, task) {
            old.abort();
        }
    }

    /// Whether a drain still runs. Forgets the ones that ended without
    /// removing themselves (a panic, or an end before `add_drain`).
    pub(crate) fn has_live_drain(&self) -> bool {
        let mut drains = self.drains.lock().unwrap();
        drains.retain(|_, t| !t.inner().is_finished());
        !drains.is_empty()
    }

    pub(crate) fn add_drain(&self, id: String, task: JoinHandle<()>) {
        if let Some(old) = self.insert(&self.drains, id, task) {
            old.abort();
        }
    }

    /// Add a forward, unless the window left the cluster meanwhile: then
    /// it is dropped, which stops it (#217). Returns whether it was added.
    pub(crate) fn add_forward(&self, id: String, forward: ForwardSession) -> bool {
        let mut map = self.forwards.lock().unwrap();
        if self.is_closed() {
            return false;
        }
        drop(map.insert(id, forward));
        true
    }

    pub(crate) fn add_local_shell(&self, id: String, shell: LocalShell) {
        drop(self.insert(&self.local_shells, id, shell));
    }

    /// Register a terminal session. Returns the session the caller has to
    /// close: the one it replaced, or on a closed session `session` itself.
    pub(crate) fn add_exec(&self, id: String, session: ExecSession) -> Option<ExecSession> {
        self.insert(&self.exec_sessions, id, session)
    }

    /// Insert under the map's lock, unless the session is closed. Returns
    /// what has to be stopped: the replaced value, or `value` itself when
    /// the session is closed.
    fn insert<T>(&self, map: &Mutex<HashMap<String, T>>, id: String, value: T) -> Option<T> {
        let mut map = map.lock().unwrap();
        // Checked under the lock: `leave` sets the flag before it drains
        // the maps, so nothing slips in after the drain.
        if self.is_closed() {
            return Some(value);
        }
        map.insert(id, value)
    }
}

fn take_all<T>(map: &Mutex<HashMap<String, T>>) -> HashMap<String, T> {
    std::mem::take(&mut *map.lock().unwrap())
}

/// The window opened from `tauri.conf.json`.
pub(crate) const MAIN_WINDOW: &str = "main";

/// The clusters one window is connected to, by id, and the one it shows.
/// The visible one is always in `clusters`.
pub(crate) struct WindowClusters {
    clusters: HashMap<String, Arc<ClusterSession>>,
    visible: String,
    /// Sessions the window switched away from while they had drains
    /// running: closed, not visible, kept until their last drain ends so
    /// it can still be cancelled, and aborted with the window. Apart from
    /// `clusters`, since the window may connect to that cluster again.
    left: Vec<Arc<ClusterSession>>,
    /// The window's page has started loading once (#205): any later load
    /// is a reload, which starts the window over.
    page_loaded: bool,
}

impl WindowClusters {
    fn new(session: ClusterSession) -> Self {
        let visible = session.id.clone();
        Self {
            clusters: HashMap::from([(visible.clone(), Arc::new(session))]),
            visible,
            left: Vec::new(),
            page_loaded: false,
        }
    }

    fn visible(&self) -> Arc<ClusterSession> {
        self.clusters[&self.visible].clone()
    }

    /// The session of cluster `id` (`""`: the visible one).
    fn get(&self, id: &str) -> Option<Arc<ClusterSession>> {
        if id.is_empty() {
            return Some(self.visible());
        }
        self.clusters.get(id).cloned()
    }

    /// Every session, the left ones included.
    fn sessions(&self) -> impl Iterator<Item = &Arc<ClusterSession>> {
        self.clusters.values().chain(self.left.iter())
    }

    /// Forget the left sessions whose drains have all ended.
    fn prune_left(&mut self) {
        self.left.retain(|s| s.has_live_drain());
    }
}

/// The open windows and their clusters, by window label.
#[derive(Default)]
pub(crate) struct AppState {
    /// The kubeconfig sources every session looks its context up in.
    pub(crate) sources: Arc<KubeconfigSources>,
    windows: Mutex<HashMap<String, WindowClusters>>,
    /// Labels of windows that were closed. Labels are never reused, so a
    /// late command from one gets a closed session, not a new live one.
    gone: Mutex<HashSet<String>>,
    /// Saved forwards a window is auto-starting right now (#292): saved
    /// forwards are per context, so two windows on one context must not
    /// both start one.
    autostarting: Arc<Mutex<HashSet<String>>>,
    /// What the idle reaper measures "untouched" with (ADR 0007).
    clock: idle::Clock,
}

/// A window's right to auto-start one saved forward, released on drop
/// (once the forward runs, [`AppState::runs_forward`] sees it).
pub(crate) struct AutostartClaim {
    claimed: Arc<Mutex<HashSet<String>>>,
    saved_id: String,
}

impl Drop for AutostartClaim {
    fn drop(&mut self) {
        self.claimed.lock().unwrap().remove(&self.saved_id);
    }
}

impl AppState {
    /// The id of the cluster of `context`: its catalog id, as the UI names
    /// it (`None`: the kubeconfig's current-context, `""` if there is none).
    /// Reads the kubeconfig files; call it without holding `windows`.
    fn key_of(&self, context: Option<&str>) -> String {
        match context {
            Some(c) => c.to_string(),
            None => self
                .sources
                .catalog()
                .resolve(None)
                .map(|t| t.id)
                .unwrap_or_default(),
        }
    }

    fn new_session(&self, context: Option<String>) -> ClusterSession {
        ClusterSession::new(
            self.key_of(context.as_deref()),
            context,
            self.sources.clone(),
        )
    }

    /// Run `f` on window `label`'s clusters, creating them (on the
    /// kubeconfig's current-context) on its first command. `None` if the
    /// window is gone.
    fn with_window<T>(&self, label: &str, f: impl FnOnce(&mut WindowClusters) -> T) -> Option<T> {
        if self.gone.lock().unwrap().contains(label) {
            return None;
        }
        let fresh = (!self.windows.lock().unwrap().contains_key(label))
            .then(|| WindowClusters::new(self.new_session(None)));
        let mut windows = self.windows.lock().unwrap();
        let window = match fresh {
            Some(w) => windows.entry(label.to_string()).or_insert(w),
            None => windows.get_mut(label)?,
        };
        Some(f(window))
    }

    /// The visible session of window `label`, created on its first command.
    pub(crate) fn session(&self, label: &str) -> Arc<ClusterSession> {
        self.with_window(label, |w| w.visible())
            .unwrap_or_else(|| Arc::new(ClusterSession::closed("", self.sources.clone())))
    }

    /// The session of cluster `id` in window `label` (`""`: the visible
    /// one). A cluster the window is not connected to (a call still in
    /// flight from before a switch), or a window that is gone, gets a
    /// closed session: it adds nothing and builds no client.
    pub(crate) fn cluster(&self, label: &str, id: &str) -> Arc<ClusterSession> {
        self.with_window(label, |w| w.get(id))
            .flatten()
            .inspect(|s| s.idle.touch(self.clock.now()))
            .unwrap_or_else(|| Arc::new(ClusterSession::closed(id, self.sources.clone())))
    }

    /// The id of the cluster window `label` shows.
    pub(crate) fn visible_id(&self, label: &str) -> String {
        self.session(label).id().to_string()
    }

    /// Connect window `label` to the cluster of `context` without showing
    /// it: its session, opened unless the window has it already.
    pub(crate) fn connect(&self, label: &str, context: Option<String>) -> Arc<ClusterSession> {
        let id = self.key_of(context.as_deref());
        let session = || {
            Arc::new(ClusterSession::new(
                id.clone(),
                context.clone(),
                self.sources.clone(),
            ))
        };
        self.with_window(label, |w| {
            w.clusters.entry(id.clone()).or_insert_with(session).clone()
        })
        .inspect(|s| s.idle.touch(self.clock.now()))
        .unwrap_or_else(|| Arc::new(ClusterSession::closed(&id, self.sources.clone())))
    }

    /// Disconnect window `label` from cluster `id`: close its session.
    /// Not the visible one, which the window needs. Returns the terminal
    /// sessions still to close.
    pub(crate) fn disconnect(&self, label: &str, id: &str) -> Result<Vec<ExecSession>, String> {
        let removed = self.with_window(label, |w| {
            if id.is_empty() || id == w.visible {
                return Err(format!(
                    "{} is the cluster this window shows; switch to another one first",
                    if id.is_empty() { "This" } else { id }
                ));
            }
            Ok(w.clusters.remove(id))
        });
        match removed {
            Some(Ok(Some(s))) => Ok(s.close()),
            Some(Err(e)) => Err(e),
            _ => Ok(Vec::new()),
        }
    }

    /// Show the cluster of `context` in window `label`: its session
    /// (reused if the window is connected to it already, else opened)
    /// becomes the visible one, and the window leaves the one it showed
    /// (one visible cluster per window; switching to the same context
    /// starts it over). Returns the terminal sessions still to close.
    pub(crate) fn switch(&self, label: &str, context: Option<String>) -> Vec<ExecSession> {
        let next = self.new_session(context);
        self.with_window(label, |w| {
            let old = w.clusters.remove(&w.visible);
            let id = next.id.clone();
            w.clusters
                .entry(id.clone())
                .or_insert_with(|| Arc::new(next));
            w.visible = id;
            let to_close = old.as_ref().map(|s| s.leave()).unwrap_or_default();
            // Its drains run on (they outlive a switch): keep it, closed,
            // until they end.
            w.left.extend(old);
            w.prune_left();
            to_close
        })
        .unwrap_or_default()
    }

    /// Cancel drain `drain_id` of cluster `id` in window `label`, in the
    /// session the window has for that cluster or one it switched away
    /// from. Returns whether it was running.
    pub(crate) fn cancel_drain(&self, label: &str, id: &str, drain_id: &str) -> bool {
        let sessions: Vec<Arc<ClusterSession>> = self
            .with_window(label, |w| {
                let live = w.get(id);
                let left = w.left.iter().filter(|s| s.id == id).cloned();
                live.into_iter().chain(left).collect()
            })
            .unwrap_or_default();
        let found = sessions
            .iter()
            .find_map(|s| s.drains.lock().unwrap().remove(drain_id));
        let running = found.is_some_and(|h| {
            h.abort();
            true
        });
        self.drain_ended(label);
        running
    }

    /// A drain of window `label` ended: forget the sessions it switched
    /// away from that have no drain left.
    pub(crate) fn drain_ended(&self, label: &str) {
        self.with_window(label, |w| w.prune_left());
    }

    /// Create the clusters of a new window, showing `context`.
    pub(crate) fn open(&self, label: &str, context: Option<String>) {
        let window = WindowClusters::new(self.new_session(context));
        self.windows
            .lock()
            .unwrap()
            .insert(label.to_string(), window);
    }

    /// A window opens again under a label that was closed (macOS: the main
    /// window after a Dock click, #174): a fresh session on the remembered
    /// context.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn reopen(&self, label: &str) {
        self.gone.lock().unwrap().remove(label);
        self.open(label, None);
    }

    /// The window `label` is gone: close all its sessions. Returns the
    /// terminal sessions still to close.
    pub(crate) fn close(&self, label: &str) -> Vec<ExecSession> {
        self.gone.lock().unwrap().insert(label.to_string());
        let window = self.windows.lock().unwrap().remove(label);
        window.map(close_window).unwrap_or_default()
    }

    /// A page load started in window `label` (#205). The first one is the
    /// window opening. A later one is a reload: the page that started the
    /// streams and shells is gone, so the window starts over with a fresh
    /// session on the cluster it showed, and all its old sessions are
    /// closed. Returns, for a reload, their terminal sessions, still to
    /// close.
    pub(crate) fn page_load(&self, label: &str) -> Option<Vec<ExecSession>> {
        let visible = self.with_window(label, |w| {
            let first = !std::mem::replace(&mut w.page_loaded, true);
            (!first).then(|| w.visible().selected_context())
        })??;
        let mut fresh = WindowClusters::new(self.new_session(visible));
        fresh.page_loaded = true;
        let old = self.with_window(label, |w| std::mem::replace(w, fresh))?;
        Some(close_window(old))
    }

    /// Close every window's sessions (the app is quitting).
    pub(crate) fn close_all(&self) -> Vec<ExecSession> {
        let labels: Vec<String> = self.windows.lock().unwrap().keys().cloned().collect();
        labels.iter().flat_map(|l| self.close(l)).collect()
    }

    /// How many sessions of all windows have a client (connected, not
    /// idle-disconnected), the left ones included.
    pub(crate) fn live_sessions(&self) -> usize {
        self.all_sessions("")
            .iter()
            .filter(|s| s.client.try_lock().map_or(true, |c| c.is_some()))
            .count()
    }

    /// Every session of every window (`except` one window), taken out of
    /// the lock: their own maps are locked after it, never under it.
    fn all_sessions(&self, except: &str) -> Vec<Arc<ClusterSession>> {
        self.windows
            .lock()
            .unwrap()
            .iter()
            .filter(|(label, _)| label.as_str() != except)
            .flat_map(|(_, w)| w.sessions().cloned())
            .collect()
    }

    /// `(namespace, pod)` of the node shells open in any window, for any
    /// cluster.
    pub(crate) fn node_shell_pods(&self) -> Vec<(String, String)> {
        self.all_sessions("")
            .iter()
            .flat_map(|s| s.node_shell_pods())
            .collect()
    }

    /// Whether any window runs the saved forward `saved_id` (#217), for any
    /// cluster.
    pub(crate) fn runs_forward(&self, saved_id: &str) -> bool {
        self.all_sessions("")
            .iter()
            .any(|s| s.saved_forwards().iter().any(|id| id == saved_id))
    }

    /// Claim the auto-start of the saved forward `saved_id` (#292): none
    /// if a window runs it already or is starting it right now.
    pub(crate) fn claim_autostart(&self, saved_id: &str) -> Option<AutostartClaim> {
        let mut claimed = self.autostarting.lock().unwrap();
        if claimed.contains(saved_id) || self.runs_forward(saved_id) {
            return None;
        }
        claimed.insert(saved_id.to_string());
        Some(AutostartClaim {
            claimed: self.autostarting.clone(),
            saved_id: saved_id.to_string(),
        })
    }

    /// The saved ids of the forwards running in windows other than
    /// `except` (#292), for any of their clusters.
    pub(crate) fn forwards_elsewhere(&self, except: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .all_sessions(except)
            .iter()
            .flat_map(|s| s.saved_forwards())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// The context every open window other than `except` shows, by label.
    pub(crate) fn contexts(&self, except: &str) -> Vec<(String, Option<String>)> {
        let windows = self.windows.lock().unwrap();
        let mut out: Vec<(String, Option<String>)> = windows
            .iter()
            .filter(|(label, _)| label.as_str() != except)
            .map(|(label, w)| (label.clone(), w.visible().selected_context()))
            .collect();
        out.sort();
        out
    }
}

/// Close every session of a window. Returns their terminal sessions.
fn close_window(window: WindowClusters) -> Vec<ExecSession> {
    window.sessions().flat_map(|s| s.close()).collect()
}

/// Close terminal sessions in the background.
pub(crate) fn spawn_closes(sessions: Vec<ExecSession>) {
    for s in sessions {
        tauri::async_runtime::spawn(s.close());
    }
}

/// Sends events to one window only.
#[derive(Clone)]
pub(crate) struct WindowEmitter {
    app: AppHandle,
    label: String,
}

impl WindowEmitter {
    pub(crate) fn new(app: AppHandle, label: String) -> Self {
        Self { app, label }
    }

    pub(crate) fn emit<E>(&self, event: E)
    where
        E: tauri_specta::Event + serde::Serialize + Clone,
    {
        // A closed window has no listeners left; nothing to report.
        let _ = event.emit_to(
            &self.app,
            EventTarget::WebviewWindow {
                label: self.label.clone(),
            },
        );
    }
}

/// The calling window's session, injected into commands like `State`. It
/// derefs to the [`ClusterSession`]; [`Cluster::emitter`] sends events back
/// to that window only.
///
/// The call names its cluster: the invoke payload carries a `cluster` key,
/// the first parameter of every cluster-scoped command in `bindings.ts`
/// (ADR 0007), and gets that cluster's session in the calling window
/// ([`AppState::cluster`]).
pub(crate) struct Cluster {
    session: Arc<ClusterSession>,
    label: String,
    app: AppHandle,
}

impl Cluster {
    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    pub(crate) fn app(&self) -> &AppHandle {
        &self.app
    }

    pub(crate) fn emitter(&self) -> WindowEmitter {
        WindowEmitter::new(self.app.clone(), self.label.clone())
    }

    /// The session itself, for tasks that outlive the command.
    pub(crate) fn session(&self) -> Arc<ClusterSession> {
        self.session.clone()
    }
}

impl Deref for Cluster {
    type Target = ClusterSession;
    fn deref(&self) -> &ClusterSession {
        &self.session
    }
}

impl<'de> CommandArg<'de, tauri::Wry> for Cluster {
    fn from_command(command: CommandItem<'de, tauri::Wry>) -> Result<Self, InvokeError> {
        // The cluster the UI meant (`api(id)` in `lib/cluster.ts`). Required,
        // so a call that leaves it out fails loudly.
        let cluster = String::from_command(CommandItem {
            key: CLUSTER_KEY,
            ..command
        })?;
        Ok(Cluster::of_call(&command, &cluster))
    }
}

impl Cluster {
    /// The session of cluster `id` in the window that made the call.
    pub(crate) fn of_call(command: &CommandItem<'_, tauri::Wry>, id: &str) -> Self {
        let webview = command.message.webview();
        let label = webview.label().to_string();
        let app = webview.app_handle().clone();
        let session = app.state::<AppState>().cluster(&label, id);
        Cluster {
            session,
            label,
            app,
        }
    }
}

/// The payload key that names the cluster of a call.
pub(crate) const CLUSTER_KEY: &str = "cluster";

/// In the bindings as the `cluster: string` parameter. Every command names
/// it `cluster` and takes it first; `lib/cluster.test.ts` checks both.
impl specta::function::FunctionArg for Cluster {
    fn to_datatype(types: &mut specta::Types) -> Option<specta::datatype::DataType> {
        Some(<String as specta::Type>::definition(types))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forever() -> JoinHandle<()> {
        tauri::async_runtime::spawn(std::future::pending())
    }

    fn session(id: &str) -> ClusterSession {
        ClusterSession::new(id.into(), Some(id.into()), Arc::default())
    }

    /// A running forward of the saved forward `saved_id`.
    fn forward(saved_id: &str) -> ForwardSession {
        let target = nauvi::ForwardTarget::parse("svc/web", "demo").unwrap();
        let remote = nauvi::RemotePort::parse("80").unwrap();
        let forward = tauri::async_runtime::block_on(async {
            nauvi::PortForward::idle(target, remote, 8080)
        });
        ForwardSession {
            forward,
            started_at: 0,
            saved_id: saved_id.into(),
            https: false,
        }
    }

    #[test]
    fn only_one_window_claims_an_autostart_at_a_time() {
        let state = AppState::default();
        let a = state.claim_autostart("fwd-1").expect("first claim");
        assert!(state.claim_autostart("fwd-1").is_none());
        // Another saved forward is independent.
        let b = state.claim_autostart("fwd-2").expect("other forward");
        drop(a);
        assert!(state.claim_autostart("fwd-1").is_some());
        drop(b);
        assert!(state.forwards_elsewhere("main").is_empty());
    }

    #[test]
    fn a_session_the_window_left_builds_no_client() {
        let s = session("a");
        s.leave();
        let err = tauri::async_runtime::block_on(s.client()).err().unwrap();
        assert_eq!(err, SWITCHED);
    }

    #[test]
    fn switching_opens_another_session_and_leaves_the_old_one() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let a = state.cluster("cluster-1", "a");
        a.add_watch("w1".into(), forever());
        a.add_drain("d1".into(), forever());
        assert!(state.switch("cluster-1", Some("b".into())).is_empty());
        // The old session is left, not changed: its watches are stopped,
        // its drain runs on, and what is still added to it is refused.
        assert_eq!(a.selected_context().as_deref(), Some("a"));
        assert!(a.is_closed());
        assert!(a.watches.lock().unwrap().is_empty());
        assert_eq!(a.drains.lock().unwrap().len(), 1);
        a.add_watch("w2".into(), forever());
        assert!(a.watches.lock().unwrap().is_empty());
        assert!(!a.add_forward("pf-1".into(), forward("fwd-1")));
        // The new one is visible and live.
        let b = state.cluster("cluster-1", "b");
        assert!(!b.is_closed());
        assert_eq!(b.selected_context().as_deref(), Some("b"));
        assert_eq!(state.visible_id("cluster-1"), "b");
        assert!(Arc::ptr_eq(&b, &state.cluster("cluster-1", "")));
        assert!(Arc::ptr_eq(&b, &state.session("cluster-1")));
        // A late call for "a" gets a closed session of "a".
        let late = state.cluster("cluster-1", "a");
        assert!(late.is_closed());
        assert_eq!(late.selected_context().as_deref(), Some("a"));
        assert!(!Arc::ptr_eq(&late, &a));
    }

    /// A drain task that runs until aborted; the receiver errs then.
    fn drain_task() -> (JoinHandle<()>, tokio::sync::oneshot::Receiver<()>) {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let task = tauri::async_runtime::spawn(async move {
            std::future::pending::<()>().await;
            drop(tx);
        });
        (task, rx)
    }

    fn aborted(mut rx: tokio::sync::oneshot::Receiver<()>) -> bool {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(2), &mut rx)
                .await
                .is_ok_and(|r| r.is_err())
        })
    }

    #[test]
    fn a_drain_is_cancelled_on_its_own_cluster_after_a_switch() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let (task, rx) = drain_task();
        state.session("cluster-1").add_drain("d1".into(), task);
        state.switch("cluster-1", Some("b".into()));
        // Kept, left, while its drain runs.
        assert_eq!(state.all_sessions("").len(), 2);
        // Not by the cluster shown now.
        assert!(!state.cancel_drain("cluster-1", "b", "d1"));
        assert!(state.cancel_drain("cluster-1", "a", "d1"));
        assert!(aborted(rx));
        // Nothing left to keep it for.
        assert_eq!(state.all_sessions("").len(), 1);
        assert!(!state.cancel_drain("cluster-1", "a", "d1"));
    }

    #[test]
    fn a_drain_left_by_a_switch_is_found_after_switching_back() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let (task, rx) = drain_task();
        let old = state.session("cluster-1");
        old.add_drain("d1".into(), task);
        state.switch("cluster-1", Some("b".into()));
        state.switch("cluster-1", Some("a".into()));
        let again = state.session("cluster-1");
        assert!(!Arc::ptr_eq(&old, &again), "a new session for a");
        assert!(!again.is_closed());
        assert!(state.cancel_drain("cluster-1", "a", "d1"));
        assert!(aborted(rx));
    }

    #[test]
    fn closing_the_window_aborts_a_drain_left_by_a_switch() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let (task, rx) = drain_task();
        let a = state.session("cluster-1");
        a.add_drain("d1".into(), task);
        state.switch("cluster-1", Some("b".into()));
        state.close("cluster-1");
        assert!(aborted(rx));
        assert!(a.drains.lock().unwrap().is_empty());
        assert!(state.all_sessions("").is_empty());
    }

    #[test]
    fn a_left_session_is_dropped_once_its_drain_ends() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let a = state.session("cluster-1");
        a.add_drain("d1".into(), forever());
        state.switch("cluster-1", Some("b".into()));
        assert_eq!(state.all_sessions("").len(), 2);
        // What the drain task does when it ends.
        a.drains.lock().unwrap().remove("d1");
        state.drain_ended("cluster-1");
        assert_eq!(state.all_sessions("").len(), 1);
        drop(state);
        assert_eq!(Arc::strong_count(&a), 1, "nothing holds the left session");
        // Without a drain, a switch keeps nothing.
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        state.switch("cluster-1", Some("b".into()));
        assert_eq!(state.all_sessions("").len(), 1);
    }

    #[test]
    fn switching_reuses_a_connected_cluster() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let b = state.connect("cluster-1", Some("b".into()));
        assert!(Arc::ptr_eq(
            &b,
            &state.connect("cluster-1", Some("b".into()))
        ));
        // Connected, not shown.
        assert_eq!(state.visible_id("cluster-1"), "a");
        assert_eq!(
            state.contexts(""),
            vec![("cluster-1".to_string(), Some("a".to_string()))]
        );
        state.switch("cluster-1", Some("b".into()));
        assert!(Arc::ptr_eq(&b, &state.session("cluster-1")));
        assert!(!b.is_closed());
        // Switching to the cluster shown starts it over.
        state.switch("cluster-1", Some("b".into()));
        assert!(b.is_closed());
        assert!(!Arc::ptr_eq(&b, &state.session("cluster-1")));
    }

    #[test]
    fn disconnecting_closes_only_that_cluster() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let b = state.connect("cluster-1", Some("b".into()));
        b.add_drain("d1".into(), forever());
        let (s, _typed) = shell(true);
        assert!(b.add_exec("exec-1".into(), s).is_none());
        let a = state.session("cluster-1");
        a.add_watch("w".into(), forever());

        assert!(
            state.disconnect("cluster-1", "a").is_err(),
            "the visible one"
        );
        assert!(
            state.disconnect("cluster-1", "").is_err(),
            "the visible one"
        );
        let to_close = state.disconnect("cluster-1", "b").unwrap();
        assert_eq!(to_close.len(), 1);
        assert!(b.is_closed());
        assert!(b.drains.lock().unwrap().is_empty());
        assert!(state.cluster("cluster-1", "b").is_closed());
        assert!(!a.is_closed());
        assert_eq!(a.watches.lock().unwrap().len(), 1);
        // Not connected (any more): nothing to do.
        assert!(state.disconnect("cluster-1", "b").unwrap().is_empty());
        assert!(state.disconnect("gone-window", "b").unwrap().is_empty());
    }

    #[test]
    fn the_port_forward_helpers_see_every_cluster_of_every_window() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        state.open("cluster-2", Some("c".into()));
        // A forward in a cluster window 1 is connected to but not showing.
        let b = state.connect("cluster-1", Some("b".into()));
        assert!(b.add_forward("pf-1".into(), forward("fwd-b")));
        assert!(state
            .session("cluster-1")
            .add_forward("pf-2".into(), forward("fwd-a")));
        assert!(state
            .session("cluster-2")
            .add_forward("pf-3".into(), forward("fwd-a")));

        assert!(state.runs_forward("fwd-b"));
        assert!(state.runs_forward("fwd-a"));
        assert!(!state.runs_forward("fwd-x"));
        assert!(state.claim_autostart("fwd-b").is_none(), "runs already");
        assert_eq!(
            state.forwards_elsewhere("cluster-2"),
            vec!["fwd-a", "fwd-b"]
        );
        assert_eq!(state.forwards_elsewhere("cluster-1"), vec!["fwd-a"]);
        assert_eq!(state.forwards_elsewhere(""), vec!["fwd-a", "fwd-b"]);

        state.disconnect("cluster-1", "b").unwrap();
        assert!(!state.runs_forward("fwd-b"));
        assert!(state.claim_autostart("fwd-b").is_some());
        state.close("cluster-2");
        assert_eq!(state.forwards_elsewhere("cluster-1"), Vec::<String>::new());
        assert_eq!(state.forwards_elsewhere(""), vec!["fwd-a"]);
    }

    #[test]
    fn node_shells_are_found_in_every_cluster() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let b = state.connect("cluster-1", Some("b".into()));
        let (mut s, _typed) = shell(false);
        s.cleanup = Some(SessionCleanup {
            client: tauri::async_runtime::block_on(async {
                Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap())).unwrap()
            }),
            namespace: "kube-system".into(),
            pod: "node-shell-1".into(),
        });
        assert!(b.add_exec("exec-1".into(), s).is_none());
        assert_eq!(
            state.node_shell_pods(),
            vec![("kube-system".to_string(), "node-shell-1".to_string())]
        );
    }

    #[test]
    fn each_window_gets_its_own_session() {
        let state = AppState::default();
        let main = state.session(MAIN_WINDOW);
        assert!(Arc::ptr_eq(&main, &state.session(MAIN_WINDOW)));
        state.open("cluster-1", Some("staging".into()));
        let other = state.session("cluster-1");
        assert!(!Arc::ptr_eq(&main, &other));
        assert_eq!(other.selected_context().as_deref(), Some("staging"));
        assert_eq!(other.id(), "staging");
        assert_eq!(main.selected_context(), None);
        // A cluster another window shows is not this window's.
        assert!(state.cluster(MAIN_WINDOW, "staging").is_closed());
        assert_eq!(
            state.contexts(MAIN_WINDOW),
            vec![("cluster-1".to_string(), Some("staging".to_string()))]
        );
    }

    #[test]
    fn a_reload_gets_a_fresh_session_on_the_same_context() {
        let state = AppState::default();
        state.open("cluster-1", Some("staging".into()));
        let first = state.session("cluster-1");
        let other = state.connect("cluster-1", Some("prod".into()));
        // The window opening: nothing changes.
        assert!(state.page_load("cluster-1").is_none());
        assert!(Arc::ptr_eq(&first, &state.session("cluster-1")));
        assert!(!first.is_closed());
        // A reload: the old sessions are closed, the new one is live.
        assert!(state.page_load("cluster-1").is_some());
        assert!(first.is_closed());
        assert!(other.is_closed());
        assert!(state.cluster("cluster-1", "prod").is_closed());
        let second = state.session("cluster-1");
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(!second.is_closed());
        assert_eq!(second.selected_context().as_deref(), Some("staging"));
        // And so on for every later reload.
        state.page_load("cluster-1");
        assert!(second.is_closed());
    }

    #[test]
    fn the_first_page_load_keeps_a_session_made_before_it() {
        let state = AppState::default();
        // The main window's session is made on its first command.
        assert!(state.page_load(MAIN_WINDOW).is_none());
        let main = state.session(MAIN_WINDOW);
        state.page_load(MAIN_WINDOW);
        assert!(main.is_closed());
        // A closed window's late page load makes no session.
        state.close(MAIN_WINDOW);
        assert!(state.page_load(MAIN_WINDOW).is_none());
        assert!(state.session(MAIN_WINDOW).is_closed());
    }

    #[test]
    fn a_reopened_window_gets_a_live_session_again() {
        let state = AppState::default();
        let first = state.session(MAIN_WINDOW);
        state.close(MAIN_WINDOW);
        // Closed: late calls get a throwaway closed session.
        assert!(!Arc::ptr_eq(
            &state.session(MAIN_WINDOW),
            &state.session(MAIN_WINDOW)
        ));
        state.reopen(MAIN_WINDOW);
        let again = state.session(MAIN_WINDOW);
        assert!(Arc::ptr_eq(&again, &state.session(MAIN_WINDOW)));
        assert!(!Arc::ptr_eq(&first, &again));
    }

    #[test]
    fn closing_a_window_stops_all_its_sessions_and_only_those() {
        let state = AppState::default();
        let a = state.session(MAIN_WINDOW);
        state.open("cluster-1", None);
        let b = state.session("cluster-1");
        let c = state.connect("cluster-1", Some("other".into()));
        let (wa, wb) = (forever(), forever());
        a.add_watch("w1".into(), wa);
        b.add_watch("w2".into(), wb);
        b.add_drain("d1".into(), forever());
        b.log_streams.start(1, forever).unwrap();
        c.add_watch("w3".into(), forever());

        state.close("cluster-1");
        assert!(b.is_closed());
        assert!(c.is_closed());
        assert!(b.watches.lock().unwrap().is_empty());
        assert!(c.watches.lock().unwrap().is_empty());
        assert!(b.drains.lock().unwrap().is_empty());
        assert_eq!(b.log_streams.running(), 0);
        assert_eq!(a.watches.lock().unwrap().len(), 1);
        assert!(!a.is_closed());
        assert_eq!(state.contexts(""), vec![(MAIN_WINDOW.to_string(), None)]);
    }

    #[test]
    fn a_closed_window_never_gets_a_live_session_again() {
        let state = AppState::default();
        state.open("cluster-2", None);
        state.close("cluster-2");
        let late = state.session("cluster-2");
        assert!(late.is_closed());
        assert!(state.cluster("cluster-2", "x").is_closed());
        assert!(state.connect("cluster-2", Some("x".into())).is_closed());
        assert!(state.switch("cluster-2", Some("x".into())).is_empty());
        // What a command still in flight adds is stopped, not kept.
        late.add_watch("w".into(), forever());
        assert!(late.watches.lock().unwrap().is_empty());
        assert!(late.log_streams.start(1, forever).is_err());
        assert!(state.contexts("").is_empty());
    }

    #[test]
    fn adding_to_a_closing_session_is_stopped() {
        let session = ClusterSession::default();
        assert!(session.close().is_empty());
        session.add_drain("d".into(), forever());
        assert!(session.drains.lock().unwrap().is_empty());
    }

    /// A terminal session whose shell exits on the first input; the
    /// receiver gets what was typed.
    fn shell(end_on_close: bool) -> (ExecSession, std::sync::mpsc::Receiver<Vec<u8>>) {
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        let (typed_tx, typed) = std::sync::mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            if let Some(bytes) = stdin_rx.recv().await {
                let _ = typed_tx.send(bytes);
            }
        });
        let session = ExecSession {
            stdin_tx,
            size_tx: None,
            task,
            cleanup: None,
            end_on_close,
        };
        (session, typed)
    }

    #[test]
    fn closing_an_exec_session_ends_its_shell() {
        let (session, typed) = shell(true);
        tauri::async_runtime::block_on(session.close());
        assert_eq!(typed.try_recv().unwrap(), nauvi::END_SHELL_KEYS);
    }

    #[test]
    fn closing_an_attach_session_only_detaches() {
        let (session, typed) = shell(false);
        tauri::async_runtime::block_on(session.close());
        assert!(typed.try_recv().is_err());
    }

    #[test]
    fn switching_context_hands_back_the_terminals_to_close() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let (s, typed) = shell(true);
        assert!(state
            .session("cluster-1")
            .add_exec("exec-1".into(), s)
            .is_none());
        let stopped = state.switch("cluster-1", None);
        assert_eq!(stopped.len(), 1);
        tauri::async_runtime::block_on(async {
            for s in stopped {
                s.close().await;
            }
        });
        assert_eq!(typed.try_recv().unwrap(), nauvi::END_SHELL_KEYS);
    }

    #[test]
    fn switching_context_starts_the_new_cluster_from_nothing() {
        let state = AppState::default();
        state.open("cluster-1", Some("a".into()));
        let a = state.session("cluster-1");
        a.add_watch("w".into(), forever());
        a.access.put(
            nauvi::action_access::Permission {
                verb: "delete",
                group: "apps".into(),
                resource: "deployments".into(),
                subresource: "",
                namespace: Some("team-a".into()),
            },
            false,
        );
        state.switch("cluster-1", Some("b".into()));
        let b = state.session("cluster-1");
        assert!(b.access.is_empty(), "access answers are of the old context");
        assert!(b.watches.lock().unwrap().is_empty());
        assert!(b.usage.lock().unwrap().is_empty());
        assert!(b.kinds.lock().unwrap().is_empty());
        assert_eq!(b.selected_context().as_deref(), Some("b"));
        assert!(!b.is_closed());
        assert!(a.watches.lock().unwrap().is_empty());
    }
}
