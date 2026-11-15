//! Local shells in the dock, pointed at the app's context and namespace.
//! Output arrives as `exec-output` events and `exec-closed` when the shell
//! exits, like pod terminals.

use crate::commands::exec::{ExecClosed, ExecOutput};
use crate::local_shell::{LocalShell, ShellSpec};
use crate::settings::SettingsStore;
use crate::state::{next_session, Cluster};
use kubeloupe::catalog::expand_home;
use kubeloupe::{shell_kubeconfig, shell_kubeconfig_env_for, TempKubeconfig};
use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::State;

/// A started local shell: its session id, and the context and namespace
/// kubectl uses in it.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct LocalShellStarted {
    session: String,
    context: String,
    namespace: String,
}

/// Start the user's shell on this machine with `KUBECONFIG` pointing at a
/// temp kubeconfig that selects the app's context and `namespace` (`null`:
/// the context's own), followed by the kubeconfig the context comes from.
/// It starts in the cluster's working directory from its settings (#78),
/// else the home directory. The user's kubeconfig files are not changed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_local_shell_start(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespace: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<LocalShellStarted, String> {
    let target = cluster.target()?;
    let kubeconfig = match &target.kubeconfig {
        Some(file) => kube::config::Kubeconfig::read_from(file),
        None => kube::config::Kubeconfig::read(),
    }
    .map_err(|e| format!("cannot read the kubeconfig: {e}"))?;
    let generated = shell_kubeconfig(&kubeconfig, Some(&target.context), namespace.as_deref())
        .map_err(|e| e.to_string())?;
    let cwd = settings
        .get()
        .contexts
        .get(&target.id)
        .map(|c| c.shell_cwd.trim().to_string())
        .unwrap_or_default();
    let mut spec = ShellSpec::user_shell();
    if !cwd.is_empty() {
        let dir = expand_home(&cwd);
        if !dir.is_dir() {
            return Err(format!(
                "The local shell's working directory set for {} is not a folder: {cwd}. \
                 Change it in the cluster's settings.",
                target.id
            ));
        }
        spec.cwd = Some(dir);
    }
    let temp = TempKubeconfig::create(&generated.yaml).map_err(|e| format!("{e:#}"))?;
    spec.env.push((
        "KUBECONFIG".into(),
        shell_kubeconfig_env_for(temp.path(), target.kubeconfig.as_deref()),
    ));

    let session = next_session("local");
    let (out_app, out_session) = (cluster.emitter(), session.clone());
    let (exit_app, exit_session) = (cluster.emitter(), session.clone());
    let shell = LocalShell::spawn(
        &spec,
        cols,
        rows,
        Some(temp),
        move |data| {
            out_app.emit(ExecOutput::stdout(out_session.clone(), data));
        },
        move || {
            exit_app.emit(ExecClosed(exit_session));
        },
    )?;
    cluster.add_local_shell(session.clone(), shell);
    Ok(LocalShellStarted {
        session,
        context: generated.context,
        namespace: generated.namespace,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_local_shell_input(
    cluster: Cluster,
    session: String,
    data: String,
) -> Result<(), String> {
    let shells = cluster.local_shells.lock().unwrap();
    let shell = shells
        .get(&session)
        .ok_or_else(|| "local shell not found".to_string())?;
    shell.write(data.into_bytes())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_local_shell_resize(
    cluster: Cluster,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let shells = cluster.local_shells.lock().unwrap();
    match shells.get(&session) {
        Some(shell) => shell.resize(cols, rows),
        None => Ok(()),
    }
}

/// Kill the shell and delete its temp kubeconfig.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_local_shell_close(cluster: Cluster, session: String) -> Result<(), String> {
    let shell = cluster.local_shells.lock().unwrap().remove(&session);
    drop(shell);
    Ok(())
}
