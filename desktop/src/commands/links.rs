//! `nauvi://` links (#299): "Copy link", taking an opened link (see
//! `links.rs`) and a link clicked in an Ask AI terminal (#548).

use crate::links::{check, take, LinkRequest};
use crate::state::Cluster;
use nauvi::resources::ResourceRef;
use tauri::{AppHandle, Webview};

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
    nauvi::links::object_link(&context, &resource, &namespace, &name)
}

/// A `nauvi://` link clicked in this window's Ask AI terminal (#548),
/// checked as an opened link is: the object to open in this window, or a
/// notice saying why not. Only Ask AI terminals pass their links here;
/// other terminals ignore `nauvi://` links.
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_check_link(app: AppHandle, link: String) -> LinkRequest {
    check(&app, &link)
}

/// The link request waiting for this window, if any (`LinkPending` says
/// when there is one; a window also asks once when it starts).
#[tauri::command]
#[specta::specta]
pub(crate) fn cmd_take_link(webview: Webview) -> Option<LinkRequest> {
    take(webview.label())
}
