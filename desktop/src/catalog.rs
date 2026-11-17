//! The kubeconfig sources of the cluster catalog (#78): the default
//! kubeconfig plus the files and folders added in the app (kept in
//! Settings), shared by every window's session. A background thread polls
//! them and tells the windows when a file changes.

mod approvals;
#[cfg(test)]
mod gate_tests;
mod proxies;

pub(crate) use approvals::ExecAnswer;

use approvals::{not_allowed_message, Approvals};
use kube::config::Kubeconfig;
use nauvi::catalog::{
    context_local_files, context_login_command, default_kubeconfig_paths, expand_home,
    flatten_context, load_catalog, sources_fingerprint, Catalog, CatalogInput,
};
use nauvi::errors::kubeconfig_error_text;
use nauvi::proxy::ClusterProxy;
use nauvi::{client_for_target_via, client_from_kubeconfig_via, ContextTarget};
use proxies::ProxyStore;
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
    /// The proxies set per cluster (#329), read from the config directory
    /// on first use.
    proxies: Mutex<Option<ProxyStore>>,
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

    /// The config directory: the pasted files' folder is
    /// `<config>/kubeconfigs`.
    fn config_dir(&self) -> Option<PathBuf> {
        self.pasted_dir()
            .and_then(|d| d.parent().map(PathBuf::from))
    }

    /// Run `f` on the approvals, loading them first.
    fn with_approvals<T>(&self, f: impl FnOnce(&mut Approvals) -> T) -> T {
        let mut slot = self.approvals.lock().unwrap();
        let approvals = slot.get_or_insert_with(|| {
            Approvals::load(self.config_dir().map(|c| c.join("exec-approvals.json")))
        });
        f(approvals)
    }

    /// Run `f` on the proxies (#329), loading them first.
    fn with_proxies<T>(&self, f: impl FnOnce(&mut ProxyStore) -> T) -> T {
        let mut slot = self.proxies.lock().unwrap();
        let store = slot.get_or_insert_with(|| {
            ProxyStore::load(self.config_dir().map(|c| c.join("proxies.json")))
        });
        f(store)
    }

    /// The proxy set for the cluster of context `id` (#329).
    pub(crate) fn proxy(&self, id: &str) -> Option<ClusterProxy> {
        self.with_proxies(|p| p.get(id))
    }

    /// Set (`Some`) or remove (`None`) the proxy of context `id`. Clients
    /// built from now on use it.
    pub(crate) fn set_proxy(&self, id: &str, proxy: Option<ClusterProxy>) -> Result<(), String> {
        self.with_proxies(|p| p.set(id, proxy))
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

    /// Context `id` (`None`: the default kubeconfig's current-context),
    /// checked against the answers about added kubeconfigs' login commands
    /// (#201): the default kubeconfig always passes, an added file's
    /// context once the user allowed its command.
    ///
    /// The added file is read once, here: the command checked is the one
    /// in the returned [`Approved::kubeconfig`], which is what the client,
    /// helm and local shells then use (#242). A file swapped afterwards is
    /// not read again.
    pub(crate) fn approved(&self, id: Option<&str>) -> Result<Approved, GateError> {
        let catalog = self.catalog();
        let target = catalog
            .resolve(id)
            .map_err(|e| GateError::Invalid(e.to_string()))?;
        let proxy = self.proxy(&target.id);
        let Some(file) = target.kubeconfig.clone() else {
            return Ok(Approved {
                target,
                kubeconfig: None,
                proxy,
            });
        };
        let source = catalog
            .find(&target.id)
            .map(|c| c.source.clone())
            .unwrap_or_default();
        let kubeconfig = Kubeconfig::read_from(&file)
            .map_err(|e| GateError::Invalid(kubeconfig_error_text(&e, Some(&file))))?;
        let command = context_login_command(&kubeconfig, &target.context);
        if !command.is_empty() {
            match self.with_approvals(|a| a.answer(&source, &command)) {
                ExecAnswer::Allowed => {}
                answer => {
                    return Err(GateError::NotAllowed(not_allowed_message(
                        &target.id, &command, &source, answer,
                    )))
                }
            }
        }
        Ok(Approved {
            target,
            kubeconfig: Some(kubeconfig),
            proxy,
        })
    }

    /// The files and folders whose changes the windows hear about.
    fn watched(&self) -> Vec<PathBuf> {
        let mut paths = default_kubeconfig_paths();
        paths.extend(self.extra.lock().unwrap().iter().cloned());
        paths
    }
}

/// A context that may log in (see [`KubeconfigSources::approved`]).
#[derive(Debug)]
pub(crate) struct Approved {
    pub(crate) target: ContextTarget,
    /// The added file as it was read for the check (`None`: the default
    /// kubeconfig, which has no check).
    pub(crate) kubeconfig: Option<Kubeconfig>,
    /// The proxy set for the cluster in the app (#329), which its client
    /// connects through.
    pub(crate) proxy: Option<ClusterProxy>,
}

impl Approved {
    /// The client of the context, from the checked kubeconfig, through
    /// the cluster's proxy if one is set. Never prompts.
    pub(crate) async fn client(self) -> anyhow::Result<kube::Client> {
        let proxy = self.proxy.as_ref();
        match self.kubeconfig {
            Some(kc) => {
                client_from_kubeconfig_via(kc, Some(&self.target.context), false, proxy).await
            }
            None => client_for_target_via(&self.target, false, proxy).await,
        }
    }

    /// The local files outside the added file's folder that logging in
    /// sends (#244), from the file as it was read for the check (`[]`: none,
    /// or the default kubeconfig).
    pub(crate) fn local_files(&self) -> Vec<String> {
        match (&self.kubeconfig, &self.target.kubeconfig) {
            (Some(kc), Some(file)) => context_local_files(kc, &self.target.context, file),
            _ => vec![],
        }
    }

    /// A private temp copy of an added file's context for helm and local
    /// shells (`None`: the default kubeconfig, which they read themselves).
    pub(crate) fn flat(&self) -> Result<Option<Kubeconfig>, String> {
        let (Some(kc), Some(file)) = (&self.kubeconfig, &self.target.kubeconfig) else {
            return Ok(None);
        };
        flatten_context(kc, &self.target.context, file)
            .map(Some)
            .map_err(|e| format!("{e:#}"))
    }
}

/// Why a context may not log in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GateError {
    /// Its id, file or entry is broken.
    Invalid(String),
    /// Its login command is not allowed (yet).
    NotAllowed(String),
}

impl From<GateError> for String {
    fn from(e: GateError) -> String {
        match e {
            GateError::Invalid(m) | GateError::NotAllowed(m) => m,
        }
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
