#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use crate::settings::SettingsStore;
use crate::state::AppState;
use tauri::Manager;
use tauri_specta::Builder;

mod catalog;
mod commands;
mod local_shell;
mod log_streams;
mod settings;
#[cfg(unix)]
mod shell_env;
mod state;
mod updater;
mod webview_args;
mod windows;

/// Where the generated bindings live.
const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/ui-src/src/lib/bindings.ts");

fn export_bindings(builder: &Builder<tauri::Wry>) {
    builder
        .export(specta_typescript::Typescript::default(), BINDINGS_PATH)
        .expect("failed to export TypeScript bindings");
}

fn main() {
    // First, before any thread starts: it changes the process environment.
    #[cfg(unix)]
    shell_env::import_login_shell_env();

    let builder = commands::specta_builder();
    #[cfg(debug_assertions)]
    export_bindings(&builder);

    let mut context = tauri::generate_context!();
    if let Some(args) = webview_args::from_env() {
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(args.clone());
        }
    }

    tauri::Builder::default()
        .manage(AppState::default())
        // Opens forwarded URLs in the browser; the capability limits it to
        // http://127.0.0.1 and http://localhost.
        .plugin(tauri_plugin_opener::init())
        // In-app updates (#30): the check and the install run from
        // `commands/updater.rs`; `process` restarts into the new version.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let config_dir = app.path().app_config_dir().ok();
            let store = SettingsStore::open(config_dir.as_ref().map(|d| d.join("settings.json")));
            // The catalog's added kubeconfigs (#78), before any window
            // looks a context up.
            let sources = app.state::<AppState>().sources.clone();
            sources.set_pasted_dir(config_dir.map(|d| d.join("kubeconfigs")));
            sources.set_extra(&store.get().kubeconfig_sources);
            catalog::watch(app.handle().clone(), sources);
            app.manage(store);
            commands::updater::manage(app.handle());
            windows::restore_windows(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a window stops everything it started.
            if let tauri::WindowEvent::Destroyed = event {
                windows::window_destroyed(window.app_handle(), window.label());
            }
        })
        .build(context)
        .expect("error while building kubeloupe")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                windows::before_exit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regenerates `bindings.ts`; CI runs this and fails if the committed
    /// file changes.
    #[test]
    fn export_typescript_bindings() {
        export_bindings(&commands::specta_builder());
    }
}
