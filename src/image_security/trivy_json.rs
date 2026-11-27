//! Trivy's JSON (#536): `trivy image --format json` and `trivy version
//! --format json`. The report describes an untrusted image, so every
//! string is cleaned and links are kept only when they are plain web links.

use super::local::ScannerVersion;
use super::trivy_operator::safe_link;
use super::{Severity, Vulnerability};
use crate::text::single_line;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};

/// The most vulnerabilities kept from one report.
pub const MAX_VULNS: usize = 50_000;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Report {
    results: Option<Vec<Target>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Target {
    vulnerabilities: Option<Vec<Vuln>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Vuln {
    #[serde(rename = "VulnerabilityID")]
    id: String,
    pkg_name: String,
    installed_version: String,
    fixed_version: String,
    severity: String,
    title: String,
    #[serde(rename = "PrimaryURL")]
    primary_url: String,
    #[serde(rename = "CVSS")]
    cvss: Option<BTreeMap<String, Cvss>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Cvss {
    #[serde(rename = "V3Score")]
    v3: Option<f64>,
    #[serde(rename = "V2Score")]
    v2: Option<f64>,
}

fn score(cvss: &Option<BTreeMap<String, Cvss>>) -> f64 {
    let Some(map) = cvss else { return 0.0 };
    let pick = |f: fn(&Cvss) -> Option<f64>| {
        map.get("nvd")
            .and_then(f)
            .or_else(|| map.values().filter_map(f).reduce(f64::max))
    };
    pick(|c| c.v3)
        .or_else(|| pick(|c| c.v2))
        .filter(|s| s.is_finite() && *s >= 0.0)
        .unwrap_or(0.0)
}

/// The vulnerabilities of a `trivy image --format json` report, each
/// (id, package, installed version) once.
pub fn parse_scan(json: &[u8]) -> serde_json::Result<Vec<Vulnerability>> {
    let report: Report = serde_json::from_slice(json)?;
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut out = Vec::new();
    for v in report
        .results
        .into_iter()
        .flatten()
        .flat_map(|t| t.vulnerabilities.into_iter().flatten())
    {
        let id = single_line(&v.id);
        if id.is_empty() {
            continue;
        }
        let package = single_line(&v.pkg_name);
        let installed_version = single_line(&v.installed_version);
        if !seen.insert((id.clone(), package.clone(), installed_version.clone())) {
            continue;
        }
        out.push(Vulnerability {
            id,
            package,
            installed_version,
            fixed_version: single_line(&v.fixed_version),
            severity: Severity::parse(&v.severity),
            score: score(&v.cvss),
            title: single_line(&v.title).chars().take(300).collect(),
            link: safe_link(&v.primary_url),
            exploit: Default::default(),
        });
        if out.len() >= MAX_VULNS {
            break;
        }
    }
    Ok(out)
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct VersionInfo {
    version: String,
    #[serde(rename = "VulnerabilityDB")]
    vulnerability_db: Option<DbInfo>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct DbInfo {
    updated_at: String,
}

/// `trivy version --format json`: its version and when its database was
/// built.
pub fn parse_version(json: &[u8]) -> serde_json::Result<ScannerVersion> {
    let v: VersionInfo = serde_json::from_slice(json)?;
    Ok(ScannerVersion {
        version: single_line(&v.version).chars().take(64).collect(),
        db: v
            .vulnerability_db
            .map(|d| single_line(&d.updated_at).chars().take(64).collect())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_becomes_vulnerabilities() {
        let json = include_bytes!("testdata/trivy-scan.json");
        let v = parse_scan(json).unwrap();
        assert_eq!(v.len(), 3, "{v:?}");
        let ssl = v.iter().find(|x| x.id == "CVE-2026-1001").unwrap();
        assert_eq!(ssl.package, "openssl");
        assert_eq!(ssl.installed_version, "3.0.11-1");
        assert_eq!(ssl.fixed_version, "3.0.15-1");
        assert_eq!(ssl.severity, Severity::Critical);
        assert_eq!(ssl.score, 9.8);
        assert_eq!(ssl.link, "https://avd.aquasec.com/nvd/cve-2026-1001");
        // A hostile title is one clean line; a javascript: link is dropped.
        let evil = v.iter().find(|x| x.id == "CVE-2026-1003").unwrap();
        assert!(!evil.title.contains('\n') && !evil.title.contains('\u{202e}'));
        assert_eq!(evil.link, "");
        assert_eq!(evil.score, 5.0, "V2 when there is no V3");
    }

    #[test]
    fn empty_and_null_results() {
        assert!(parse_scan(br#"{"SchemaVersion":2,"Results":null}"#)
            .unwrap()
            .is_empty());
        assert!(
            parse_scan(br#"{"Results":[{"Target":"x","Vulnerabilities":null}]}"#)
                .unwrap()
                .is_empty()
        );
        assert!(parse_scan(b"{}").unwrap().is_empty());
        assert!(parse_scan(b"not json").is_err());
    }

    #[test]
    fn version_and_db() {
        let v = parse_version(
            br#"{"Version":"0.58.1","VulnerabilityDB":{"Version":2,"UpdatedAt":"2026-11-25T06:13:33Z"}}"#,
        )
        .unwrap();
        assert_eq!(v.version, "0.58.1");
        assert_eq!(v.db, "2026-11-25T06:13:33Z");
        let none = parse_version(br#"{"Version":"0.58.1"}"#).unwrap();
        assert_eq!(none.db, "");
    }
}
