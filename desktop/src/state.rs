//! What the commands share. Each window is connected to one cluster and has
//! its own [`ClusterSession`]: the selected context, its client, and the
//! streams, terminals, forwards and watches started from that window.
//! [`AppState`] holds the sessions by window label; commands get the
//! calling window's session through the [`Cluster`] argument.

use crate::catalog::{Approved, KubeconfigSources};
use crate::local_shell::LocalShell;
use crate::log_streams::LogStreams;
use kube::api::TerminalSize;
use kube::Client;
use kubeloupe::client_for_context_with;
use kubeloupe::liveness::Prober;
use kubeloupe::resources::ResourceKind;
use kubeloupe::UsageHistory;
use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{AppHandle, EventTarget, Manager};

/// Why something started for a context is dropped: the window left it.
pub(crate) const SWITCHED: &str = "the window switched to another context meanwhile";

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
    /// [`kubeloupe::end_shell`]), stop its pumps and run its cleanup.
    pub(crate) async fn close(mut self) {
        if self.end_on_close {
            kubeloupe::end_shell(&self.stdin_tx, &mut self.task).await;
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
        let _ = kubeloupe::node_shell::delete_node_shell(&self.client, &self.namespace, &self.pod)
            .await;
    }
}

/// A running port-forward; dropping it stops it.
pub(crate) struct ForwardSession {
    pub(crate) forward: kubeloupe::PortForward,
    /// Epoch milliseconds, to list forwards in the order they started.
    pub(crate) started_at: u64,
    /// The saved forward it runs (#217).
    pub(crate) saved_id: String,
    /// Its URL is `https://`.
    pub(crate) https: bool,
}

/// One window's connection to a cluster, and everything started from it.
#[derive(Default)]
pub(crate) struct ClusterSession {
    /// Selected context id (`None` = the kubeconfig's current-context).
    pub(crate) context: Mutex<Option<String>>,
    /// Where context ids are looked up (shared by all windows).
    sources: Arc<KubeconfigSources>,
    /// Client for the selected context, built lazily and dropped when the
    /// context changes, with the liveness prober all its watches share
    /// (#90). Both are cheap to clone.
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
    /// Usage history of the selected context (#47), cleared when it changes.
    pub(crate) usage: Mutex<UsageHistory>,
    /// The Prometheus found for the selected context (#47), cleared when it
    /// changes.
    pub(crate) prometheus: Mutex<Option<crate::commands::prometheus::PromCache>>,
    /// Set once the window is gone: whatever a command still in flight
    /// adds afterwards is stopped right away instead of leaking.
    closed: AtomicBool,
    /// The window's page has started loading once (#205): any later load
    /// is a reload, which gets a fresh session.
    page_loaded: AtomicBool,
}

impl ClusterSession {
    pub(crate) fn new(context: Option<String>, sources: Arc<KubeconfigSources>) -> Self {
        Self {
            context: Mutex::new(context),
            sources,
            ..Default::default()
        }
    }

    /// A session that is already closed (for a window that is gone).
    fn closed() -> Self {
        let s = Self::default();
        s.closed.store(true, Ordering::SeqCst);
        s.log_streams.close();
        s
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub(crate) fn selected_context(&self) -> Option<String> {
        self.context.lock().unwrap().clone()
    }

    /// The catalog id of the selected context, which per-context settings
    /// are keyed by. Reads the kubeconfig files; no login.
    pub(crate) fn context_id(&self) -> Result<String, String> {
        self.context_id_of(self.selected_context().as_deref())
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

    /// The selected context and its client, read together: `Err` if the
    /// context changed while the client was built (#217).
    pub(crate) async fn context_client(&self) -> Result<(Option<String>, Client), String> {
        let ctx = self.selected_context();
        let client = self.client().await?;
        if self.selected_context() != ctx {
            return Err(SWITCHED.into());
        }
        Ok((ctx, client))
    }

    /// The cached client for the selected context, building it on first use.
    pub(crate) async fn client(&self) -> Result<Client, String> {
        Ok(self.watch_client().await?.0)
    }

    /// [`Self::client`] and the prober its watches share, so the API server
    /// is probed about once per 10 s however many watches are open.
    pub(crate) async fn watch_client(&self) -> Result<(Client, Prober), String> {
        let mut slot = self.client.lock().await;
        if let Some(c) = slot.as_ref() {
            return Ok(c.clone());
        }
        // A GUI can't answer an exec plugin's prompts.
        // Read once: the client and the URL in messages are of one context.
        let selected = self.selected_context();
        let c = match selected.as_deref() {
            // The default kubeconfig's current-context, or in-cluster config.
            None => client_for_context_with(None, false).await,
            // An added kubeconfig's login command runs once allowed (#201),
            // from the file as it was read for that check (#242).
            Some(id) => self.sources.approved(Some(id))?.client().await,
        }
        .map_err(|e| kubeloupe::error_text(&e))?;
        let server = self.sources.server(selected.as_deref());
        let c = (c.clone(), Prober::for_server(c, &server));
        *slot = Some(c.clone());
        Ok(c)
    }

    /// The selected context, for what runs outside the client (helm,
    /// local shells), so it reaches the same cluster as the app.
    ///
    /// Helm and kubectl in a local shell run the exec plugin themselves, so
    /// an added kubeconfig's login command must be allowed first (#201),
    /// as for the client, and they get [`Approved::flat`], the context as
    /// it was read for that check, never the added file itself (#242).
    pub(crate) fn target(&self) -> Result<Approved, String> {
        Ok(self.sources.approved(self.selected_context().as_deref())?)
    }

    /// Switch to `context`: stop everything of the old one and forget its
    /// client, kinds, usage history and Prometheus. Returns the terminal
    /// sessions still to close.
    pub(crate) async fn set_context(&self, context: Option<String>) -> Vec<ExecSession> {
        // The context first: what is added for the old one afterwards is
        // refused (`add_forward_on`), what was added before is stopped here.
        *self.context.lock().unwrap() = context;
        let sessions = self.stop_all();
        self.kinds.lock().unwrap().clear();
        self.usage.lock().unwrap().clear();
        *self.prometheus.lock().unwrap() = None;
        *self.client.lock().await = None;
        sessions
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

    /// Mark the session closed and stop everything in it for good, drains
    /// included (they outlive a context switch, not their window).
    pub(crate) fn close(&self) -> Vec<ExecSession> {
        self.closed.store(true, Ordering::SeqCst);
        self.log_streams.close();
        for task in take_all(&self.drains).into_values() {
            task.abort();
        }
        self.stop_all()
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

    pub(crate) fn add_watch(&self, id: String, task: JoinHandle<()>) {
        if let Some(old) = self.insert(&self.watches, id, task) {
            old.abort();
        }
    }

    pub(crate) fn add_drain(&self, id: String, task: JoinHandle<()>) {
        if let Some(old) = self.insert(&self.drains, id, task) {
            old.abort();
        }
    }

    /// Add a forward started for context `ctx`, unless the window switched
    /// away from it (or closed) meanwhile: then it is dropped, which stops
    /// it (#217). Returns whether it was added.
    pub(crate) fn add_forward_on(
        &self,
        ctx: &Option<String>,
        id: String,
        forward: ForwardSession,
    ) -> bool {
        self.insert_on(&self.forwards, ctx, id, forward).is_ok()
    }

    /// Insert into `map` if the selected context is still `ctx`. Checked
    /// under the map's lock: `set_context` changes the context before it
    /// drains the maps, so nothing of the old context slips in after.
    fn insert_on<T>(
        &self,
        map: &Mutex<HashMap<String, T>>,
        ctx: &Option<String>,
        id: String,
        value: T,
    ) -> Result<(), T> {
        let mut map = map.lock().unwrap();
        if self.is_closed() || self.selected_context() != *ctx {
            return Err(value);
        }
        drop(map.insert(id, value));
        Ok(())
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
        // Checked under the lock: `close` sets the flag before it drains
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

/// The sessions of the open windows, by window label.
#[derive(Default)]
pub(crate) struct AppState {
    /// The kubeconfig sources every session looks its context up in.
    pub(crate) sources: Arc<KubeconfigSources>,
    sessions: Mutex<HashMap<String, Arc<ClusterSession>>>,
    /// Labels of windows that were closed. Labels are never reused, so a
    /// late command from one gets a closed session, not a new live one.
    gone: Mutex<HashSet<String>>,
}

impl AppState {
    /// The session of window `label`, created on its first command.
    pub(crate) fn session(&self, label: &str) -> Arc<ClusterSession> {
        if self.gone.lock().unwrap().contains(label) {
            return Arc::new(ClusterSession::closed());
        }
        self.sessions
            .lock()
            .unwrap()
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(ClusterSession::new(None, self.sources.clone())))
            .clone()
    }

    /// Create the session of a new window, connected to `context`.
    pub(crate) fn open(&self, label: &str, context: Option<String>) {
        self.sessions.lock().unwrap().insert(
            label.to_string(),
            Arc::new(ClusterSession::new(context, self.sources.clone())),
        );
    }

    /// A window opens again under a label that was closed (macOS: the main
    /// window after a Dock click, #174): a fresh session on the remembered
    /// context.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn reopen(&self, label: &str) {
        self.gone.lock().unwrap().remove(label);
        self.open(label, None);
    }

    /// The window `label` is gone: close its session. Returns the terminal
    /// sessions still to close.
    pub(crate) fn close(&self, label: &str) -> Vec<ExecSession> {
        self.gone.lock().unwrap().insert(label.to_string());
        let session = self.sessions.lock().unwrap().remove(label);
        session.map(|s| s.close()).unwrap_or_default()
    }

    /// A page load started in window `label` (#205). The first one is the
    /// window opening. A later one is a reload: the page that started the
    /// streams and shells is gone, so the window gets a fresh session on
    /// the same context and the old one is closed. Returns, for a reload,
    /// the old session's terminal sessions, still to close.
    pub(crate) fn page_load(&self, label: &str) -> Option<Vec<ExecSession>> {
        if self.gone.lock().unwrap().contains(label) {
            return None;
        }
        let old = {
            let mut sessions = self.sessions.lock().unwrap();
            let current = sessions
                .entry(label.to_string())
                .or_insert_with(|| Arc::new(ClusterSession::new(None, self.sources.clone())));
            if !current.page_loaded.swap(true, Ordering::SeqCst) {
                return None;
            }
            let fresh = ClusterSession::new(current.selected_context(), self.sources.clone());
            fresh.page_loaded.store(true, Ordering::SeqCst);
            std::mem::replace(current, Arc::new(fresh))
        };
        Some(old.close())
    }

    /// Close every session (the app is quitting).
    pub(crate) fn close_all(&self) -> Vec<ExecSession> {
        let labels: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        labels.iter().flat_map(|l| self.close(l)).collect()
    }

    /// `(namespace, pod)` of the node shells open in any window.
    pub(crate) fn node_shell_pods(&self) -> Vec<(String, String)> {
        let sessions: Vec<Arc<ClusterSession>> =
            self.sessions.lock().unwrap().values().cloned().collect();
        sessions.iter().flat_map(|s| s.node_shell_pods()).collect()
    }

    /// Whether any window runs the saved forward `saved_id` (#217).
    pub(crate) fn runs_forward(&self, saved_id: &str) -> bool {
        let sessions: Vec<Arc<ClusterSession>> =
            self.sessions.lock().unwrap().values().cloned().collect();
        sessions.iter().any(|s| {
            s.forwards
                .lock()
                .unwrap()
                .values()
                .any(|f| f.saved_id == saved_id)
        })
    }

    /// The context of every open window other than `except`, by label.
    pub(crate) fn contexts(&self, except: &str) -> Vec<(String, Option<String>)> {
        let sessions = self.sessions.lock().unwrap();
        let mut out: Vec<(String, Option<String>)> = sessions
            .iter()
            .filter(|(label, _)| label.as_str() != except)
            .map(|(label, s)| (label.clone(), s.selected_context()))
            .collect();
        out.sort();
        out
    }
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
/// to that window only. Not part of the TypeScript signatures.
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
        let webview = command.message.webview();
        let label = webview.label().to_string();
        let app = webview.app_handle().clone();
        let session = app.state::<AppState>().session(&label);
        Ok(Cluster {
            session,
            label,
            app,
        })
    }
}

/// Injected, like `State`: leave it out of the generated bindings.
impl specta::function::FunctionArg for Cluster {
    fn to_datatype(_: &mut specta::Types) -> Option<specta::datatype::DataType> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forever() -> JoinHandle<()> {
        tauri::async_runtime::spawn(std::future::pending())
    }

    #[test]
    fn what_was_started_for_an_old_context_is_refused() {
        let s = ClusterSession::new(Some("a".into()), Arc::default());
        let a = Some("a".to_string());
        assert!(s.insert_on(&s.watches, &a, "w1".into(), forever()).is_ok());
        tauri::async_runtime::block_on(s.set_context(Some("b".into())));
        // Stopped by the switch.
        assert!(s.watches.lock().unwrap().is_empty());
        // Still in flight for "a" when the window switched: handed back.
        let late = s.insert_on(&s.watches, &a, "w2".into(), forever());
        late.unwrap_err().abort();
        assert!(s.watches.lock().unwrap().is_empty());
        let b = Some("b".to_string());
        assert!(s.insert_on(&s.watches, &b, "w3".into(), forever()).is_ok());
        assert_eq!(s.watches.lock().unwrap().len(), 1);
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
        assert_eq!(main.selected_context(), None);
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
        // The window opening: nothing changes.
        assert!(state.page_load("cluster-1").is_none());
        assert!(Arc::ptr_eq(&first, &state.session("cluster-1")));
        assert!(!first.is_closed());
        // A reload: the old session is closed, the new one is live.
        assert!(state.page_load("cluster-1").is_some());
        assert!(first.is_closed());
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
    fn closing_a_window_stops_only_its_session() {
        let state = AppState::default();
        let a = state.session(MAIN_WINDOW);
        state.open("cluster-1", None);
        let b = state.session("cluster-1");
        let (wa, wb) = (forever(), forever());
        a.add_watch("w1".into(), wa);
        b.add_watch("w2".into(), wb);
        b.add_drain("d1".into(), forever());
        b.log_streams.start(1, forever).unwrap();

        state.close("cluster-1");
        assert!(b.is_closed());
        assert!(b.watches.lock().unwrap().is_empty());
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
        assert_eq!(typed.try_recv().unwrap(), kubeloupe::END_SHELL_KEYS);
    }

    #[test]
    fn closing_an_attach_session_only_detaches() {
        let (session, typed) = shell(false);
        tauri::async_runtime::block_on(session.close());
        assert!(typed.try_recv().is_err());
    }

    #[test]
    fn switching_context_hands_back_the_terminals_to_close() {
        let session = ClusterSession::new(Some("a".into()), Default::default());
        let (s, typed) = shell(true);
        assert!(session.add_exec("exec-1".into(), s).is_none());
        let stopped = tauri::async_runtime::block_on(session.set_context(None));
        assert!(session.exec_sessions.lock().unwrap().is_empty());
        assert_eq!(stopped.len(), 1);
        tauri::async_runtime::block_on(async {
            for s in stopped {
                s.close().await;
            }
        });
        assert_eq!(typed.try_recv().unwrap(), kubeloupe::END_SHELL_KEYS);
    }

    #[test]
    fn switching_context_stops_everything_and_forgets_the_cluster() {
        let session = ClusterSession::new(Some("a".into()), Default::default());
        session.add_watch("w".into(), forever());
        tauri::async_runtime::block_on(session.set_context(Some("b".into())));
        assert!(session.watches.lock().unwrap().is_empty());
        assert!(session.usage.lock().unwrap().is_empty());
        assert!(session.kinds.lock().unwrap().is_empty());
        assert_eq!(session.selected_context().as_deref(), Some("b"));
        assert!(!session.is_closed());
    }
}
