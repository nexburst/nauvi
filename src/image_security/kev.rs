//! CISA's catalogue of Known Exploited Vulnerabilities (KEV, #537): which
//! vulnerabilities are known to be exploited in the wild.
//!
//! Downloaded only when the user turns it on (ADR 0011, amendment #537):
//! one static file from one host ([`KEV_URL`]), over https, at most
//! [`MAX_BYTES`]; nothing about the clusters or images is sent. The app
//! keeps a compact copy (ids, dates) readable only by the user and reads
//! it again after [`MAX_AGE_SECS`].

use super::cache::{create_private_dir, write_private};
use crate::kubectl_download::Fetch;
use crate::text::single_line;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The only host the catalogue comes from.
pub const KEV_HOST: &str = "www.cisa.gov";
/// The catalogue.
pub const KEV_URL: &str =
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
/// A larger answer is refused (the catalogue is about 2 MB).
pub const MAX_BYTES: u64 = 16 * 1024 * 1024;
/// Most entries kept.
pub const MAX_ENTRIES: usize = 50_000;
/// A kept catalogue older than this is downloaded again (a day).
pub const MAX_AGE_SECS: i64 = 24 * 3600;
/// The kept copy's file name.
pub const FILE: &str = "known-exploited.json";

/// One vulnerability of the catalogue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KevEntry {
    /// `CVE-2026-1234`.
    pub cve: String,
    /// When CISA added it (`2026-11-25`).
    pub date_added: String,
    /// CISA says it is used in ransomware campaigns.
    pub ransomware: bool,
}

/// The catalogue as kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KevCatalog {
    /// `2026.11.25`.
    pub version: String,
    /// When CISA released it (as given).
    pub released: String,
    /// When nauvi downloaded it (unix seconds).
    pub fetched_at: i64,
    pub entries: Vec<KevEntry>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawCatalog {
    catalog_version: String,
    date_released: String,
    vulnerabilities: Vec<RawEntry>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawEntry {
    #[serde(rename = "cveID")]
    cve_id: String,
    date_added: String,
    known_ransomware_campaign_use: String,
}

/// `CVE-YYYY-NNNN...`.
pub fn is_cve(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("CVE-") else {
        return false;
    };
    let Some((year, num)) = rest.split_once('-') else {
        return false;
    };
    year.len() == 4
        && year.bytes().all(|b| b.is_ascii_digit())
        && (4..=12).contains(&num.len())
        && num.bytes().all(|b| b.is_ascii_digit())
}

/// The catalogue's JSON. Entries without a valid CVE id are left out; a
/// file without any is refused (it is not the catalogue).
pub fn parse_catalog(json: &[u8], fetched_at: i64) -> Result<KevCatalog, String> {
    let raw: RawCatalog = serde_json::from_slice(json)
        .map_err(|e| format!("The KEV catalogue is not valid JSON: {e}"))?;
    let mut seen = HashSet::new();
    let entries: Vec<KevEntry> = raw
        .vulnerabilities
        .into_iter()
        .filter(|e| is_cve(e.cve_id.trim()))
        .filter(|e| seen.insert(e.cve_id.trim().to_string()))
        .take(MAX_ENTRIES)
        .map(|e| KevEntry {
            cve: e.cve_id.trim().to_string(),
            date_added: single_line(&e.date_added).chars().take(32).collect(),
            ransomware: e.known_ransomware_campaign_use.eq_ignore_ascii_case("known"),
        })
        .collect();
    if entries.is_empty() {
        return Err("The KEV catalogue lists no vulnerabilities; it was not kept.".into());
    }
    Ok(KevCatalog {
        version: single_line(&raw.catalog_version).chars().take(32).collect(),
        released: single_line(&raw.date_released).chars().take(40).collect(),
        fetched_at,
        entries,
    })
}

impl KevCatalog {
    /// The ids, for lookups.
    pub fn ids(&self) -> HashSet<String> {
        self.entries.iter().map(|e| e.cve.clone()).collect()
    }

    /// Whether it should be downloaded again at `now`.
    pub fn stale(&self, now: i64) -> bool {
        now - self.fetched_at >= MAX_AGE_SECS || now < self.fetched_at
    }
}

/// The kept copy in `dir`.
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// The kept copy, `None` when there is none (or it cannot be read).
pub fn load(dir: &Path) -> Option<KevCatalog> {
    let path = path_in(dir);
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() > MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let mut c: KevCatalog = serde_json::from_slice(&bytes).ok()?;
    c.entries.retain(|e| is_cve(&e.cve));
    c.entries.truncate(MAX_ENTRIES);
    Some(c)
}

/// Keep `catalog` in `dir`, readable only by the user.
pub fn save(dir: &Path, catalog: &KevCatalog) -> std::io::Result<()> {
    create_private_dir(dir)?;
    let bytes = serde_json::to_vec(catalog).map_err(std::io::Error::other)?;
    write_private(&path_in(dir), &bytes)
}

/// Forget the kept copy (the setting was turned off).
pub fn remove(dir: &Path) {
    let _ = std::fs::remove_file(path_in(dir));
}

/// Download the catalogue from `url` with `fetch` (which allows only
/// https to [`KEV_HOST`], or a test host), parse it and keep it in `dir`.
pub async fn download(
    fetch: &impl Fetch,
    url: &str,
    dir: &Path,
    now: i64,
) -> Result<KevCatalog, String> {
    let body = fetch.get(url, MAX_BYTES).await?;
    let catalog = parse_catalog(&body, now)?;
    save(dir, &catalog).map_err(|e| format!("Cannot keep the KEV catalogue: {e}"))?;
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "title": "CISA Catalog of Known Exploited Vulnerabilities",
        "catalogVersion": "2026.11.25",
        "dateReleased": "2026-11-25T19:48:12.4344Z",
        "count": 3,
        "vulnerabilities": [
            {"cveID": "CVE-2026-1001", "dateAdded": "2026-11-20", "knownRansomwareCampaignUse": "Known"},
            {"cveID": "CVE-2026-1001", "dateAdded": "2026-11-21"},
            {"cveID": "not-a-cve", "dateAdded": "2026-11-21"},
            {"cveID": "CVE-2025-12345", "dateAdded": "2025-01-02", "knownRansomwareCampaignUse": "Unknown"}
        ]
    }"#;

    struct FakeFetch(Result<Vec<u8>, String>);

    impl Fetch for FakeFetch {
        async fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
            assert_eq!(url, KEV_URL);
            assert_eq!(max, MAX_BYTES);
            self.0.clone()
        }
    }

    #[test]
    fn the_catalogue_is_parsed_and_checked() {
        let c = parse_catalog(SAMPLE.as_bytes(), 100).unwrap();
        assert_eq!(c.version, "2026.11.25");
        assert_eq!(c.entries.len(), 2);
        assert!(c.entries[0].ransomware);
        assert!(!c.entries[1].ransomware);
        assert!(c.ids().contains("CVE-2025-12345"));
        assert!(!c.stale(100 + MAX_AGE_SECS - 1));
        assert!(c.stale(100 + MAX_AGE_SECS));
        assert!(c.stale(50), "a clock set back");
        assert!(parse_catalog(b"<html>blocked</html>", 0).is_err());
        assert!(parse_catalog(br#"{"vulnerabilities":[]}"#, 0)
            .unwrap_err()
            .contains("no vulnerabilities"));
        assert!(is_cve("CVE-2026-103406"));
        assert!(!is_cve("CVE-26-1"));
        assert!(!is_cve("GHSA-1234-5678-9abc"));
    }

    #[tokio::test]
    async fn a_download_is_kept_and_read_back() {
        let dir = std::env::temp_dir().join(format!("nauvi-537-kev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load(&dir).is_none());
        let fetch = FakeFetch(Ok(SAMPLE.as_bytes().to_vec()));
        let c = download(&fetch, KEV_URL, &dir, 7).await.unwrap();
        assert_eq!(load(&dir).unwrap(), c);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path_in(&dir)).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "only the user can read it");
        }
        // A failed download keeps the old copy.
        let broken = FakeFetch(Err("Could not download".into()));
        assert!(download(&broken, KEV_URL, &dir, 8).await.is_err());
        assert_eq!(load(&dir).unwrap().fetched_at, 7);
        remove(&dir);
        assert!(load(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
