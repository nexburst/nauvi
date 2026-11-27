//! Available tags (#539): the newer tags of a container's image in its
//! registry, for the pod and workload panels. Opt in from Settings ("Show
//! available tags"): with it off, nothing here contacts a registry. Only
//! the user's click calls `cmd_registry_tags`; the answer is cached for ten
//! minutes (`TagCache`). See `nauvi::registry_tags` for the host checks.

use crate::settings::SettingsStore;
use crate::state::Cluster;
use nauvi::registry_tags::{workload_images, ContainerImage, TagCache, TagReport};
use nauvi::resources::{self, ResourceRef};
use std::sync::{Arc, OnceLock};
use tauri::State;

/// One cache for every window and cluster: the registries are the same.
fn cache() -> &'static TagCache {
    static CACHE: OnceLock<TagCache> = OnceLock::new();
    CACHE.get_or_init(TagCache::default)
}

/// The setting's name in messages.
const SETTING: &str = "Turn on \"Show available tags\" in Settings first.";

/// The newer tags of `image` and whether its tag was pushed again since
/// `image_id` (a container's `imageID`, `""` if unknown). `refresh` skips
/// the cache. Refused with the setting off.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_registry_tags(
    settings: State<'_, Arc<SettingsStore>>,
    image: String,
    image_id: String,
    refresh: bool,
) -> Result<TagReport, String> {
    if !settings.get().registry_tags {
        return Err(SETTING.into());
    }
    let report = cache().report(&image, &image_id, refresh).await;
    match &report {
        Ok(r) => tracing::info!(
            "available tags of {}: {} tags, {:?}",
            r.image,
            r.tag_count,
            r.state
        ),
        Err(e) => tracing::info!("available tags of {image}: {e}"),
    }
    report
}

/// The containers and images of a workload's pod template, for its panel.
/// Empty with the setting off (no request to the cluster).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_workload_images(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<Vec<ContainerImage>, String> {
    if !settings.get().registry_tags {
        return Ok(Vec::new());
    }
    let client = cluster.client().await?;
    let obj = resources::get_resource(&client, &resource, &namespace, &name)
        .await
        .map_err(|e| nauvi::error_text(&e))?;
    let value = serde_json::to_value(&obj).map_err(|e| e.to_string())?;
    Ok(workload_images(&value))
}
