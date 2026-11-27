//! Image security (#533, ADR 0011): which running images have known
//! vulnerabilities, from the scans the cluster already has.
//!
//! The source is the Trivy Operator's `VulnerabilityReport`s
//! (`aquasecurity.github.io/v1alpha1`, one per workload container), read
//! with the user's own RBAC, only when asked: no watch, no polling. nauvi
//! never scans an image itself here and never reads `imagePullSecrets`.
//!
//! - [`images`]: the pods' containers to distinct images, keyed by digest.
//! - [`trivy_operator`]: whether the cluster serves the reports, who may
//!   list them, and reading them (summaries in small pages, one full
//!   report only when it is shown).
//! - [`report`]: one row per image, filters, and fixes grouped by package.
//! - [`render`]: the text of the CLI (and later the MCP tool).
//!
//! Results are never "problems": no pill, no notification.

pub mod images;
pub mod render;
pub mod report;
pub mod trivy_operator;

use serde::{Deserialize, Serialize};

/// How bad a vulnerability is, as the scanner rates it. Ordered from
/// `Unknown` (lowest) to `Critical`.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Default,
    Serialize,
    Deserialize,
    clap::ValueEnum,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    #[default]
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    /// Every severity, worst first.
    pub const ALL: [Severity; 5] = [
        Severity::Critical,
        Severity::High,
        Severity::Medium,
        Severity::Low,
        Severity::Unknown,
    ];

    /// The scanner's word (`CRITICAL`, `high`, ...); anything else is
    /// `Unknown`.
    pub fn parse(s: &str) -> Severity {
        match s.trim().to_ascii_uppercase().as_str() {
            "CRITICAL" => Severity::Critical,
            "HIGH" => Severity::High,
            "MEDIUM" => Severity::Medium,
            "LOW" => Severity::Low,
            _ => Severity::Unknown,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::High => "high",
            Severity::Medium => "medium",
            Severity::Low => "low",
            Severity::Unknown => "unknown",
        }
    }
}

/// Vulnerabilities by severity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SeverityCounts {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
}

impl SeverityCounts {
    pub fn get(&self, s: Severity) -> u32 {
        match s {
            Severity::Critical => self.critical,
            Severity::High => self.high,
            Severity::Medium => self.medium,
            Severity::Low => self.low,
            Severity::Unknown => self.unknown,
        }
    }

    pub fn add(&mut self, s: Severity) {
        let n = match s {
            Severity::Critical => &mut self.critical,
            Severity::High => &mut self.high,
            Severity::Medium => &mut self.medium,
            Severity::Low => &mut self.low,
            Severity::Unknown => &mut self.unknown,
        };
        *n = n.saturating_add(1);
    }

    pub fn total(&self) -> u32 {
        self.at_least(Severity::Unknown)
    }

    /// How many are `min` or worse.
    pub fn at_least(&self, min: Severity) -> u32 {
        Severity::ALL
            .iter()
            .filter(|&&s| s >= min)
            .fold(0u32, |n, &s| n.saturating_add(self.get(s)))
    }

    /// The worst severity with a count, `None` when all are zero.
    pub fn worst(&self) -> Option<Severity> {
        Severity::ALL.into_iter().find(|&s| self.get(s) > 0)
    }

    /// The order of rows: more critical first, then more high, ...
    pub fn rank(&self) -> [u32; 5] {
        Severity::ALL.map(|s| self.get(s))
    }
}

/// A workload container that runs an image: the Deployment (not its
/// ReplicaSet), StatefulSet, DaemonSet, Job, CronJob or bare Pod.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Workload {
    /// `Deployment`, `ReplicaSet`, `Pod`, ...
    pub kind: String,
    pub namespace: String,
    pub name: String,
    pub container: String,
}

/// Where vulnerability data comes from (ADR 0011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ScanSource {
    /// The Trivy Operator's VulnerabilityReports in the cluster.
    TrivyOperator,
}

/// One distinct image (by digest, else by reference) and what is known
/// about its vulnerabilities.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ImageVulns {
    pub source: ScanSource,
    /// The reference as a pod names it (`nginx:1.27`), or as the report
    /// does when no running pod matched (`repo@sha256:...` without a tag).
    pub image: String,
    /// `sha256:...`, empty when neither the pods nor the report know it.
    pub digest: String,
    /// A pod in the scope runs it. False for a report of an image no pod
    /// runs (a deleted workload, or an older build of a mutable tag).
    pub running: bool,
    /// A report covers this image.
    pub scanned: bool,
    /// From the newest report's summary (all zero when not scanned).
    pub counts: SeverityCounts,
    /// How many of `counts` have a fixed version.
    pub fixable: SeverityCounts,
    /// The workload containers that use it (running pods and reports),
    /// sorted, each once.
    pub workloads: Vec<Workload>,
    /// The newest report: namespace and name, empty when not scanned.
    pub report_namespace: String,
    pub report_name: String,
    /// How many reports cover this image.
    pub reports: u32,
    /// `Trivy 0.58.1`; empty when not scanned.
    pub scanner: String,
    /// When the newest report was made (unix seconds), 0 when not scanned.
    pub scanned_at: i64,
}

/// What a listing could show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum VulnsState {
    /// Reports were read (`images` may still be empty after filters).
    Ok,
    /// The cluster does not serve VulnerabilityReports: no Trivy Operator.
    NoOperator,
    /// The CRD is there but no report exists in the scope yet.
    NoReports,
    /// The user may not list the reports in the scope.
    Forbidden,
}

/// The result of [`report::image_vulns`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct VulnsSummary {
    pub source: ScanSource,
    pub state: VulnsState,
    /// The namespace asked for, empty for all namespaces.
    pub namespace: String,
    /// The namespaces that were read when the cluster-wide list is not
    /// allowed (empty when it is, or when one namespace was asked for).
    pub namespaces_read: Vec<String>,
    /// One row per image, worst first, after the filters.
    pub images: Vec<ImageVulns>,
    /// Namespaces where listing the reports was not allowed, while other
    /// namespaces were read (or, with the [`VulnsState::Forbidden`] state,
    /// the namespaces asked for).
    pub forbidden_namespaces: Vec<String>,
    /// With [`VulnsState::Forbidden`] for chosen namespaces: the reports
    /// may be listed across all namespaces (so offering that helps).
    /// False otherwise.
    pub all_namespaces_allowed: bool,
    /// Running images no report covers (before the filters). Images in
    /// namespaces whose reports were not read (the read budget ran out)
    /// are neither counted here nor listed: a note says so.
    pub unscanned: u32,
    /// Plain notes: what could not be read, what was cut.
    pub notes: Vec<String>,
}

/// One vulnerability of a full report.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Vulnerability {
    /// `CVE-2024-1234`, `GHSA-...`.
    pub id: String,
    /// The package or library (`openssl`, `golang.org/x/net`).
    pub package: String,
    pub installed_version: String,
    /// Empty when no fix is known.
    pub fixed_version: String,
    pub severity: Severity,
    /// The CVSS score the scanner reports, 0 when none.
    pub score: f64,
    pub title: String,
    /// The advisory's page, empty when none.
    pub link: String,
}

/// The vulnerabilities one package upgrade would fix (or that have no fix
/// yet): one package at one installed version.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FixGroup {
    pub package: String,
    pub installed_version: String,
    /// The distinct fixed versions of its vulnerabilities, sorted; empty
    /// when none has a fix.
    pub fixed_in: Vec<String>,
    pub counts: SeverityCounts,
    /// How many of `counts` have a fixed version.
    pub fixable: u32,
    /// The vulnerability ids, worst first.
    pub ids: Vec<String>,
}

/// One image with its full (newest) report.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ImageDetail {
    pub image: ImageVulns,
    /// Worst first, after the filters.
    pub vulnerabilities: Vec<Vulnerability>,
    /// Worst first, after the filters.
    pub fix_groups: Vec<FixGroup>,
}

/// What to list: the arguments of `nauvi vulns`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VulnsArgs {
    /// One namespace; `None` for all namespaces the user may read.
    pub namespace: Option<String>,
    /// Only images (and vulnerabilities) of this severity or worse.
    pub severity: Option<Severity>,
    /// Only what has a fixed version.
    pub fixable: bool,
}

pub use report::{
    cli_vulns, image_detail, image_detail_of, image_vulns, image_vulns_in,
    image_vulns_in_namespaces,
};
