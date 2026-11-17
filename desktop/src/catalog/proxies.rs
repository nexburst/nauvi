//! The proxies set per cluster in the app (#329), by context id, kept in
//! `proxies.json` next to the settings and readable only by the user. Not
//! in `settings.json`: the settings go to the UI as they are, and a proxy
//! URL can hold a password. The UI only ever gets `ClusterProxyInfo`
//! with the user and password masked.

use super::approvals::write_private;
use nauvi::proxy::{ClusterProxy, ProxyUrl};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// One cluster's proxy as saved.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Saved {
    url: String,
    #[serde(default)]
    local: bool,
}

#[derive(Debug, Default)]
pub(crate) struct ProxyStore {
    path: Option<PathBuf>,
    /// Only URLs that parse (a bad entry in the file is dropped on load).
    proxies: BTreeMap<String, ClusterProxy>,
}

impl ProxyStore {
    /// Read `path` (`None`: nothing is saved). A missing or broken file
    /// gives no proxies; a bad entry is skipped, keeping the others.
    pub(crate) fn load(path: Option<PathBuf>) -> Self {
        let saved: BTreeMap<String, serde_json::Value> = path
            .as_deref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let proxies = saved
            .into_iter()
            .filter_map(|(id, v)| {
                let s: Saved = serde_json::from_value(v).ok()?;
                let url = ProxyUrl::parse(&s.url).ok()?;
                Some((
                    id,
                    ClusterProxy {
                        url,
                        local: s.local,
                    },
                ))
            })
            .collect();
        Self { path, proxies }
    }

    pub(crate) fn get(&self, id: &str) -> Option<ClusterProxy> {
        self.proxies.get(id).cloned()
    }

    /// Set (`Some`) or remove (`None`) the proxy of `id` and save the file.
    pub(crate) fn set(&mut self, id: &str, proxy: Option<ClusterProxy>) -> Result<(), String> {
        let before = self.proxies.clone();
        match proxy {
            Some(p) => self.proxies.insert(id.to_string(), p),
            None => self.proxies.remove(id),
        };
        if let Err(e) = self.save() {
            self.proxies = before;
            return Err(e);
        }
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let saved: BTreeMap<&str, Saved> = self
            .proxies
            .iter()
            .map(|(id, p)| {
                (
                    id.as_str(),
                    Saved {
                        url: p.url.secret_text(),
                        local: p.local,
                    },
                )
            })
            .collect();
        let bytes = serde_json::to_vec_pretty(&saved).unwrap_or_default();
        write_private(path, &bytes)
            .map_err(|e| format!("Could not save the proxy in {}: {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nauvi-329-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn proxy(url: &str, local: bool) -> ClusterProxy {
        ClusterProxy {
            url: ProxyUrl::parse(url).unwrap(),
            local,
        }
    }

    #[test]
    fn saves_privately_and_loads_back() {
        let d = dir("save");
        let path = d.join("proxies.json");
        let mut store = ProxyStore::load(Some(path.clone()));
        assert_eq!(store.get("kind"), None);
        store
            .set("kind", Some(proxy("http://me:pw@proxy:3128", true)))
            .unwrap();
        store
            .set("prod", Some(proxy("socks5://10.0.0.1", false)))
            .unwrap();
        let again = ProxyStore::load(Some(path.clone()));
        assert_eq!(
            again.get("kind"),
            Some(proxy("http://me:pw@proxy:3128", true))
        );
        assert_eq!(
            again.get("prod"),
            Some(proxy("socks5://10.0.0.1:1080", false))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        store.set("kind", None).unwrap();
        assert_eq!(ProxyStore::load(Some(path)).get("kind"), None);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_bad_entry_costs_only_itself() {
        let d = dir("bad");
        let path = d.join("proxies.json");
        std::fs::write(
            &path,
            r#"{"a": {"url": "ftp://x"}, "b": 7, "c": {"url": "http://ok:1"}, "d": {"url": "https://tls:1"}}"#,
        )
        .unwrap();
        let store = ProxyStore::load(Some(path.clone()));
        assert_eq!(store.get("a"), None);
        assert_eq!(store.get("b"), None);
        assert_eq!(store.get("c"), Some(proxy("http://ok:1", false)));
        // Saved before HTTPS proxies were refused: not used.
        assert_eq!(store.get("d"), None);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(ProxyStore::load(Some(path)).get("c"), None);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
