//! Ignores and exploit signals applied to the rows and findings (#537).
//!
//! A listing keeps only counts of each report; to apply ignores and KEV to
//! a row it keeps, per report, the few vulnerabilities [`Triage::wants`]
//! (ignored ids and KEV ids) as [`Mark`]s, and nothing else. An ignored
//! vulnerability leaves the counts and is counted in `ignored`; a known
//! exploited one (not ignored) is counted in `kev`.

use super::ignore::IgnoreRule;
use super::report::fix_groups;
use super::{ImageDetail, ImageVulns, IgnoredVuln, Severity, SeverityCounts, Vulnerability};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

/// What a listing keeps of a vulnerability [`Triage::wants`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub id: String,
    pub severity: Severity,
    pub fixable: bool,
    /// The scanner says it is known to be exploited (Grype).
    pub kev: bool,
}

impl Mark {
    pub fn of(v: &Vulnerability) -> Self {
        Mark {
            id: v.id.clone(),
            severity: v.severity,
            fixable: !v.fixed_version.is_empty(),
            kev: v.exploit.kev,
        }
    }
}

/// The ignores and the KEV ids in force for one listing.
#[derive(Debug, Clone, Default)]
pub struct Triage {
    /// nauvi's own ignores and the ignore file's, expired ones included
    /// (they do not apply).
    pub rules: Vec<IgnoreRule>,
    /// The KEV catalogue's ids (empty when it is off).
    pub kev: HashSet<String>,
    /// The cluster (context id) of workload and namespace ignores.
    pub context: String,
    /// Unix seconds, for expiry.
    pub now: i64,
}

impl Triage {
    /// Nothing to apply.
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty() && self.kev.is_empty()
    }

    /// Whether a listing keeps `id` for [`Triage::apply_row`]: an id an
    /// active ignore or the catalogue names.
    pub fn wants(&self, id: &str) -> bool {
        self.kev.contains(id)
            || self
                .rules
                .iter()
                .any(|r| r.active(self.now) && r.id.eq_ignore_ascii_case(id))
    }

    /// The active ignore of `id` in `row`, if any (nauvi's own before the
    /// file's).
    pub fn rule_for(&self, id: &str, row: &ImageVulns) -> Option<&IgnoreRule> {
        let mut found = self.rules.iter().filter(|r| {
            r.active(self.now) && r.id.eq_ignore_ascii_case(id) && r.covers(row, &self.context)
        });
        let first = found.next()?;
        if first.from_file {
            if let Some(own) = found.find(|r| !r.from_file) {
                return Some(own);
            }
        }
        Some(first)
    }

    fn known_exploited(&self, id: &str, scanner_says: bool) -> bool {
        scanner_says || self.kev.contains(id)
    }

    /// Take the ignored vulnerabilities of `marks` (those of `row`'s
    /// report or scan) out of its counts, into `ignored`, and count the
    /// known exploited ones that are left. `row`'s counts are the report's
    /// own (not yet triaged).
    pub fn apply_row(&self, row: &mut ImageVulns, marks: &[Mark]) {
        let mut ignored = SeverityCounts::default();
        let mut ignored_fixable = SeverityCounts::default();
        let mut kev = 0u32;
        for m in marks {
            if self.rule_for(&m.id, row).is_some() {
                ignored.add(m.severity);
                if m.fixable {
                    ignored_fixable.add(m.severity);
                }
            } else if self.known_exploited(&m.id, m.kev) {
                kev = kev.saturating_add(1);
            }
        }
        for s in Severity::ALL {
            sub(&mut row.counts, s, ignored.get(s));
            sub(&mut row.fixable, s, ignored_fixable.get(s));
        }
        row.ignored = ignored;
        row.kev = kev;
    }

    /// Mark the known exploited findings of `detail` and move its ignored
    /// ones to `ignored`, with their reasons; the fixes are grouped again.
    /// Its row is not changed (the listing's is already triaged).
    pub fn apply_detail(&self, detail: &mut ImageDetail) {
        let vulns = std::mem::take(&mut detail.vulnerabilities);
        let mut kept = Vec::with_capacity(vulns.len());
        for mut v in vulns {
            v.exploit.kev = self.known_exploited(&v.id, v.exploit.kev);
            match self.rule_for(&v.id, &detail.image) {
                Some(r) => detail.ignored.push(IgnoredVuln {
                    vulnerability: v,
                    reason: r.reason.clone(),
                    from_file: r.from_file,
                    expires: r.expires,
                }),
                None => kept.push(v),
            }
        }
        detail.fix_groups = fix_groups(&kept);
        detail.vulnerabilities = kept;
    }

    /// A key that changes when what this triage would do changes (a rule,
    /// the catalogue, the day an ignore expires on).
    pub fn key(&self) -> u64 {
        if self.is_empty() {
            return 0;
        }
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.rules.hash(&mut h);
        self.context.hash(&mut h);
        let mut ids: Vec<&String> = self.kev.iter().collect();
        ids.sort();
        ids.hash(&mut h);
        // Which ignores are active now.
        for r in &self.rules {
            r.active(self.now).hash(&mut h);
        }
        h.finish()
    }
}

fn sub(c: &mut SeverityCounts, s: Severity, n: u32) {
    let v = match s {
        Severity::Critical => &mut c.critical,
        Severity::High => &mut c.high,
        Severity::Medium => &mut c.medium,
        Severity::Low => &mut c.low,
        Severity::Unknown => &mut c.unknown,
    };
    *v = v.saturating_sub(n);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_security::ignore::IgnoreScope;
    use crate::image_security::{Exploit, ScanSource, Workload};

    fn vuln(id: &str, sev: Severity, fixed: &str) -> Vulnerability {
        Vulnerability {
            id: id.into(),
            package: "openssl".into(),
            installed_version: "3.0.11".into(),
            fixed_version: fixed.into(),
            severity: sev,
            score: 0.0,
            title: String::new(),
            link: String::new(),
            exploit: Exploit::default(),
        }
    }

    fn row() -> ImageVulns {
        ImageVulns {
            source: ScanSource::TrivyOperator,
            image: "nginx:1.27".into(),
            digest: "sha256:1111".into(),
            running: true,
            scanned: true,
            counts: SeverityCounts {
                critical: 2,
                high: 1,
                ..Default::default()
            },
            fixable: SeverityCounts {
                critical: 2,
                ..Default::default()
            },
            ignored: SeverityCounts::default(),
            kev: 0,
            workloads: vec![Workload {
                kind: "Deployment".into(),
                namespace: "shop".into(),
                name: "web".into(),
                container: "nginx".into(),
            }],
            report_namespace: String::new(),
            report_name: String::new(),
            reports: 1,
            scanner: String::new(),
            scanned_at: 0,
        }
    }

    fn triage() -> Triage {
        Triage {
            rules: vec![
                IgnoreRule {
                    id: "CVE-1".into(),
                    scope: IgnoreScope::Everywhere,
                    reason: "from the file".into(),
                    from_file: true,
                    ..Default::default()
                },
                IgnoreRule {
                    id: "CVE-1".into(),
                    scope: IgnoreScope::Workload,
                    namespace: "shop".into(),
                    kind: "Deployment".into(),
                    name: "web".into(),
                    reason: "not reachable".into(),
                    ..Default::default()
                },
                IgnoreRule {
                    id: "CVE-9".into(),
                    scope: IgnoreScope::Image,
                    image: "nginx".into(),
                    reason: "expired".into(),
                    expires: 50,
                    ..Default::default()
                },
            ],
            kev: ["CVE-2".to_string(), "CVE-3".to_string()].into(),
            context: "kind".into(),
            now: 100,
        }
    }

    #[test]
    fn ignored_ones_are_counted_not_hidden() {
        let t = triage();
        assert!(t.wants("cve-1") && t.wants("CVE-2"));
        assert!(!t.wants("CVE-9"), "expired");
        let marks = [
            Mark::of(&vuln("CVE-1", Severity::Critical, "1.1")),
            Mark::of(&vuln("CVE-2", Severity::Critical, "1.1")),
            Mark::of(&vuln("CVE-9", Severity::High, "")),
        ];
        let mut r = row();
        t.apply_row(&mut r, &marks);
        assert_eq!(r.counts.critical, 1);
        assert_eq!(r.counts.high, 1, "an expired ignore counts again");
        assert_eq!(r.fixable.critical, 1);
        assert_eq!(r.ignored.critical, 1);
        assert_eq!(r.ignored.total(), 1);
        assert_eq!(r.kev, 1);
        // The file's ignore and nauvi's own both match: nauvi's reason.
        assert_eq!(t.rule_for("CVE-1", &r).unwrap().reason, "not reachable");
    }

    #[test]
    fn the_findings_say_why() {
        let t = triage();
        let mut kev_by_scanner = vuln("CVE-7", Severity::Low, "");
        kev_by_scanner.exploit.kev = true;
        let mut d = ImageDetail {
            image: row(),
            vulnerabilities: vec![
                vuln("CVE-1", Severity::Critical, "1.1"),
                vuln("CVE-2", Severity::Critical, "1.1"),
                kev_by_scanner,
                vuln("CVE-9", Severity::High, ""),
            ],
            fix_groups: Vec::new(),
            ignored: Vec::new(),
        };
        t.apply_detail(&mut d);
        let ids: Vec<_> = d.vulnerabilities.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["CVE-2", "CVE-7", "CVE-9"]);
        assert!(d.vulnerabilities[0].exploit.kev);
        assert!(d.vulnerabilities[1].exploit.kev, "the scanner's KEV");
        assert!(!d.vulnerabilities[2].exploit.kev);
        assert_eq!(d.ignored.len(), 1);
        assert_eq!(d.ignored[0].reason, "not reachable");
        assert_eq!(d.fix_groups.len(), 1);
        assert_eq!(d.fix_groups[0].ids, ["CVE-2", "CVE-7", "CVE-9"]);
    }

    #[test]
    fn the_key_follows_the_rules_and_the_clock() {
        let t = triage();
        let mut later = t.clone();
        later.now = 10;
        assert_ne!(t.key(), later.key(), "CVE-9 is active again at 10");
        let mut same = t.clone();
        same.now = 200;
        assert_eq!(t.key(), same.key());
        assert_ne!(Triage::default().key(), t.key());
        assert!(Triage::default().is_empty());
    }
}
