//! Local shells in the dock, pointed at the app's context and namespace.
//! Output arrives on the channel the tab passes in, then `closed` when the
//! shell exits, like pod terminals.

use crate::catalog::Approved;
use crate::commands::term_frame::{send_closed, send_data, TermChannel};
use crate::local_shell::{LocalShell, ShellSpec};
use crate::settings::SettingsStore;
use crate::state::mutation::Mutation;
use crate::state::{next_session, Cluster, LocalShellSession};
use nauvi::catalog::expand_home;
use nauvi::kubectl_download::path_with_first;
use nauvi::{
    flat_shell_kubeconfig, shell_kubeconfig, shell_kubeconfig_env_for, ShellKubeconfig,
    TempKubeconfig,
};
use serde::Serialize;
use specta::Type;
use std::ffi::OsString;
use std::sync::Arc;
use tauri::State;

/// A started local shell: its session id, and the context and namespace
/// kubectl uses in it.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct LocalShellStarted {
    session: String,
    context: String,
    namespace: String,
    /// The release of the downloaded kubectl first on `PATH` in this shell
    /// (#331), `""`: none, the user's own kubectl is used.
    kubectl: String,
}

/// Start the user's shell on this machine with `KUBECONFIG` pointing at a
/// temp kubeconfig that selects the app's context and `namespace` (`null`:
/// the context's own) (see [`shell_kubeconfig_for`]).
/// It starts in the cluster's working directory from its settings (#78),
/// else the home directory. The user's kubeconfig files are not changed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_local_shell_start(
    cluster: Mutation,
    settings: State<'_, Arc<SettingsStore>>,
    namespace: Option<String>,
    cols: u16,
    rows: u16,
    on_output: TermChannel,
) -> Result<LocalShellStarted, String> {
    let approved = cluster.target()?;
    let target = &approved.target;
    let current = settings.get();
    let cwd = current
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
    let (generated, temp, env) = shell_kubeconfig_for(&approved, namespace.as_deref())?;
    spec.env.push(("KUBECONFIG".into(), env));
    // A kubectl matching the cluster, downloaded before (#331): first on
    // PATH in this shell's environment only.
    let matched = crate::commands::kubectl::terminal_kubectl(&cluster, current.kubectl_match).await;
    if let Some((_, dir)) = &matched {
        let path = path_with_first(dir, std::env::var_os("PATH").as_deref());
        spec.env.push(("PATH".into(), path));
    }

    let session = next_session("local");
    let (out, exit_out) = (on_output.clone(), on_output.clone());
    let shell = LocalShell::spawn(
        &spec,
        cols,
        rows,
        Some(temp),
        move |data| {
            send_data(&out, data.into_bytes());
        },
        move || {
            send_closed(&exit_out);
        },
    )?;
    cluster.add_local_shell(
        session.clone(),
        LocalShellSession {
            shell,
            out: on_output,
        },
    );
    Ok(LocalShellStarted {
        session,
        context: generated.context,
        namespace: generated.namespace,
        kubectl: matched.map(|(v, _)| v.tag()).unwrap_or_default(),
    })
}

/// The temp kubeconfig of a shell at `approved` with `namespace`, and the
/// shell's `KUBECONFIG`. For the default kubeconfig: a file selecting the
/// context and namespace, then the user's files. For an added kubeconfig:
/// only a flattened copy of the context as it was read when its login
/// command was checked, never the added file, so editing that file later
/// cannot make kubectl in the shell run another command (#242).
pub(crate) fn shell_kubeconfig_for(
    approved: &Approved,
    namespace: Option<&str>,
) -> Result<(ShellKubeconfig, TempKubeconfig, OsString), String> {
    let generated = match approved.flat()? {
        Some(flat) => flat_shell_kubeconfig(&flat, namespace),
        None => {
            let kubeconfig = kube::config::Kubeconfig::read().map_err(|e| {
                format!(
                    "cannot read the kubeconfig: {}",
                    nauvi::errors::chain_text(&e)
                )
            })?;
            shell_kubeconfig(&kubeconfig, Some(&approved.target.context), namespace)
        }
    }
    .map_err(|e| format!("{e:#}"))?;
    let temp = TempKubeconfig::create(&generated.yaml).map_err(|e| format!("{e:#}"))?;
    let env = match approved.kubeconfig {
        Some(_) => temp.path().as_os_str().to_owned(),
        None => shell_kubeconfig_env_for(temp.path(), None),
    };
    Ok((generated, temp, env))
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
    shell.shell.write(data.into_bytes())
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
        Some(s) => s.shell.resize(cols, rows),
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
