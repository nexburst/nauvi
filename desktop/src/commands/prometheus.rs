//! Which Prometheus the usage charts query (#47): detected in the cluster,
//! or set per context in Settings. Cached per context; detection runs again
//! after a while, and at once when the setting changes.

use crate::settings::SettingsStore;
use crate::state::{Cluster, ClusterSession};
use kube::Client;
use kubeloupe::{resolve_prometheus, PrometheusDetection, PrometheusStatus};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

/// How long a detection is trusted: a Prometheus may be installed or
/// removed meanwhile.
const FOUND_TTL: Duration = Duration::from_secs(10 * 60);
const NOT_FOUND_TTL: Duration = Duration::from_secs(2 * 60);

pub(crate) struct PromCache {
    /// The selected context it was made for (`None`: the current-context).
    ctx: Option<String>,
    /// The Settings value it was made from.
    setting: String,
    at: Instant,
    detection: PrometheusDetection,
}

impl PromCache {
    fn fresh(&self, ctx: &Option<String>, setting: &str) -> bool {
        let ttl = if self.detection.target.is_some() {
            FOUND_TTL
        } else {
            NOT_FOUND_TTL
        };
        self.ctx == *ctx && self.setting == setting && self.at.elapsed() < ttl
    }
}

/// The name Settings keys the context by: the selected one, else the
/// kubeconfig's current-context (as the UI does).
fn context_name(ctx: &Option<String>) -> String {
    match ctx {
        Some(name) => name.clone(),
        None => kube::config::Kubeconfig::read()
            .ok()
            .and_then(|k| k.current_context)
            .unwrap_or_default(),
    }
}

/// The Prometheus for the selected context, from the cache when it is still
/// fresh. `redetect` ignores the cache.
pub(crate) async fn prometheus_for(
    state: &ClusterSession,
    settings: &SettingsStore,
    client: &Client,
    redetect: bool,
) -> PrometheusDetection {
    let ctx = state.selected_context();
    let name = context_name(&ctx);
    let setting = settings
        .get()
        .contexts
        .get(&name)
        .map(|c| c.prometheus.clone())
        .unwrap_or_default();
    if !redetect {
        if let Some(c) = state.prometheus.lock().unwrap().as_ref() {
            if c.fresh(&ctx, &setting) {
                return c.detection.clone();
            }
        }
    }
    let detection = resolve_prometheus(client, &setting).await;
    // Not cached if the context changed while detecting.
    if state.selected_context() == ctx {
        *state.prometheus.lock().unwrap() = Some(PromCache {
            ctx,
            setting,
            at: Instant::now(),
            detection: detection.clone(),
        });
    }
    detection
}

/// Which Prometheus the usage charts use for the selected context, or why
/// there is none. `redetect` looks again instead of using the cached answer.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_prometheus_status(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    redetect: bool,
) -> Result<PrometheusStatus, String> {
    let client = cluster.client().await?;
    Ok(prometheus_for(&cluster, &settings, &client, redetect)
        .await
        .status())
}
