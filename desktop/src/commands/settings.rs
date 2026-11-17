//! Reading and changing the remembered settings (`settings.rs`).

use crate::commands::exec::{emit_note, ExecClosed};
use crate::settings::{Settings, SettingsPatch, SettingsStore};
use crate::state::{spawn_closes, AppState, WindowEmitter};
use nauvi::context_mode::ContextMode;
use std::sync::Arc;
use tauri::State;

/// The settings, as loaded on start and changed since.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_get_settings(store: State<'_, Arc<SettingsStore>>) -> Result<Settings, String> {
    Ok(store.get())
}

/// Apply `patch` (fields left out are kept) and return the new settings.
/// The file is written shortly after, once changes stop.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_update_settings(
    store: State<'_, Arc<SettingsStore>>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    Ok(store.update(patch))
}

/// Make the context `id` read-only, protected or normal again (#338).
/// Its own command, not part of a settings patch, so a window with an
/// older copy of the settings cannot undo it.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_set_context_mode(
    app: tauri::AppHandle,
    store: State<'_, Arc<SettingsStore>>,
    state: State<'_, AppState>,
    id: String,
    mode: ContextMode,
) -> Result<Settings, String> {
    if id.is_empty() {
        return Err("No context is selected".into());
    }
    tracing::info!("context {id} is now {}", mode.label());
    let settings = store.set_context_mode(&id, mode);
    if mode == ContextMode::ReadOnly {
        close_terminals(&app, &state, &id);
    }
    Ok(settings)
}

/// A context turned read-only: close the terminals open on it in every
/// window (exec, attach, debug and node shells, local shells), each with a
/// note saying why. Port-forwards, logs and watches go on.
fn close_terminals(app: &tauri::AppHandle, state: &AppState, id: &str) {
    let note = format!("{id} is now read-only: this terminal was closed");
    for (label, session) in state.sessions_of(id) {
        let out = WindowEmitter::new(app.clone(), label);
        let (execs, shells) = session.take_terminals();
        for sid in execs.keys() {
            emit_note(&out, sid, &note);
            out.emit(ExecClosed(sid.clone()));
        }
        for sid in shells.keys() {
            emit_note(&out, sid, &note);
        }
        // Dropping a local shell kills it; its exit sends `ExecClosed`.
        drop(shells);
        spawn_closes(execs.into_values().collect());
    }
}
