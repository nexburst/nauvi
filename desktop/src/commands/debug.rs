//! Debug containers and node shells, opened as terminal sessions (the
//! `exec-*` events and commands drive them once started).

use crate::commands::exec::{emit_note, start_session};
use crate::state::{AppState, Cluster, ClusterSession, SessionCleanup};
use kubeloupe::debug::{add_debug_container, attach_container, describe_debug_error};
use kubeloupe::node_shell::{
    create_node_shell, delete_node_shell, describe_node_shell_error, exec_node_shell,
    leftover_node_shells, new_node_shell_name, NodeShellPod, NODE_SHELL_IMAGE,
};
use tauri::Manager;

/// The session id the UI chose (`ui-…`, so it cannot collide with the
/// backend's own), unless it is already taken.
fn claim_session(state: &ClusterSession, session: String) -> Result<String, String> {
    if !session.starts_with("ui-") || state.exec_sessions.lock().unwrap().contains_key(&session) {
        return Err(format!("invalid terminal session id {session}"));
    }
    Ok(session)
}

/// Add an ephemeral debug container to a pod, targeting `target` (empty: the
/// first container), and attach to it, as terminal session `session` (an id
/// the UI picks, `ui-…`, so it can show the progress written into the
/// session while this runs). Returns the session id.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_debug_start(
    cluster: Cluster,
    session: String,
    namespace: String,
    name: String,
    target: String,
    image: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let session = claim_session(&cluster, session)?;
    let client = cluster.client().await?;
    let out = cluster.emitter();
    emit_note(
        &out,
        &session,
        &format!("Adding a debug container ({image})…"),
    );
    let container = add_debug_container(
        &client,
        &namespace,
        &name,
        &target,
        &image,
        true,
        |reason| emit_note(&out, &session, &format!("Debug container: {reason}")),
    )
    .await
    .map_err(|e| describe_debug_error(&e))?;
    let attached = attach_container(&client, &namespace, &name, &container, true)
        .await
        .map_err(|e| describe_debug_error(&e))?;
    emit_note(
        &out,
        &session,
        &format!("Attached to {container}. If you don't see a prompt, press Enter."),
    );
    start_session(&cluster, session.clone(), attached, cols, rows, None).await;
    Ok(session)
}

/// Open a root shell on `node` through a privileged pod in `namespace`, as
/// terminal session `session` (see [`cmd_debug_start`]). The pod is deleted
/// when the session closes or ends, on a context switch, when its window
/// closes and when the app quits.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_node_shell_start(
    cluster: Cluster,
    session: String,
    node: String,
    namespace: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let session = claim_session(&cluster, session)?;
    let client = cluster.client().await?;
    let out = cluster.emitter();
    let pod = new_node_shell_name(&node);
    emit_note(
        &out,
        &session,
        &format!("Starting pod {namespace}/{pod} on {node}…"),
    );
    let started = create_node_shell(&client, &node, &namespace, &pod, NODE_SHELL_IMAGE, |r| {
        emit_note(&out, &session, &format!("Node shell pod: {r}"))
    })
    .await;
    if let Err(e) = started {
        return Err(describe_node_shell_error(&e, &namespace));
    }
    let attached = match exec_node_shell(&client, &namespace, &pod, true).await {
        Ok(a) => a,
        Err(e) => {
            let _ = delete_node_shell(&client, &namespace, &pod).await;
            return Err(describe_node_shell_error(&e, &namespace));
        }
    };
    emit_note(
        &out,
        &session,
        &format!("Shell on {node}. The pod is deleted when this tab closes."),
    );
    let cleanup = SessionCleanup {
        client,
        namespace,
        pod,
    };
    start_session(
        &cluster,
        session.clone(),
        attached,
        cols,
        rows,
        Some(cleanup),
    )
    .await;
    Ok(session)
}

/// Node shell pods in the cluster that no window of this app owns: left
/// behind by a crash or by another copy of the app. Empty when the
/// user may not list pods across namespaces.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_node_shell_leftovers(
    cluster: Cluster,
) -> Result<Vec<NodeShellPod>, String> {
    let client = cluster.client().await?;
    match leftovers(cluster.app(), &client).await {
        Ok(p) => Ok(p),
        Err(e) if kubeloupe::is_forbidden(&e) => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

async fn leftovers(
    app: &tauri::AppHandle,
    client: &kube::Client,
) -> anyhow::Result<Vec<NodeShellPod>> {
    let mut pods = leftover_node_shells(client).await?;
    // Another window may have a shell open on the same cluster.
    let ours = app.state::<AppState>().node_shell_pods();
    pods.retain(|p| !ours.contains(&(p.namespace.clone(), p.name.clone())));
    Ok(pods)
}

/// Delete the node shell pods [`cmd_node_shell_leftovers`] lists. Returns
/// how many were deleted; fails with the first error after trying them all.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_node_shell_cleanup(cluster: Cluster) -> Result<u32, String> {
    let client = cluster.client().await?;
    let pods = leftovers(cluster.app(), &client)
        .await
        .map_err(|e| kubeloupe::actions::describe_error(&e))?;
    let mut deleted = 0;
    let mut first_error = None;
    for p in pods {
        match delete_node_shell(&client, &p.namespace, &p.name).await {
            Ok(()) => deleted += 1,
            Err(e) => {
                first_error.get_or_insert_with(|| kubeloupe::actions::describe_error(&e));
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(deleted),
    }
}
