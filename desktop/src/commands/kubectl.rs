//! A kubectl matching the cluster's version for the local terminal (#331),
//! opt in from Settings ("Offer a kubectl that matches the cluster").
//!
//! `cmd_kubectl_match` only looks (the API server's version, the kubectl
//! on the app's `PATH`, what was downloaded before); `cmd_kubectl_download`
//! is the only command that downloads, and the UI calls it only from the
//! user's click on the offer. The binary goes to the app's data dir
//! (`<data>/kubectl/<version>/kubectl`) and is only ever put first on
//! `PATH` in a local terminal's own environment (see
//! `cmd_local_shell_start`). See `nauvi::kubectl_download` for the checks.

use crate::kubectl_fetch::{download_base, HttpsFetch};
use crate::settings::SettingsStore;
use crate::state::{AppState, Cluster};
use nauvi::kubectl_download::{
    download, installed, kubectl_version, skew_too_large, KubeVersion, Platform,
};
use serde::Serialize;
use specta::Type;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// What the local terminal can offer for the cluster's kubectl.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
pub(crate) struct KubectlMatch {
    /// The setting is on: without it the terminal offers nothing.
    pub(crate) enabled: bool,
    /// The API server's release, `v1.31.2` (`""`: unknown).
    pub(crate) server: String,
    /// The release of the kubectl on the app's `PATH` (`""`: none found).
    pub(crate) installed: String,
    /// That kubectl is more than one minor version from the server (or
    /// missing): offer the matching one.
    pub(crate) skew: bool,
    /// The matching kubectl was downloaded before, and new local terminals
    /// use it.
    pub(crate) downloaded: bool,
    /// Where the matching kubectl comes from (`""`: none to offer).
    pub(crate) url: String,
    /// Why there is nothing to offer (`""`: no problem).
    pub(crate) note: String,
}

/// The app's data dir, where downloads go.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("cannot find the app's data folder: {e}"))
}

/// The API server's release, waiting at most `secs`.
async fn server_version(cluster: &Cluster, secs: u64) -> Result<KubeVersion, String> {
    let ask = async {
        let client = cluster.client().await?;
        client.apiserver_version().await.map_err(|e| {
            format!(
                "cannot read the API server's version: {}",
                nauvi::error_text(&e)
            )
        })
    };
    let info = tokio::time::timeout(std::time::Duration::from_secs(secs), ask)
        .await
        .map_err(|_| "the API server did not say its version in time".to_string())??;
    KubeVersion::parse(&info.git_version)
}

/// What to offer, given the server and installed versions.
fn offer(
    server: Result<KubeVersion, String>,
    installed_version: Option<KubeVersion>,
    platform: Result<Platform, String>,
    downloaded: bool,
    url_of: impl Fn(&KubeVersion, &Platform) -> String,
) -> KubectlMatch {
    let mut m = KubectlMatch {
        enabled: true,
        installed: installed_version.map(|v| v.tag()).unwrap_or_default(),
        ..Default::default()
    };
    let server = match server {
        Ok(v) => v,
        Err(e) => {
            m.note = e;
            return m;
        }
    };
    m.server = server.tag();
    m.skew = skew_too_large(installed_version.as_ref(), &server);
    m.downloaded = downloaded;
    match platform {
        Ok(p) => m.url = url_of(&server, &p),
        Err(e) => m.note = e,
    }
    m
}

async fn current_match(cluster: &Cluster, app: &AppHandle) -> Result<KubectlMatch, String> {
    let data = data_dir(app)?;
    let server = server_version(cluster, 10).await;
    let installed_version = kubectl_version(OsStr::new("kubectl")).await;
    let platform = Platform::current();
    let downloaded = match (&server, &platform) {
        (Ok(v), Ok(p)) => installed(&data, v, p).is_some(),
        _ => false,
    };
    let (base, _) = download_base()?;
    Ok(offer(
        server,
        installed_version,
        platform,
        downloaded,
        |v, p| base.binary_url(v, p),
    ))
}

/// What the local terminal can offer for this cluster's kubectl. Nothing
/// is downloaded. With the setting off: `enabled: false` and nothing else
/// (no call to the cluster or kubectl).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_kubectl_match(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
) -> Result<KubectlMatch, String> {
    if !settings.get().kubectl_match {
        return Ok(KubectlMatch::default());
    }
    current_match(&cluster, &cluster.app().clone()).await
}

/// Download the kubectl of the cluster's version from dl.k8s.io, check its
/// SHA-256 against the published one and save it in the app's data dir.
/// Only from the user's click; refused with the setting off. Goes through
/// the cluster's proxy setting if one is set.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cmd_kubectl_download(
    cluster: Cluster,
    settings: State<'_, Arc<SettingsStore>>,
    state: State<'_, AppState>,
) -> Result<KubectlMatch, String> {
    if !settings.get().kubectl_match {
        return Err(
            "Turn on \"Offer a kubectl that matches the cluster\" in Settings first.".into(),
        );
    }
    let app = cluster.app().clone();
    let data = data_dir(&app)?;
    let version = server_version(&cluster, 10).await?;
    let platform = Platform::current()?;
    let (base, ca) = download_base()?;
    let proxy = state.sources.proxy(cluster.id());
    let fetch = HttpsFetch::new(&base, proxy.as_ref(), ca.as_deref())?;
    let path = download(&fetch, &base, &version, &platform, &data).await?;
    tracing::info!(
        "downloaded kubectl {version} from {} to {}",
        base.binary_url(&version, &platform),
        path.display()
    );
    current_match(&cluster, &app).await
}

/// The folder of the downloaded kubectl to put first on a local terminal's
/// `PATH`, if the setting is on, the kubectl on `PATH` is too far from the
/// cluster, and the matching one was downloaded. Never downloads.
pub(crate) async fn terminal_kubectl(
    cluster: &Cluster,
    enabled: bool,
) -> Option<(KubeVersion, PathBuf)> {
    if !enabled {
        return None;
    }
    let data = data_dir(cluster.app()).ok()?;
    let server = server_version(cluster, 5).await.ok()?;
    let platform = Platform::current().ok()?;
    let binary = installed(&data, &server, &platform)?;
    let own = kubectl_version(OsStr::new("kubectl")).await;
    if !skew_too_large(own.as_ref(), &server) {
        return None;
    }
    Some((server, binary.parent()?.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> KubeVersion {
        KubeVersion::parse(s).unwrap()
    }

    fn url(v: &KubeVersion, p: &Platform) -> String {
        nauvi::kubectl_download::DownloadBase::official().binary_url(v, p)
    }

    #[test]
    fn offers_the_servers_version_when_the_skew_is_too_large() {
        let linux = Platform::of("linux", "x86_64");
        let m = offer(Ok(v("v1.31.2+k3s1")), Some(v("v1.28.0")), linux.clone(), false, url);
        assert!(m.enabled && m.skew && !m.downloaded);
        assert_eq!(m.server, "v1.31.2");
        assert_eq!(m.installed, "v1.28.0");
        assert_eq!(
            m.url,
            "https://dl.k8s.io/release/v1.31.2/bin/linux/amd64/kubectl"
        );
        assert_eq!(m.note, "");

        let m = offer(Ok(v("v1.31.2")), Some(v("v1.30.0")), linux.clone(), false, url);
        assert!(!m.skew);
        let m = offer(Ok(v("v1.31.2")), None, linux, true, url);
        assert!(m.skew && m.downloaded && m.installed.is_empty());
    }

    #[test]
    fn says_why_there_is_nothing_to_offer() {
        let m = offer(
            Err("cannot read the API server's version: forbidden".into()),
            None,
            Platform::of("linux", "x86_64"),
            false,
            url,
        );
        assert!(m.server.is_empty() && m.url.is_empty() && !m.skew);
        assert!(m.note.contains("forbidden"));
        let m = offer(
            Ok(v("v1.31.2")),
            None,
            Platform::of("linux", "riscv64"),
            false,
            url,
        );
        assert!(m.url.is_empty() && m.note.contains("riscv64"));
    }
}
