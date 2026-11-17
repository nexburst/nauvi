//! Reading and changing the remembered settings (`settings.rs`).

use crate::commands::exec::{emit_note, ExecClosed};
use crate::settings::{Settings, SettingsPatch, SettingsStore};
use crate::state::{AppState, WindowEmitter};
use nauvi::context_mode::{ContextMode, ModeSource};
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
    // Where the context comes from, so `nauvi mcp` finds the mode by file
    // and context name whatever id it gives the context.
    let source = state
        .sources
        .catalog()
        .find(&id)
        .map(|c| ModeSource::new(std::path::Path::new(&c.file), &c.context))
        .unwrap_or_default();
    let settings = store.set_context_mode_from(&id, mode, source);
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
        for sid in shells.keys() {
            emit_note(&out, sid, &note);
        }
        // Dropping a local shell kills it; its exit sends `ExecClosed`.
        drop(shells);
        let note = note.clone();
        tauri::async_runtime::spawn(async move {
            for (sid, exec) in execs {
                // A shell that ends sends `ExecClosed` itself; an attach
                // only detaches, so it is sent here.
                let ends = exec.end_on_close;
                exec.close().await;
                // After the shell's last words, so it reads as the reason.
                emit_note(&out, &sid, &note);
                if !ends {
                    out.emit(ExecClosed(sid));
                }
            }
        });
    }
}
