//! Grype's JSON (#536): `grype -o json`, `grype version -o json` and
//! `grype db status -o json`. Like Trivy's, every string is cleaned.

use super::local::ScannerVersion;
use super::trivy_json::MAX_VULNS;
use super::trivy_operator::safe_link;
use super::{Exploit, Severity, Vulnerability};
use crate::text::single_line;
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Report {
    matches: Option<Vec<Match>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Match {
    vulnerability: Vuln,
    related_vulnerabilities: Option<Vec<Vuln>>,
    artifact: Artifact,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Vuln {
    id: String,
    data_source: String,
    severity: String,
    description: String,
    urls: Option<Vec<String>>,
    cvss: Option<Vec<Cvss>>,
    fix: Fix,
    /// CISA KEV entries for it (Grype 0.87 and later).
    known_exploited: Option<Vec<serde::de::IgnoredAny>>,
    epss: Option<Vec<Epss>>,
    risk: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Epss {
    epss: Option<f64>,
    percentile: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Cvss {
    metrics: Metrics,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Metrics {
    base_score: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Fix {
    versions: Option<Vec<String>>,
    state: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Artifact {
    name: String,
    version: String,
}

fn severity(s: &str) -> Severity {
    match s.trim().to_ascii_lowercase().as_str() {
        "negligible" => Severity::Low,
        other => Severity::parse(other),
    }
}

fn unit(p: Option<f64>) -> Option<f64> {
    p.filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
}

/// KEV, EPSS and risk of a match (#537): from its vulnerability, else from
/// the related ones (a GHSA's CVE).
fn exploit_of(v: &Vuln, related: &[Vuln]) -> Exploit {
    let all = || std::iter::once(v).chain(related.iter());
    let kev = all().any(|x| x.known_exploited.as_ref().is_some_and(|k| !k.is_empty()));
    let epss = all()
        .flat_map(|x| x.epss.iter().flatten())
        .filter_map(|e| unit(e.epss).map(|p| (p, unit(e.percentile))))
        .max_by(|a, b| a.0.total_cmp(&b.0));
    Exploit {
        kev,
        epss: epss.map_or(0.0, |e| e.0),
        epss_percentile: epss.and_then(|e| e.1).unwrap_or(0.0),
        risk: all()
            .filter_map(|x| x.risk)
            .find(|r| r.is_finite() && *r >= 0.0)
            .unwrap_or(0.0),
    }
}

fn best_score(v: &Vuln) -> Option<f64> {
    v.cvss
        .iter()
        .flatten()
        .filter_map(|c| c.metrics.base_score)
        .filter(|s| s.is_finite() && *s >= 0.0)
        .reduce(f64::max)
}

/// The vulnerabilities of a `grype -o json` report, each (id, package,
/// installed version) once. A fix counts only in the `fixed` state.
pub fn parse_scan(json: &[u8]) -> serde_json::Result<Vec<Vulnerability>> {
    let report: Report = serde_json::from_slice(json)?;
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut out = Vec::new();
    for m in report.matches.into_iter().flatten() {
        let v = &m.vulnerability;
        let id = single_line(&v.id);
        if id.is_empty() {
            continue;
        }
        let package = single_line(&m.artifact.name);
        let installed_version = single_line(&m.artifact.version);
        if !seen.insert((id.clone(), package.clone(), installed_version.clone())) {
            continue;
        }
        let related = m.related_vulnerabilities.as_deref().unwrap_or_default();
        let fixed_version = if v.fix.state.eq_ignore_ascii_case("fixed") {
            single_line(&v.fix.versions.as_deref().unwrap_or_default().join(", "))
        } else {
            String::new()
        };
        let description = Some(v.description.as_str())
            .filter(|d| !d.trim().is_empty())
            .or_else(|| {
                related
                    .iter()
                    .map(|r| r.description.as_str())
                    .find(|d| !d.trim().is_empty())
            })
            .unwrap_or("");
        let link = std::iter::once(v.data_source.as_str())
            .chain(v.urls.iter().flatten().map(String::as_str))
            .map(safe_link)
            .find(|l| !l.is_empty())
            .unwrap_or_default();
        out.push(Vulnerability {
            id,
            package,
            installed_version,
            fixed_version,
            severity: severity(&v.severity),
            score: best_score(v)
                .or_else(|| related.iter().filter_map(best_score).reduce(f64::max))
                .unwrap_or(0.0),
            title: single_line(description).chars().take(300).collect(),
            link,
            exploit: exploit_of(v, related),
        });
        if out.len() >= MAX_VULNS {
            break;
        }
    }
    Ok(out)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct VersionInfo {
    version: String,
}

/// `grype version -o json`.
pub fn parse_version(json: &[u8]) -> serde_json::Result<ScannerVersion> {
    let v: VersionInfo = serde_json::from_slice(json)?;
    Ok(ScannerVersion {
        version: single_line(&v.version).chars().take(64).collect(),
        db: String::new(),
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DbStatus {
    built: String,
}

/// When `grype db status -o json` says its database was built (empty when
/// it cannot be read).
pub fn parse_db_status(json: &[u8]) -> String {
    serde_json::from_slice::<DbStatus>(json)
        .map(|s| single_line(&s.built).chars().take(64).collect())
        .unwrap_or_default()
}

/// The `Built:` line of `grype db status` as text (older Grype has no
/// JSON for it), empty when there is none.
pub fn parse_db_status_text(text: &[u8]) -> String {
    String::from_utf8_lossy(text)
        .lines()
        .find_map(|l| l.trim().strip_prefix("Built:"))
        .map(|v| single_line(v).chars().take(64).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_becomes_vulnerabilities() {
        let v = parse_scan(include_bytes!("testdata/grype-scan.json")).unwrap();
        assert_eq!(v.len(), 3, "{v:?}");
        let ssl = &v[0];
        assert_eq!(ssl.id, "CVE-2026-1001");
        assert_eq!(ssl.package, "openssl");
        assert_eq!(ssl.fixed_version, "3.0.15-1");
        assert_eq!(ssl.severity, Severity::Critical);
        assert_eq!(ssl.score, 9.8);
        assert_eq!(ssl.link, "https://nvd.nist.gov/vuln/detail/CVE-2026-1001");
        // "not-fixed" and "wont-fix" have no fixed version.
        let curl = v.iter().find(|x| x.id == "CVE-2026-1002").unwrap();
        assert_eq!(curl.fixed_version, "");
        assert_eq!(curl.title, "from the related one");
        assert_eq!(curl.score, 7.5);
        let low = v.iter().find(|x| x.id == "CVE-2026-1004").unwrap();
        assert_eq!(low.severity, Severity::Low, "negligible");
        assert_eq!(low.link, "");
        // #537: EPSS and risk where Grype gives them; KEV from a related CVE.
        assert_eq!(ssl.exploit.epss, 0.5);
        assert_eq!(ssl.exploit.epss_percentile, 0.9);
        assert_eq!(ssl.exploit.risk, 42.1);
        assert!(!ssl.exploit.kev);
        assert!(curl.exploit.kev);
        assert_eq!(curl.exploit.epss, 0.0);
        assert_eq!(low.exploit, Exploit::default());
    }

    #[test]
    fn version_and_db_status() {
        assert_eq!(
            parse_version(br#"{"application":"grype","version":"0.84.0"}"#)
                .unwrap()
                .version,
            "0.84.0"
        );
        assert_eq!(
            parse_db_status(br#"{"schemaVersion":"v6.0.2","built":"2026-11-25T04:07:12Z"}"#),
            "2026-11-25T04:07:12Z"
        );
        assert_eq!(parse_db_status(b"garbage"), "");
        assert_eq!(
            parse_db_status_text(
                b"Location:  /home/u/.cache/grype/db/5\nBuilt:     2026-11-24 01:31:44 +0000 UTC\nSchema:    5\nStatus:    valid\n"
            ),
            "2026-11-24 01:31:44 +0000 UTC"
        );
        assert_eq!(parse_db_status_text(b"no db\n"), "");
        assert!(parse_scan(br#"{"matches":null}"#).unwrap().is_empty());
    }
}
