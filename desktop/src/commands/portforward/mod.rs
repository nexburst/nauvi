//! Port-forwards. They live here in the backend, independent of the panel
//! that started them, until stopped, until the context changes or until their window
//! closes.
//!
//! Every forward is also saved for its context (#217, `saved.rs`): after a
//! restart it comes back stopped, or started if the user checked "Start
//! automatically".

pub(crate) mod saved;

use crate::settings::{SavedForward, SettingsStore};
use crate::state::mutation::ForwardStart;
use crate::state::{next_session, AppState, Cluster, ForwardSession, SWITCHED};
use nauvi::{
    service_ports, ForwardStatus, ForwardTarget, LocalPort, PortForward, RemotePort,
    ServicePortInfo,
};
use saved::{local_text, now_ms, parse_local};
use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::State;

/// One running forward, with its live status.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct ForwardInfo {
    id: String,
    /// The saved forward it runs (see `cmd_portforward_saved`).
    saved_id: String,
    target: ForwardTarget,
    /// The remote port as asked for: a number or a port name.
    remote: String,
    /// Its number on the target (the Service port or the pod port).
    remote_port: u16,
    local_port: u16,
    /// `http://127.0.0.1:<local_port>`, or `https://` for a TLS target.
    url: String,
    /// Epoch milliseconds.
    started_at: u64,
    status: ForwardStatus,
}

fn info(id: &str, s: &ForwardSession) -> ForwardInfo {
    let f = &s.forward;
    let scheme = if s.https { "https" } else { "http" };
    ForwardInfo {
        id: id.to_string(),
        saved_id: s.saved_id.clone(),
        target: f.target.clone(),
        remote: f.remote.to_string(),
        remote_port: f.remote_port,
        local_port: f.local_port,
        url: format!("{scheme}://127.0.0.1:{}", f.local_port),
        started_at: s.started_at,
        status: f.status(),
    }
}

/// Start `saved` in this window with its cluster's forward client (#374) on
/// the cluster, stopping the run of it that is already going first (so an
/// edited forward can take its old local port again). If the window left
/// the cluster meanwhile, the new forward is dropped.
async fn run_saved(cluster: &Cluster, saved: &SavedForward) -> Result<ForwardInfo, String> {
    let old: Vec<ForwardSession> = {
        let mut forwards = cluster.forwards.lock().unwrap();
        let ids: Vec<String> = forwards
            .iter()
            .filter(|(_, s)| s.saved_id == saved.id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| forwards.remove(id)).collect()
    };
    for mut s in old {
        // Wait until its listener is closed.
        s.forward.stop();
        s.forward.wait().await;
    }
    let remote = RemotePort::parse(&saved.remote).map_err(|e| e.to_string())?;
    let local = parse_local(&saved.local_port)?;
    if cluster.is_closed() {
        return Err(SWITCHED.into());
    }
    // The forward client: Nagle off for its tunnels (#374).
    let forward = PortForward::start(
        &cluster.forward_client().await?,
        saved.target.clone(),
        remote,
        LocalPort::from_option(local),
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let id = next_session("pf");
    let session = ForwardSession {
        forward,
        started_at: now_ms(),
        saved_id: saved.id.clone(),
        https: saved.https,
    };
    let out = info(&id, &session);
    // Dropping a refused forward stops it.
    if !cluster.add_forward(id, session) {
        return Err(SWITCHED.into());
    }
    Ok(out)
}

/// Stop every run of the saved forward `saved_id` in this window.
fn stop_saved(cluster: &Cluster, saved_id: &str) {
    let removed: Vec<ForwardSession> = {
        let mut forwards = cluster.forwards.lock().unwrap();
        let ids: Vec<String> = forwards
            .iter()
            .filter(|(_, s)| s.saved_id == saved_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| forwards.remove(id)).collect()
    };
    // Dropping a forward stops it.
    drop(removed);
}

/// Start forwarding `remote_port` (a number or a port name) of a pod,
/// Service or workload. `local_port`: none picks the remote port if it is
/// free and at least 1024, else a random one; 0 is random; any other
/// number is used as is or fails if taken. Asking again for a forward that
/// already runs (same target and port, no explicit local port) returns it.
/// The forward is saved for the context (or reuses the saved one with the
/// same target and ports).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_start(
    cluster: ForwardStart,
    settings: State<'_, Arc<SettingsStore>>,
    target: ForwardTarget,
    remote_port: String,
    local_port: Option<u16>,
) -> Result<ForwardInfo, String> {
    let remote = RemotePort::parse(&remote_port).map_err(|e| e.to_string())?;
    if local_port.is_none() {
        let forwards = cluster.forwards.lock().unwrap();
        if let Some((id, s)) = forwards
            .iter()
            .find(|(_, s)| s.forward.target == target && s.forward.remote == remote)
        {
            return Ok(info(id, s));
        }
    }
    let (selected, _) = cluster.context_client().await?;
    let ctx = cluster.context_id_of(selected.as_deref())?;
    let remote_text = remote_port.trim().to_string();
    let known = saved::list(&settings.get(), &ctx);
    if let Some(s) = saved::matching(&known, &target, &remote_text, local_port) {
        return run_saved(&cluster, s).await;
    }
    let new = saved::normalize(SavedForward {
        id: String::new(),
        target,
        remote: remote_text,
        local_port: local_text(local_port),
        https: false,
        open_in_browser: false,
        auto_start: false,
    })?;
    // Saved once it runs: a forward that never started is not kept.
    let mut stored = Err(String::new());
    settings.modify(|s| stored = saved::upsert(s, &ctx, new.clone()));
    let stored = stored?;
    match run_saved(&cluster, &stored).await {
        Ok(info) => Ok(info),
        Err(e) => {
            settings.modify(|s| saved::remove(s, &ctx, &stored.id));
            Err(e)
        }
    }
}

/// Stop a forward. Stopping one that is already gone is not an error. It
/// stays saved.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_stop(cluster: Cluster, id: String) -> Result<(), String> {
    // Dropping the forward stops it.
    let removed = cluster.forwards.lock().unwrap().remove(&id);
    drop(removed);
    Ok(())
}

/// Every running forward, oldest first.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_list(cluster: Cluster) -> Result<Vec<ForwardInfo>, String> {
    let forwards = cluster.forwards.lock().unwrap();
    let mut out: Vec<ForwardInfo> = forwards.iter().map(|(id, s)| info(id, s)).collect();
    out.sort_by(|a, b| (a.started_at, &a.id).cmp(&(b.started_at, &b.id)));
    Ok(out)
}

/// A running forward and the cluster it runs on (ADR 0007).
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct ClusterForward {
    /// The cluster's id (its context id).
    cluster: String,
    forward: ForwardInfo,
}

/// The running forwards of every cluster the calling window is connected
/// to, by cluster id, then oldest first. Asking does not count as using a
/// cluster: it does not keep an idle one connected.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_list_all(
    webview: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<Vec<ClusterForward>, String> {
    Ok(list_all(&state.window_clusters(webview.label())))
}

fn list_all(sessions: &[Arc<crate::state::ClusterSession>]) -> Vec<ClusterForward> {
    let mut out: Vec<ClusterForward> = sessions
        .iter()
        .flat_map(|s| {
            let forwards = s.forwards.lock().unwrap();
            forwards
                .iter()
                .map(|(id, f)| ClusterForward {
                    cluster: s.id().to_string(),
                    forward: info(id, f),
                })
                .collect::<Vec<_>>()
        })
        .collect();
    out.sort_by(|a, b| {
        (&a.cluster, a.forward.started_at, &a.forward.id).cmp(&(
            &b.cluster,
            b.forward.started_at,
            &b.forward.id,
        ))
    });
    out
}

/// The saved forwards of the selected context, in the order they were added.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_saved(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<Vec<SavedForward>, String> {
    Ok(saved::list(&settings.get(), &cluster.context_id()?))
}

/// Save `forward` for the selected context: a new one (id `""`) or an
/// edit. A running forward keeps its old settings until it is started
/// again (`cmd_portforward_start_saved`).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_save(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    forward: SavedForward,
) -> Result<SavedForward, String> {
    let ctx = cluster.context_id()?;
    let mut out = Err(String::new());
    settings.modify(|s| out = saved::upsert(s, &ctx, forward));
    out
}

/// Start the saved forward `id`, or restart it if it runs.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_start_saved(
    cluster: ForwardStart,
    settings: State<'_, Arc<SettingsStore>>,
    id: String,
) -> Result<ForwardInfo, String> {
    let (selected, _) = cluster.context_client().await?;
    let ctx = cluster.context_id_of(selected.as_deref())?;
    let saved = saved::find(&settings.get(), &ctx, &id)
        .ok_or("this port-forward was deleted in the meantime")?;
    run_saved(&cluster, &saved).await
}

/// Stop the saved forward `id` and forget it. Deleting one that is gone is
/// not an error.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_delete(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    id: String,
) -> Result<(), String> {
    stop_saved(&cluster, &id);
    let ctx = cluster.context_id()?;
    settings.modify(|s| saved::remove(s, &ctx, &id));
    Ok(())
}

/// A saved forward that did not start automatically, and why.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct AutoStartError {
    saved_id: String,
    error: String,
}

/// Start the saved forwards of the selected context marked "Start
/// automatically", except those another window runs already. Called when
/// a window connects to a context. Returns the ones that failed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_autostart(
    cluster: Cluster,
    state: State<'_, AppState>,
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<Vec<AutoStartError>, String> {
    // A window that leaves the cluster meanwhile gets none of its
    // forwards.
    let ctx = cluster.context_id()?;
    let wanted: Vec<SavedForward> = saved::list(&settings.get(), &ctx)
        .into_iter()
        .filter(|f| f.auto_start)
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    // A protected context starts forwards only after the user types its
    // name (#338): none start by themselves, they come back stopped.
    if settings.context_mode(&ctx) == nauvi::context_mode::ContextMode::Protected {
        let error = format!(
            "{} is protected: start it by hand and type the context name",
            crate::state::mutation::context_name(&cluster)
        );
        return Ok(wanted
            .into_iter()
            .map(|f| AutoStartError {
                saved_id: f.id,
                error: error.clone(),
            })
            .collect());
    }
    cluster.context_client().await?;
    let mut failed = Vec::new();
    for f in wanted {
        // Held until the forward runs (or failed), so a second window
        // connecting at the same moment skips it instead of racing for
        // its port (#292).
        let Some(_claim) = state.claim_autostart(&f.id) else {
            continue;
        };
        if cluster.is_closed() {
            break;
        }
        if let Err(error) = run_saved(&cluster, &f).await {
            failed.push(AutoStartError {
                saved_id: f.id.clone(),
                error,
            });
        }
    }
    Ok(failed)
}

/// The saved forwards that run in another window (#292): saved forwards
/// are per context, so a window shows them as running elsewhere instead
/// of stopped.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_elsewhere(
    cluster: Cluster,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    Ok(state.forwards_elsewhere(cluster.label()))
}

/// The ports of a Service, for its per-port Forward buttons.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_service_ports(
    cluster: Cluster,
    namespace: String,
    name: String,
) -> Result<Vec<ServicePortInfo>, String> {
    let client = cluster.client().await?;
    service_ports(&client, &namespace, &name)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ClusterSession;

    fn forward(started_at: u64) -> ForwardSession {
        let target = ForwardTarget::parse("svc/web", "demo").unwrap();
        let remote = RemotePort::parse("80").unwrap();
        let forward =
            tauri::async_runtime::block_on(async { PortForward::idle(target, remote, 8080) });
        ForwardSession {
            forward,
            started_at,
            saved_id: format!("saved-{started_at}"),
            https: false,
        }
    }

    #[test]
    fn every_cluster_of_the_window_is_listed_with_its_forwards() {
        let a = Arc::new(ClusterSession::new("a".into(), None, Arc::default()));
        let b = Arc::new(ClusterSession::new("b".into(), None, Arc::default()));
        assert!(b.add_forward("pf-2".into(), forward(20)));
        assert!(a.add_forward("pf-3".into(), forward(30)));
        assert!(b.add_forward("pf-1".into(), forward(10)));
        let got: Vec<(String, String)> = list_all(&[b, a])
            .into_iter()
            .map(|f| (f.cluster, f.forward.id))
            .collect();
        assert_eq!(
            got,
            [
                ("a".to_string(), "pf-3".to_string()),
                ("b".into(), "pf-1".into()),
                ("b".into(), "pf-2".into())
            ]
        );
        assert!(list_all(&[]).is_empty());
    }
}
