//! Connecting a window to more clusters than the one it shows (ADR 0007).
//! Each connected cluster has its own session in the window; the one it
//! shows changes with `cmd_set_context`.

use crate::state::{spawn_closes, AppState, Cluster};
use tauri::{Manager, State, Webview};

/// Connect the calling window to `cluster` (a context id from
/// `cmd_list_contexts`) without showing it: open its session, unless the
/// window has it already, and build its client. Its commands then reach
/// it as `api(cluster)`. An unreachable cluster still connects: the client
/// only talks to the API server on the first request.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_cluster_connect(
    cluster: String,
    webview: Webview,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let context = known_context(&state, &cluster)?;
    let session = state.connect(webview.label(), Some(context));
    session.client().await.map(drop)
}

/// Disconnect the calling window from `cluster`: stop everything it
/// started there (streams, terminals, forwards, watches, drains) and drop
/// the client. Not the cluster the window shows. Disconnecting one it is
/// not connected to does nothing.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_cluster_disconnect(
    cluster: String,
    webview: Webview,
    state: State<'_, AppState>,
) -> Result<(), String> {
    spawn_closes(state.disconnect(webview.label(), &cluster)?);
    crate::state::idle::disconnected(webview.app_handle(), webview.label(), &cluster);
    Ok(())
}

/// Whether `cluster`'s API server answers (`GET /readyz`; any HTTP answer
/// counts, as for the watches' liveness probe). The views that watch
/// nothing (Port Forwards, Helm, the catalog) ask this every few seconds,
/// so the header and the banner say when the cluster goes away (#469).
/// The error reads like a reconnecting watch's ("…; retrying.").
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_cluster_health(cluster: Cluster) -> Result<(), String> {
    let (_, prober) = cluster.watch_client().await?;
    prober.health().await
}

/// Start `cluster` over in the calling window, as asked (e.g. after its
/// proxy changed): a fresh session with a new client, shown or not as
/// before. Everything the old one ran (log streams, terminals, forwards,
/// watches) stops; running drains finish. Not connected: nothing happens.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_cluster_reconnect(
    cluster: Cluster,
    state: State<'_, AppState>,
) -> Result<(), String> {
    spawn_closes(state.reconnect(cluster.label(), cluster.id()));
    Ok(())
}

/// `cluster` as a context id, if the kubeconfigs have it.
fn known_context(state: &AppState, cluster: &str) -> Result<String, String> {
    if cluster.is_empty() {
        return Err("Name the cluster to connect to".into());
    }
    if state.sources.catalog().find(cluster).is_none() {
        return Err(format!("There is no context {cluster} in your kubeconfigs"));
    }
    Ok(cluster.to_string())
}

#[cfg(test)]
mod tests {
    use super::known_context;
    use crate::state::AppState;

    #[test]
    fn only_contexts_of_the_kubeconfigs_connect() {
        let state = AppState::default();
        assert!(known_context(&state, "").is_err());
        let err = known_context(&state, "nauvi-333-no-such-context").unwrap_err();
        assert_eq!(
            err,
            "There is no context nauvi-333-no-such-context in your kubeconfigs"
        );
    }
}
