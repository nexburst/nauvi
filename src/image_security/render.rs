//! Text for `nauvi vulns` (and the MCP tool later), like
//! `src/problems.rs`. Every cell is cluster text: names, versions and
//! titles go through [`single_line`], so a report cannot draw on the
//! terminal.

use super::{ImageDetail, ImageVulns, SeverityCounts, VulnsState, VulnsSummary, Workload};
use crate::problems::span;
use crate::resources::align_columns;
use crate::text::{one_line, single_line};

/// Most workloads named in one row of the list.
const MAX_WORKLOADS: usize = 3;
/// Most vulnerability ids named in one fix group.
const MAX_IDS: usize = 4;
/// Most characters of a vulnerability's title.
const MAX_TITLE: usize = 70;

fn place(s: &VulnsSummary) -> String {
    if !s.namespace.is_empty() {
        format!("namespace {}", s.namespace)
    } else if !s.namespaces_read.is_empty() {
        format!("namespaces {}", s.namespaces_read.join(", "))
    } else {
        "all namespaces".to_string()
    }
}

/// The plain message of a state that has nothing to list (empty for
/// [`VulnsState::Ok`]).
pub fn state_message(s: &VulnsSummary) -> String {
    match s.state {
        VulnsState::Ok => String::new(),
        VulnsState::NoOperator => "No Trivy Operator in this cluster: it does not serve \
             VulnerabilityReports (aquasecurity.github.io). nauvi shows the scans the \
             operator makes; install it to see image vulnerabilities."
            .to_string(),
        VulnsState::NoReports => format!(
            "No VulnerabilityReports in {} yet: the Trivy Operator has not scanned these \
             images. It scans new workloads within minutes; check that it watches this \
             namespace.",
            place(s)
        ),
        VulnsState::Forbidden => format!(
            "Not allowed to list VulnerabilityReports (aquasecurity.github.io) in {}.",
            place(s)
        ),
    }
}

/// `1 critical, 2 high`, or `none`.
pub fn counts_text(c: &SeverityCounts) -> String {
    let parts: Vec<String> = super::Severity::ALL
        .iter()
        .filter(|&&s| c.get(s) > 0)
        .map(|&s| format!("{} {}", c.get(s), s.label()))
        .collect();
    if parts.is_empty() {
        "none".to_string()
    } else {
        parts.join(", ")
    }
}

fn short_kind(kind: &str) -> String {
    match kind {
        "Deployment" => "deploy".into(),
        "StatefulSet" => "sts".into(),
        "DaemonSet" => "ds".into(),
        "ReplicaSet" => "rs".into(),
        "Job" => "job".into(),
        "CronJob" => "cronjob".into(),
        "Pod" => "pod".into(),
        k => k.to_lowercase(),
    }
}

/// `deploy/web`, with ` (ns)` when several namespaces are listed.
fn workload_text(w: &Workload, with_namespace: bool) -> String {
    let mut s = format!("{}/{}", short_kind(&w.kind), w.name);
    if with_namespace && !w.namespace.is_empty() {
        s.push_str(&format!(" ({})", w.namespace));
    }
    s
}

/// The workloads of a row, each once (whatever the container), at most
/// [`MAX_WORKLOADS`] and `+N more`.
pub fn workloads_cell(workloads: &[Workload], with_namespace: bool) -> String {
    let mut names: Vec<String> = Vec::new();
    for w in workloads {
        let t = workload_text(w, with_namespace);
        if !names.contains(&t) {
            names.push(t);
        }
    }
    let more = names.len().saturating_sub(MAX_WORKLOADS);
    names.truncate(MAX_WORKLOADS);
    let mut s = names.join(", ");
    if more > 0 {
        s.push_str(&format!(" +{more} more"));
    }
    if s.is_empty() {
        "-".into()
    } else {
        s
    }
}

fn ago(when: i64, now: i64) -> String {
    if when > 0 {
        format!("{} ago", span(now - when))
    } else {
        "unknown".into()
    }
}

fn several_namespaces(images: &[ImageVulns]) -> bool {
    let mut it = images
        .iter()
        .flat_map(|r| r.workloads.iter())
        .map(|w| w.namespace.as_str());
    let first = it.next();
    it.any(|n| Some(n) != first)
}

/// The list: one row per image, then a line with the scope and the age of
/// the data, then the notes.
pub fn render_list(s: &VulnsSummary, now: i64) -> String {
    let mut out = String::new();
    if s.state != VulnsState::Ok {
        out.push_str(&state_message(s));
        out.push('\n');
        if s.state == VulnsState::NoReports && s.unscanned > 0 {
            out.push_str(&format!(
                "{} running image{} not scanned.\n",
                s.unscanned,
                if s.unscanned == 1 { "" } else { "s" }
            ));
        }
        for n in &s.notes {
            out.push_str(&single_line(n));
            out.push('\n');
        }
        return out;
    }
    if s.images.is_empty() {
        out.push_str("No images match.\n");
    } else {
        let with_ns = several_namespaces(&s.images);
        let mut table = vec![[
            "IMAGE",
            "CRITICAL",
            "HIGH",
            "MEDIUM",
            "LOW",
            "UNKNOWN",
            "FIXABLE",
            "SCANNED",
            "WORKLOADS",
        ]
        .map(String::from)
        .to_vec()];
        for r in &s.images {
            let n = |v: u32| {
                if r.scanned {
                    v.to_string()
                } else {
                    "-".into()
                }
            };
            let c = &r.counts;
            let row = [
                r.image.clone(),
                n(c.critical),
                n(c.high),
                n(c.medium),
                n(c.low),
                n(c.unknown),
                n(r.fixable.total()),
                if r.scanned {
                    ago(r.scanned_at, now)
                } else {
                    "not scanned".into()
                },
                workloads_cell(&r.workloads, with_ns),
            ];
            table.push(row.iter().map(|c| single_line(c)).collect());
        }
        out.push_str(&align_columns(&table));
    }
    let scanned: Vec<&ImageVulns> = s.images.iter().filter(|r| r.scanned).collect();
    let mut line = format!(
        "({} image{} in {}",
        s.images.len(),
        if s.images.len() == 1 { "" } else { "s" },
        place(s)
    );
    if s.unscanned > 0 {
        line.push_str(&format!(", {} running not scanned", s.unscanned));
    }
    let oldest = scanned
        .iter()
        .map(|r| r.scanned_at)
        .filter(|&t| t > 0)
        .min();
    let mut scanners: Vec<&str> = scanned.iter().map(|r| r.scanner.as_str()).collect();
    scanners.sort_unstable();
    scanners.dedup();
    if let Some(t) = oldest {
        line.push_str(&format!(
            "; from the Trivy Operator's reports ({}), the oldest {}",
            scanners.join(", "),
            ago(t, now)
        ));
    }
    line.push_str(")\n");
    out.push_str(&single_line(&line));
    out.push('\n');
    for n in &s.notes {
        out.push_str(&single_line(n));
        out.push('\n');
    }
    out
}

/// One image: what it is, how old its report is, its fixes by package
/// and its vulnerabilities.
pub fn render_detail(d: &ImageDetail, now: i64) -> String {
    let r = &d.image;
    let mut head = vec![
        vec!["Image:".to_string(), r.image.clone()],
        vec![
            "Digest:".to_string(),
            if r.digest.is_empty() {
                "unknown".into()
            } else {
                r.digest.clone()
            },
        ],
    ];
    let used: Vec<String> = r
        .workloads
        .iter()
        .map(|w| format!("{} [{}]", workload_text(w, true), w.container))
        .collect();
    head.push(vec!["Used by:".to_string(), used.join(", ")]);
    if !r.scanned {
        head.push(vec!["Scanned:".to_string(), "not scanned yet".into()]);
    } else {
        head.push(vec![
            "Scanned:".to_string(),
            format!(
                "{} by {} (VulnerabilityReport {}/{})",
                ago(r.scanned_at, now),
                r.scanner,
                r.report_namespace,
                r.report_name
            ),
        ]);
        head.push(vec![
            "Found:".to_string(),
            format!(
                "{}; {} with a fix",
                counts_text(&r.counts),
                r.fixable.total()
            ),
        ]);
    }
    let head: Vec<Vec<String>> = head
        .into_iter()
        .map(|row| row.iter().map(|c| single_line(c)).collect())
        .collect();
    let mut out = align_columns(&head);
    if !r.scanned {
        return out;
    }
    if d.vulnerabilities.is_empty() {
        out.push_str("\nNo vulnerabilities match.\n");
        return out;
    }
    out.push_str("\nFixes by package:\n");
    let mut table = vec![
        ["PACKAGE", "INSTALLED", "FIXED IN", "VULNERABILITIES", "IDS"]
            .map(String::from)
            .to_vec(),
    ];
    for g in &d.fix_groups {
        let fixed = if g.fixed_in.is_empty() {
            "no fix yet".to_string()
        } else if g.fixable < g.counts.total() {
            format!(
                "{} ({} of {})",
                g.fixed_in.join(", "),
                g.fixable,
                g.counts.total()
            )
        } else {
            g.fixed_in.join(", ")
        };
        let mut ids = g
            .ids
            .iter()
            .take(MAX_IDS)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        if g.ids.len() > MAX_IDS {
            ids.push_str(&format!(" +{} more", g.ids.len() - MAX_IDS));
        }
        let row = [
            g.package.clone(),
            g.installed_version.clone(),
            fixed,
            counts_text(&g.counts),
            ids,
        ];
        table.push(row.iter().map(|c| single_line(c)).collect());
    }
    out.push_str(&align_columns(&table));
    out.push_str("\nVulnerabilities:\n");
    let mut table = vec![["ID", "SEVERITY", "SCORE", "PACKAGE", "FIXED IN", "TITLE"]
        .map(String::from)
        .to_vec()];
    for v in &d.vulnerabilities {
        let row = [
            v.id.clone(),
            v.severity.label().to_string(),
            if v.score > 0.0 {
                format!("{:.1}", v.score)
            } else {
                "-".into()
            },
            v.package.clone(),
            if v.fixed_version.is_empty() {
                "-".into()
            } else {
                v.fixed_version.clone()
            },
            one_line(&v.title, MAX_TITLE),
        ];
        table.push(row.iter().map(|c| single_line(c)).collect());
    }
    out.push_str(&align_columns(&table));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_security::report::tests::fixture_rows;
    use crate::image_security::report::{filter_vulnerabilities, fix_groups};
    use crate::image_security::trivy_operator::parse_report;
    use crate::image_security::VulnsArgs;

    /// 2026-11-26T10:00:00Z.
    const NOW: i64 = 1_795_687_200;

    fn summary(state: VulnsState) -> VulnsSummary {
        VulnsSummary {
            state,
            namespace: "shop".into(),
            namespaces_read: Vec::new(),
            images: Vec::new(),
            unscanned: 0,
            notes: Vec::new(),
        }
    }

    #[test]
    fn each_empty_state_says_why() {
        let none = render_list(&summary(VulnsState::NoOperator), NOW);
        assert!(
            none.starts_with("No Trivy Operator in this cluster"),
            "{none}"
        );
        let mut empty = summary(VulnsState::NoReports);
        empty.unscanned = 3;
        let empty = render_list(&empty, NOW);
        assert!(
            empty.starts_with("No VulnerabilityReports in namespace shop yet"),
            "{empty}"
        );
        assert!(empty.contains("3 running images not scanned."), "{empty}");
        let denied = render_list(&summary(VulnsState::Forbidden), NOW);
        assert_eq!(
            denied,
            "Not allowed to list VulnerabilityReports (aquasecurity.github.io) in namespace shop.\n"
        );
    }

    #[test]
    fn the_list_has_one_row_per_image_and_the_age_of_the_data() {
        let mut s = summary(VulnsState::Ok);
        s.images = fixture_rows();
        s.unscanned = 1;
        let text = render_list(&s, NOW);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("IMAGE"), "{text}");
        assert!(
            lines[1].starts_with("nginx:1.27") && lines[1].contains("6d ago"),
            "{text}"
        );
        assert!(lines[1].ends_with("deploy/web, pod/static"), "{text}");
        assert!(
            lines[2].starts_with("redis:7") && lines[2].ends_with("sts/cache"),
            "{text}"
        );
        assert!(lines[3].contains("not scanned"), "{text}");
        assert_eq!(
            lines[4],
            "(3 images in namespace shop, 1 running not scanned; from the Trivy Operator's \
             reports (Trivy 0.58.1), the oldest 8d ago)"
        );
        let cols: Vec<&str> = lines[1].split_whitespace().collect();
        assert_eq!(&cols[1..8], ["1", "2", "1", "1", "1", "3", "6d"]);
    }

    #[test]
    fn workloads_are_cut_after_three() {
        let w = |name: &str, ns: &str| Workload {
            kind: "Deployment".into(),
            namespace: ns.into(),
            name: name.into(),
            container: "c".into(),
        };
        let list = [
            w("a", "x"),
            w("a", "x"),
            w("b", "x"),
            w("c", "y"),
            w("d", "y"),
        ];
        assert_eq!(
            workloads_cell(&list, false),
            "deploy/a, deploy/b, deploy/c +1 more"
        );
        assert_eq!(workloads_cell(&list[..1], true), "deploy/a (x)");
        assert_eq!(workloads_cell(&[], false), "-");
    }

    #[test]
    fn the_detail_groups_fixes_and_strips_control_characters() {
        let full = parse_report(include_bytes!("testdata/report-web.json")).unwrap();
        let vulnerabilities = filter_vulnerabilities(full.vulnerabilities, &VulnsArgs::default());
        let d = ImageDetail {
            image: fixture_rows()[0].clone(),
            fix_groups: fix_groups(&vulnerabilities),
            vulnerabilities,
        };
        let text = render_detail(&d, NOW);
        assert!(
            text.contains("Found:    1 critical, 2 high, 1 medium, 1 low, 1 unknown; 3 with a fix"),
            "{text}"
        );
        assert!(
            text.contains("Used by:  deploy/web (shop) [nginx], pod/static (shop) [nginx]"),
            "{text}"
        );
        let openssl = text.lines().find(|l| l.starts_with("openssl")).unwrap();
        assert!(openssl.contains("3.0.14-1, 3.0.15-1"), "{openssl}");
        assert!(
            openssl.contains("CVE-2026-0001, CVE-2026-0002"),
            "{openssl}"
        );
        let curl = text.lines().find(|l| l.starts_with("curl")).unwrap();
        assert!(curl.contains("7.88.1-10+deb12u8 (1 of 2)"), "{curl}");
        assert!(text.contains("no fix yet"), "{text}");
        assert!(!text.contains('\u{1b}'), "{text}");
    }
}
