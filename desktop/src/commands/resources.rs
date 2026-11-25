//! Resource details, YAML get / apply, delete.

use super::raw_body::RawText;
use crate::state::mutation::Mutation;
use crate::state::Cluster;
use nauvi::actions::{self};
use nauvi::resources::{self, ResourceDetail, ResourceRef};

/// Detail of any object; pods include their `pod` section.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_get_resource_detail(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<ResourceDetail, String> {
    let client = cluster.client().await?;
    resources::get_resource_detail(&client, &resource, &namespace, &name)
        .await
        .map_err(|e| nauvi::error_text(&e))
}

/// The per-kind summary and related objects of any object (a Deployment's
/// ReplicaSets and pods, a Service's endpoints, the pods on a Node...).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_get_related(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<resources::Related, String> {
    let client = cluster.client().await?;
    resources::get_related(&client, &resource, &namespace, &name)
        .await
        .map_err(|e| actions::describe_error(&e))
}

/// An object as YAML. Secret values stay hidden unless `reveal` is set.
/// The YAML comes as raw UTF-8 (#115): decode it with `yamlText` in
/// `lib/rawIpc.ts`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_get_resource_yaml(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
    reveal: bool,
) -> Result<RawText, String> {
    let client = cluster.client().await?;
    resources::get_resource_yaml(&client, &resource, &namespace, &name, reveal)
        .await
        .map(RawText)
        .map_err(|e| nauvi::error_text(&e))
}

/// Server-side apply of edited YAML. `resource_version` is the version the
/// YAML was loaded at (empty: don't check); if the object changed since,
/// nothing is applied and the outcome says so. `dry_run` validates only.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_apply_resource_yaml(
    cluster: Mutation,
    resource: ResourceRef,
    namespace: String,
    name: String,
    yaml: String,
    resource_version: String,
    dry_run: bool,
) -> Result<resources::ApplyOutcome, String> {
    let client = cluster.client().await?;
    let opts = resources::ApplyOptions {
        dry_run,
        resource_version: Some(resource_version).filter(|v| !v.is_empty()),
    };
    resources::apply_resource_yaml_with(&client, &resource, &namespace, &name, &yaml, &opts)
        .await
        // `:#` keeps the cause, e.g. the YAML parser's line and column.
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_delete_resource(
    cluster: Mutation,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<(), String> {
    let client = cluster.client().await?;
    resources::delete_resource(&client, &resource, &namespace, &name)
        .await
        .map_err(|e| actions::describe_error(&e))
}

/// Create or update the objects of a (multi-document) YAML manifest. The
/// batch is validated with a dry run first; unless `dry_run`, it is applied
/// if every document passed, or with `skip_invalid` the ones that did.
/// Objects without a namespace go to `namespace` ("" = "default").
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_apply_manifests(
    cluster: Mutation,
    yaml: String,
    namespace: String,
    dry_run: bool,
    skip_invalid: bool,
) -> Result<Vec<resources::ApplyResult>, String> {
    let client = cluster.client().await?;
    let mut kinds = cluster.kinds.lock().unwrap().clone();
    if kinds.is_empty() {
        kinds = resources::discover(&client)
            .await
            .map_err(|e| actions::describe_error(&e))?;
    }
    let opts = resources::ManifestOptions {
        dry_run,
        skip_invalid,
    };
    Ok(resources::apply_manifests(&client, &kinds, &yaml, &namespace, opts).await)
}

/// The keys of a Secret (values hidden) or ConfigMap (with values), for the
/// detail panel's data editor.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_get_data_entries(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<resources::DataEntries, String> {
    let client = cluster.client().await?;
    resources::get_data_entries(&client, &resource, &namespace, &name)
        .await
        .map_err(|e| actions::describe_error(&e))
}

/// One Secret value, on an explicit reveal of that key. Never logged.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_reveal_data_value(
    cluster: Cluster,
    resource: ResourceRef,
    namespace: String,
    name: String,
    key: String,
) -> Result<resources::RevealedValue, String> {
    let client = cluster.client().await?;
    resources::reveal_data_value(&client, &resource, &namespace, &name, &key)
        .await
        .map_err(|e| actions::describe_error(&e))
}

/// Save edited keys of a Secret or ConfigMap with a JSON merge patch of
/// only those keys. `resource_version` is the version they were loaded at
/// (empty: don't check); if the object changed since, nothing is saved and
/// the outcome says so.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_patch_data(
    cluster: Mutation,
    resource: ResourceRef,
    namespace: String,
    name: String,
    changes: Vec<resources::DataChange>,
    resource_version: String,
) -> Result<resources::ApplyOutcome, String> {
    let client = cluster.client().await?;
    resources::patch_data(
        &client,
        &resource,
        &namespace,
        &name,
        &changes,
        &resource_version,
    )
    .await
}
