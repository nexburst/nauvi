//! `kubeloupe://` links (#299): "Copy link" and taking an opened link
//! (see `links.rs`).

use crate::links::{take, LinkRequest, ObjectLink};
use crate::state::Cluster;
use kubeloupe::resources::ResourceRef;
use tauri::Webview;

pub(crate) use crate::links::LinkPending;

/// The link to an object of this window's context. Reads the kubeconfig
/// files; no login.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_object_link(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let context = cluster.context_id()?;
    let link = ObjectLink {
        context,
        group: resource.group,
        version: resource.version,
        kind: resource.kind,
        namespace,
        name,
    };
    link.to_url()
        .map_err(|e| format!("This object can't be linked to: {e}."))
}

/// The link request waiting for this window, if any (`LinkPending` says
/// when there is one; a window also asks once when it starts).
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_take_link(webview: Webview) -> Option<LinkRequest> {
    take(webview.label())
}
