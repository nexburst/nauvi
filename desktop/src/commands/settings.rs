//! Reading and changing the remembered settings (`settings.rs`).

use crate::settings::{Settings, SettingsPatch, SettingsStore};
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
    store: State<'_, Arc<SettingsStore>>,
    id: String,
    mode: nauvi::context_mode::ContextMode,
) -> Result<Settings, String> {
    if id.is_empty() {
        return Err("No context is selected".into());
    }
    tracing::info!("context {id} is now {}", mode.label());
    Ok(store.set_context_mode(&id, mode))
}
