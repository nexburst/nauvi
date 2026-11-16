//! The cluster catalog (#78): kubeconfig sources added in the app, pasted
//! kubeconfigs and a status check per context. The contexts themselves come
//! from `cmd_list_contexts`. The user's kubeconfig files are only read;
//! the app writes and deletes only the pasted files it saved itself.

use crate::catalog::{announce, ExecCommand, GateError, KubeconfigSources};
use crate::settings::SettingsStore;
use crate::state::AppState;
use kubeloupe::catalog::{
    check_source, check_with, expand_home, save_pasted_kubeconfig, ContextCheck, ContextState,
    SourceInfo,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Every source of contexts: the default kubeconfig's files, then the
/// added ones in order, each with what was read from it or why it could
/// not be.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_kubeconfig_sources(
    state: State<'_, AppState>,
) -> Result<Vec<SourceInfo>, String> {
    Ok(state.sources.catalog().sources)
}

/// Add a kubeconfig file or a folder of them (`~` expands). Its contexts
/// show up in every window. Returns the sources.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_add_kubeconfig_source(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, Arc<SettingsStore>>,
    path: String,
) -> Result<Vec<SourceInfo>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Type the path of a kubeconfig file or folder.".to_string());
    }
    let full = expand_home(trimmed);
    if !full.is_absolute() {
        return Err(format!(
            "Use a full path (for example ~/.kube/work.yaml), not {trimmed}."
        ));
    }
    let catalog = state.sources.catalog();
    let shown = full.display().to_string();
    if catalog.sources.iter().any(|s| same_file(&s.path, &full)) {
        return Err(format!("{shown} is already a source."));
    }
    check_source(&full).map_err(|e| e.to_string())?;
    set_sources(&app, &state.sources, &store, |list| list.push(shown));
    Ok(state.sources.catalog().sources)
}

/// Remove an added source. A pasted kubeconfig's file is deleted too (the
/// app saved it); any other file stays where it is, untouched.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_remove_kubeconfig_source(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, Arc<SettingsStore>>,
    path: String,
) -> Result<Vec<SourceInfo>, String> {
    let saved = store.get().kubeconfig_sources;
    if !saved.iter().any(|p| p == &path) {
        return Err(format!(
            "{path} was not added in kubeloupe, so it cannot be removed here. \
             The default kubeconfig comes from KUBECONFIG or ~/.kube/config."
        ));
    }
    let file = expand_home(&path);
    // Added again later, its commands are asked about again.
    if let Err(e) = state
        .sources
        .forget_exec_answers(&file.display().to_string())
    {
        tracing::warn!("{e}");
    }
    if is_pasted(&state.sources, &file) {
        if let Err(e) = std::fs::remove_file(&file) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!(
                    "Could not delete the pasted kubeconfig {path}: {e}"
                ));
            }
        }
    }
    set_sources(&app, &state.sources, &store, |list| {
        list.retain(|p| p != &path)
    });
    Ok(state.sources.catalog().sources)
}

/// Save a pasted kubeconfig in the app's config directory (readable only by
/// the user) and add it as a source. `name` names the file (`""`: its
/// first context). Returns the sources.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_paste_kubeconfig(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, Arc<SettingsStore>>,
    yaml: String,
    name: String,
) -> Result<Vec<SourceInfo>, String> {
    let dir = state
        .sources
        .pasted_dir()
        .ok_or_else(|| "There is no app config directory to save the kubeconfig in.".to_string())?;
    let path = save_pasted_kubeconfig(&dir, &yaml, &name).map_err(|e| format!("{e:#}"))?;
    let shown = path.display().to_string();
    set_sources(&app, &state.sources, &store, |list| list.push(shown));
    Ok(state.sources.catalog().sources)
}

/// Log in to context `name`'s cluster and report whether it answers. Never
/// prompts; gives up after 15 s. `asked`: the user chose to check this
/// context; otherwise (the catalog opening, Check all) an added file's
/// context that sends local files from outside its folder is not checked
/// (#244).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_check_context(
    state: State<'_, AppState>,
    name: String,
    asked: bool,
) -> Result<ContextCheck, String> {
    // The client is built from the file as it was read for the gate (#242).
    let (state, message) = match state.sources.approved(Some(&name)) {
        Ok(approved) => {
            let id = approved.target.id.clone();
            let files = approved.local_files();
            if asked || files.is_empty() {
                return Ok(check_with(&id, approved.client()).await);
            }
            (ContextState::LocalFiles, local_files_message(&id, &files))
        }
        Err(GateError::Invalid(message)) => (ContextState::Invalid, message),
        Err(GateError::NotAllowed(message)) => (ContextState::NotAllowed, message),
    };
    Ok(ContextCheck {
        name,
        state,
        message,
        version: String::new(),
    })
}

/// Why context `id` was not checked: logging in would send `files`.
fn local_files_message(id: &str, files: &[String]) -> String {
    format!(
        "Not checked: logging in to `{id}` sends local files from outside its kubeconfig's folder \
         ({}). Choose Check to check it.",
        files.join(", ")
    )
}

/// The login commands (exec plugins) of the added source `source`, with the
/// contexts that run each and whether the user allowed it. The catalog asks
/// before any of them runs (#201).
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_exec_commands(
    state: State<'_, AppState>,
    source: String,
) -> Result<Vec<ExecCommand>, String> {
    Ok(state.sources.exec_commands(&source))
}

/// Allow (or refuse) running `command` to log in to the contexts of the
/// added source `source`. Remembered until the source is removed.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_answer_exec_command(
    state: State<'_, AppState>,
    source: String,
    command: String,
    allow: bool,
) -> Result<(), String> {
    state.sources.answer_exec(&source, &command, allow)
}

/// Change the saved list of added sources, apply it, and tell the windows.
fn set_sources(
    app: &AppHandle,
    sources: &KubeconfigSources,
    store: &Arc<SettingsStore>,
    change: impl FnOnce(&mut Vec<String>),
) {
    let next = store.modify(|s| change(&mut s.kubeconfig_sources));
    sources.set_extra(&next.kubeconfig_sources);
    announce(app);
}

fn is_pasted(sources: &KubeconfigSources, file: &Path) -> bool {
    sources
        .pasted_dir()
        .is_some_and(|dir| file.parent() == Some(dir.as_path()))
}

fn same_file(a: &str, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(&PathBuf::from(a)) == canon(b)
}
