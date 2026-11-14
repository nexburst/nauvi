//! Port-forwards. They live here in the backend, independent of the panel
//! that started them, until stopped, until the context changes or until their window
//! closes.

use crate::state::{next_session, Cluster, ForwardSession};
use kubeloupe::{
    service_ports, ForwardStatus, ForwardTarget, LocalPort, PortForward, RemotePort,
    ServicePortInfo,
};
use serde::Serialize;
use specta::Type;
use std::time::{SystemTime, UNIX_EPOCH};

/// One running forward, with its live status.
#[derive(Debug, Clone, Serialize, Type)]
pub(crate) struct ForwardInfo {
    id: String,
    target: ForwardTarget,
    /// The remote port as asked for: a number or a port name.
    remote: String,
    /// Its number on the target (the Service port or the pod port).
    remote_port: u16,
    local_port: u16,
    /// `http://127.0.0.1:<local_port>`.
    url: String,
    /// Epoch milliseconds.
    started_at: u64,
    status: ForwardStatus,
}

fn info(id: &str, s: &ForwardSession) -> ForwardInfo {
    let f = &s.forward;
    ForwardInfo {
        id: id.to_string(),
        target: f.target.clone(),
        remote: f.remote.to_string(),
        remote_port: f.remote_port,
        local_port: f.local_port,
        url: f.url(),
        started_at: s.started_at,
        status: f.status(),
    }
}

/// Start forwarding `remote_port` (a number or a port name) of a pod,
/// Service or workload. `local_port`: none picks the remote port if it is
/// free and at least 1024, else a random one; 0 is random; any other
/// number is used as is or fails if taken. Asking again for a forward that
/// already runs (same target and port, no explicit local port) returns it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_portforward_start(
    cluster: Cluster,
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
    let client = cluster.client().await?;
    let forward = PortForward::start(&client, target, remote, LocalPort::from_option(local_port))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let id = next_session("pf");
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let session = ForwardSession {
        forward,
        started_at,
    };
    let out = info(&id, &session);
    cluster.add_forward(id, session);
    Ok(out)
}

/// Stop a forward. Stopping one that is already gone is not an error.
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
