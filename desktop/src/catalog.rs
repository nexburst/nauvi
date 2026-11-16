//! The kubeconfig sources of the cluster catalog (#78): the default
//! kubeconfig plus the files and folders added in the app (kept in
//! Settings), shared by every window's session. A background thread polls
//! them and tells the windows when a file changes.

mod approvals;
#[cfg(test)]
mod gate_tests;

pub(crate) use approvals::ExecAnswer;

use approvals::{not_allowed_message, Approvals};
use kubeloupe::catalog::{
    default_kubeconfig_paths, expand_home, load_catalog, sources_fingerprint, Catalog, CatalogInput,
};
use kubeloupe::ContextTarget;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_specta::Event;

/// How often the files are checked for changes.
const POLL_EVERY: Duration = Duration::from_secs(3);

#[derive(Default)]
pub(crate) struct KubeconfigSources {
    /// The added files and folders, pasted files included, in order.
    extra: Mutex<Vec<PathBuf>>,
    /// Where pasted kubeconfigs are saved (`None`: no config directory).
    pasted_dir: Mutex<Option<PathBuf>>,
    /// The answers about added kubeconfigs' login commands (#201), read
    /// from the config directory on first use.
    approvals: Mutex<Option<Approvals>>,
}

/// A login command of an added source, and the contexts that run it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub(crate) struct ExecCommand {
    /// The command line, as it runs.
    pub(crate) command: String,
    /// The ids of the contexts that log in with it.
    pub(crate) contexts: Vec<String>,
    pub(crate) answer: ExecAnswer,
}

impl KubeconfigSources {
    /// Set the added sources (paths as saved in Settings; `~` is expanded).
    pub(crate) fn set_extra(&self, paths: &[String]) {
        *self.extra.lock().unwrap() = paths.iter().map(|p| expand_home(p)).collect();
    }

    pub(crate) fn set_pasted_dir(&self, dir: Option<PathBuf>) {
        *self.pasted_dir.lock().unwrap() = dir;
    }

    pub(crate) fn pasted_dir(&self) -> Option<PathBuf> {
        self.pasted_dir.lock().unwrap().clone()
    }

    fn input(&self) -> CatalogInput {
        CatalogInput::here(self.extra.lock().unwrap().clone(), self.pasted_dir())
    }

    /// Every context and source, read from the files now.
    pub(crate) fn catalog(&self) -> Catalog {
        load_catalog(&self.input())
    }

    /// Which file and context the context id `id` connects with (`None`:
    /// the default kubeconfig's current-context).
    pub(crate) fn resolve(&self, id: Option<&str>) -> Result<ContextTarget, String> {
        self.catalog().resolve(id).map_err(|e| e.to_string())
    }

    /// The API server URL of context `id` (`None`: the default kubeconfig's
    /// current-context), `""` if it is not known (in-cluster config).
    pub(crate) fn server(&self, id: Option<&str>) -> String {
        let catalog = self.catalog();
        let id = id.unwrap_or(&catalog.current_context);
        catalog
            .find(id)
            .map(|c| c.server.clone())
            .unwrap_or_default()
    }

    /// Run `f` on the approvals, loading them first.
    fn with_approvals<T>(&self, f: impl FnOnce(&mut Approvals) -> T) -> T {
        let mut slot = self.approvals.lock().unwrap();
        let approvals = slot.get_or_insert_with(|| {
            // The pasted files' folder is `<config>/kubeconfigs`.
            let config = self
                .pasted_dir()
                .and_then(|d| d.parent().map(PathBuf::from));
            Approvals::load(config.map(|c| c.join("exec-approvals.json")))
        });
        f(approvals)
    }

    /// The login commands of the added source `source` (as listed in the
    /// sources), with the contexts that use each and the user's answer.
    pub(crate) fn exec_commands(&self, source: &str) -> Vec<ExecCommand> {
        let catalog = self.catalog();
        let mut out: Vec<ExecCommand> = Vec::new();
        for c in catalog.contexts.iter().filter(|c| c.source == source) {
            if c.login_command.is_empty() {
                continue;
            }
            match out.iter_mut().find(|e| e.command == c.login_command) {
                Some(e) => e.contexts.push(c.name.clone()),
                None => out.push(ExecCommand {
                    command: c.login_command.clone(),
                    contexts: vec![c.name.clone()],
                    answer: self.with_approvals(|a| a.answer(source, &c.login_command)),
                }),
            }
        }
        out
    }

    /// Remember whether `command` of `source` may run.
    pub(crate) fn answer_exec(
        &self,
        source: &str,
        command: &str,
        allow: bool,
    ) -> Result<(), String> {
        self.with_approvals(|a| a.set(source, command, allow))
    }

    /// Forget the answers about a removed source.
    pub(crate) fn forget_exec_answers(&self, source: &str) -> Result<(), String> {
        self.with_approvals(|a| a.forget_source(source))
    }

    /// Whether logging in to context `id` may run its login command: always
    /// for the default kubeconfig, and for an added source once the user
    /// allowed that command. The error is the message to show.
    pub(crate) fn may_log_in(&self, id: &str) -> Result<(), String> {
        let catalog = self.catalog();
        let Some(c) = catalog.find(id) else {
            return Ok(());
        };
        if c.source.is_empty() || c.login_command.is_empty() {
            return Ok(());
        }
        match self.with_approvals(|a| a.answer(&c.source, &c.login_command)) {
            ExecAnswer::Allowed => Ok(()),
            answer => Err(not_allowed_message(id, &c.login_command, &c.source, answer)),
        }
    }

    /// The files and folders whose changes the windows hear about.
    fn watched(&self) -> Vec<PathBuf> {
        let mut paths = default_kubeconfig_paths();
        paths.extend(self.extra.lock().unwrap().iter().cloned());
        paths
    }
}

/// Sent to every window when a kubeconfig source changes (a file edited,
/// added to a folder, or a source added or removed).
#[derive(Debug, Clone, serde::Serialize, specta::Type, tauri_specta::Event)]
pub(crate) struct KubeconfigsChanged {
    pub(crate) generation: u32,
}

/// Tell every window the contexts may have changed.
pub(crate) fn announce(app: &AppHandle) {
    static GENERATION: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let _ = KubeconfigsChanged { generation }.emit(app);
}

/// Poll the sources in the background for as long as the app runs.
pub(crate) fn watch(app: AppHandle, sources: Arc<KubeconfigSources>) {
    std::thread::spawn(move || {
        let mut last = sources_fingerprint(&sources.watched());
        loop {
            std::thread::sleep(POLL_EVERY);
            let now = sources_fingerprint(&sources.watched());
            if now != last {
                last = now;
                announce(&app);
            }
        }
    });
}
