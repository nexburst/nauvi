//! Misconfigurations (#538): the workloads of the namespaces shown with the
//! checks the Trivy Operator's ConfigAuditReports say they fail.
//!
//! Under the same setting as image security (off by default, per app and
//! per cluster). Read only when the view asks; the listing is kept in the
//! [`ClusterSession`] for `cache_ttl_hours` (dropped with it, and on an
//! idle disconnect).

use super::image_security::{enabled, now_secs, sorted, OFF};
use crate::settings::SettingsStore;
use crate::state::{Cluster, ClusterSession};
use nauvi::image_security::config_audit::{
    config_detail, workload_configs_in_namespaces, ConfigDetail, ConfigSummary,
};
use nauvi::resources;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

/// The last listing of a cluster.
pub(crate) struct ConfigCache {
    namespaces: Vec<String>,
    at: Instant,
    read_at: i64,
    summary: ConfigSummary,
}

/// What the view shows: the listing and when its reports were read.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub(crate) struct ImageConfigList {
    pub(crate) summary: ConfigSummary,
    /// When nauvi read the reports (unix seconds).
    pub(crate) read_at: i64,
}

async fn listing(
    cluster: &ClusterSession,
    settings: &SettingsStore,
    namespaces: Vec<String>,
    refresh: bool,
) -> Result<ImageConfigList, String> {
    if !enabled(cluster, settings) {
        return Err(OFF.to_string());
    }
    let namespaces = sorted(namespaces);
    let ttl = Duration::from_secs(u64::from(settings.get().image_security.cache_ttl_hours) * 3600);
    if !refresh {
        if let Some(c) = cluster.image_config.lock().unwrap().as_ref() {
            if c.namespaces == namespaces && c.at.elapsed() < ttl {
                return Ok(ImageConfigList {
                    summary: c.summary.clone(),
                    read_at: c.read_at,
                });
            }
        }
    }
    let client = cluster.client().await?;
    let mut kinds = cluster.kinds.lock().unwrap().clone();
    if kinds.is_empty() {
        kinds = resources::discover(&client)
            .await
            .map_err(|e| nauvi::error_text(&e))?;
        *cluster.kinds.lock().unwrap() = kinds.clone();
    }
    let summary = workload_configs_in_namespaces(&client, &kinds, &namespaces)
        .await
        .map_err(|e| nauvi::error_text(&e))?;
    let read_at = now_secs();
    if !cluster.is_closed() {
        *cluster.image_config.lock().unwrap() = Some(ConfigCache {
            namespaces,
            at: Instant::now(),
            read_at,
            summary: summary.clone(),
        });
    }
    Ok(ImageConfigList { summary, read_at })
}

/// The workloads of `namespaces` (none: all namespaces) and how many
/// checks each fails. `refresh` reads the reports again.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_config_summary(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespaces: Vec<String>,
    refresh: bool,
) -> Result<ImageConfigList, String> {
    listing(&cluster, &settings, namespaces, refresh).await
}

/// One workload of the listing of `namespaces` with the checks it fails.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_image_config_detail(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    namespaces: Vec<String>,
    kind: String,
    namespace: String,
    name: String,
) -> Result<ConfigDetail, String> {
    let list = listing(&cluster, &settings, namespaces, false).await?;
    let row = list
        .summary
        .workloads
        .into_iter()
        .find(|r| r.target.kind == kind && r.target.namespace == namespace && r.target.name == name)
        .ok_or_else(|| {
            format!("{kind} {namespace}/{name} is no longer in the list; refresh it.")
        })?;
    let client = cluster.client().await?;
    config_detail(&client, row)
        .await
        .map_err(|e| nauvi::error_text(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Off by default: nothing is read, nothing is cached.
    #[tokio::test]
    async fn nothing_is_read_while_it_is_off() {
        let (cluster, dir) = super::super::image_security::tests::session("nauvi-538-off");
        let settings = SettingsStore::open(None);
        let err = listing(&cluster, &settings, vec![], false)
            .await
            .unwrap_err();
        assert_eq!(err, OFF);
        assert!(cluster.image_config.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
