//! Ignoring vulnerabilities (#537): nauvi's own ignores (a vulnerability,
//! a scope, a reason and an optional expiry) and a `.trivyignore` file.
//!
//! An ignored vulnerability is not counted, but never hidden silently: the
//! rows and the panel say how many were ignored and why. An expired ignore
//! no longer applies, so its vulnerability counts again.

use super::ImageVulns;
use crate::registry_tags::ImageRef;
use crate::text::single_line;
use serde::{Deserialize, Serialize};

/// Most ignores kept (nauvi's own, and read from a file).
pub const MAX_RULES: usize = 2000;
/// A reason is cut to this many characters.
pub const MAX_REASON: usize = 300;
/// A `.trivyignore` larger than this is not read.
pub const MAX_FILE: u64 = 1024 * 1024;

/// What an ignore covers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum IgnoreScope {
    /// Every image of one repository (`nginx`, any tag or digest).
    #[default]
    Image,
    /// One workload (its kind, namespace and name) of one cluster.
    Workload,
    /// Every image in one namespace of one cluster.
    Namespace,
    /// Everywhere: the lines of a `.trivyignore`.
    Everywhere,
}

/// One ignore.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct IgnoreRule {
    /// `CVE-2024-1234`, `GHSA-xxxx-xxxx-xxxx`.
    pub id: String,
    pub scope: IgnoreScope,
    /// The cluster (its context id) of a workload or namespace ignore.
    pub context: String,
    /// The image of an image ignore, as listed (`nginx:1.27`): every tag
    /// of its repository is covered.
    pub image: String,
    /// The namespace of a workload or namespace ignore.
    pub namespace: String,
    /// The workload of a workload ignore: `Deployment`, `web`.
    pub kind: String,
    pub name: String,
    /// Why it is ignored. Required.
    pub reason: String,
    /// When it stops applying (unix seconds), 0 for never.
    pub expires: i64,
    /// When it was added (unix seconds), 0 when not known.
    pub added: i64,
    /// Read from the ignore file (not one of nauvi's own).
    pub from_file: bool,
}

/// A vulnerability id as scanners write them: letters, digits and
/// `-_.:`, 3 to 64 characters, starting with a letter or digit.
pub fn valid_id(id: &str) -> bool {
    (3..=64).contains(&id.len())
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// The repository an image ignore matches: `docker.io/library/nginx` for
/// `nginx:1.27`; the reference without its tag and digest when it does not
/// parse.
pub fn repository_of(image: &str) -> String {
    let r = image.trim();
    let r = r.split_once('@').map_or(r, |(name, _)| name);
    match ImageRef::parse(r) {
        Ok(i) => format!("{}/{}", i.registry, i.repository),
        Err(_) => match r.rsplit_once(':') {
            Some((name, tag)) if !tag.contains('/') => name.to_string(),
            _ => r.to_string(),
        },
    }
}

impl IgnoreRule {
    /// The rule cleaned, or why it cannot be kept.
    pub fn checked(mut self) -> Result<Self, String> {
        self.id = self.id.trim().to_string();
        if !valid_id(&self.id) {
            return Err(format!("{:?} is not a vulnerability id.", self.id));
        }
        self.reason = single_line(&self.reason)
            .trim()
            .chars()
            .take(MAX_REASON)
            .collect();
        if self.reason.is_empty() {
            return Err(format!("The ignore of {} needs a reason.", self.id));
        }
        for f in [
            &mut self.context,
            &mut self.image,
            &mut self.namespace,
            &mut self.kind,
            &mut self.name,
        ] {
            *f = single_line(f).trim().chars().take(253).collect();
        }
        self.expires = self.expires.max(0);
        let missing = match self.scope {
            IgnoreScope::Image => self.image.is_empty().then_some("an image"),
            IgnoreScope::Namespace => self.namespace.is_empty().then_some("a namespace"),
            IgnoreScope::Workload => {
                (self.namespace.is_empty() || self.kind.is_empty() || self.name.is_empty())
                    .then_some("a workload")
            }
            IgnoreScope::Everywhere => None,
        };
        if let Some(what) = missing {
            return Err(format!("The ignore of {} needs {what}.", self.id));
        }
        Ok(self)
    }

    /// Whether it still applies at `now` (unix seconds).
    pub fn active(&self, now: i64) -> bool {
        self.expires == 0 || now < self.expires
    }

    /// Whether it covers `row` of cluster `context`: an image ignore its
    /// repository; a workload or namespace ignore every workload that uses
    /// it (an image used elsewhere too still counts there).
    pub fn covers(&self, row: &ImageVulns, context: &str) -> bool {
        let same_cluster = self.context.is_empty() || self.context == context;
        match self.scope {
            IgnoreScope::Everywhere => true,
            IgnoreScope::Image => repository_of(&self.image) == repository_of(&row.image),
            IgnoreScope::Namespace => {
                same_cluster
                    && !row.workloads.is_empty()
                    && row.workloads.iter().all(|w| w.namespace == self.namespace)
            }
            IgnoreScope::Workload => {
                same_cluster
                    && !row.workloads.is_empty()
                    && row.workloads.iter().all(|w| {
                        w.namespace == self.namespace && w.kind == self.kind && w.name == self.name
                    })
            }
        }
    }

    /// Whether `self` and `other` ignore the same thing (an id in one
    /// scope), whatever their reasons.
    pub fn same_target(&self, other: &IgnoreRule) -> bool {
        self.id.eq_ignore_ascii_case(&other.id)
            && self.scope == other.scope
            && self.context == other.context
            && (self.scope != IgnoreScope::Image
                || repository_of(&self.image) == repository_of(&other.image))
            && self.namespace == other.namespace
            && self.kind == other.kind
            && self.name == other.name
    }
}

/// `rules` cleaned: invalid ones (no reason, no id) dropped, a later rule
/// for the same target replacing an earlier one, at most [`MAX_RULES`].
pub fn normalized(rules: Vec<IgnoreRule>) -> Vec<IgnoreRule> {
    let mut out: Vec<IgnoreRule> = Vec::new();
    for r in rules.into_iter().filter_map(|r| r.checked().ok()) {
        if let Some(i) = out.iter().position(|o| o.same_target(&r)) {
            out.remove(i);
        }
        out.push(r);
    }
    out.truncate(MAX_RULES);
    out
}

/// `2024-03-01` as the start of that day, UTC (unix seconds).
fn day_start(date: &str) -> Option<i64> {
    let d: jiff::civil::Date = date.trim().parse().ok()?;
    d.to_zoned(jiff::tz::TimeZone::UTC)
        .ok()
        .map(|z| z.timestamp().as_second())
}

/// What a `.trivyignore` gave: the ignores, and the lines that were not
/// understood.
#[derive(Debug, Default, PartialEq)]
pub struct IgnoreFile {
    pub rules: Vec<IgnoreRule>,
    /// The numbers of the lines not understood (at most 20): only their
    /// numbers, so a file chosen by mistake is not shown.
    pub skipped: Vec<u32>,
}

/// A `.trivyignore`: one id per line, optionally followed by
/// `exp:YYYY-MM-DD` (it applies until that day) and a `# comment`. The
/// reason is the comment on the line, else the comment lines just above
/// it, else `Listed in <name>`. Blank lines end a comment block.
pub fn parse_trivyignore(text: &str, name: &str) -> IgnoreFile {
    let mut out = IgnoreFile::default();
    let mut comment: Vec<String> = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            comment.clear();
            continue;
        }
        if let Some(c) = line.strip_prefix('#') {
            let c = c.trim();
            if !c.is_empty() {
                comment.push(c.to_string());
            }
            continue;
        }
        let (entry, inline) = match line.split_once('#') {
            Some((e, c)) => (e.trim(), c.trim()),
            None => (line, ""),
        };
        let mut parts = entry.split_whitespace();
        let id = parts.next().unwrap_or_default();
        let mut expires = 0;
        let mut ok = valid_id(id);
        for p in parts {
            match p.strip_prefix("exp:").and_then(day_start) {
                Some(t) => expires = t,
                None => ok = false,
            }
        }
        if !ok {
            if out.skipped.len() < 20 {
                out.skipped.push(n as u32 + 1);
            }
            continue;
        }
        let reason = if !inline.is_empty() {
            inline.to_string()
        } else if !comment.is_empty() {
            comment.join(" ")
        } else {
            format!("Listed in {name}")
        };
        let rule = IgnoreRule {
            id: id.to_string(),
            scope: IgnoreScope::Everywhere,
            reason,
            expires,
            from_file: true,
            ..Default::default()
        };
        if let Ok(r) = rule.checked() {
            out.rules.push(r);
        }
        if out.rules.len() >= MAX_RULES {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_security::{ScanSource, SeverityCounts, Workload};

    pub(crate) fn row(image: &str, workloads: &[(&str, &str, &str)]) -> ImageVulns {
        ImageVulns {
            source: ScanSource::TrivyOperator,
            image: image.into(),
            digest: String::new(),
            running: true,
            scanned: true,
            counts: SeverityCounts::default(),
            fixable: SeverityCounts::default(),
            ignored: SeverityCounts::default(),
            kev: 0,
            workloads: workloads
                .iter()
                .map(|(ns, kind, name)| Workload {
                    kind: kind.to_string(),
                    namespace: ns.to_string(),
                    name: name.to_string(),
                    container: "c".into(),
                })
                .collect(),
            report_namespace: String::new(),
            report_name: String::new(),
            reports: 0,
            scanner: String::new(),
            scanned_at: 0,
        }
    }

    fn rule(scope: IgnoreScope) -> IgnoreRule {
        IgnoreRule {
            id: "CVE-2026-1001".into(),
            scope,
            reason: "not reachable".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_trivyignore_with_reasons_and_expiry() {
        let f = parse_trivyignore(
            "# Accept the risk\n# for now\nCVE-2026-1001\n\nCVE-2026-1002 exp:2026-01-01\n\
             GHSA-abcd-efgh-ijkl # vendored, unused\n# orphan comment\n\nnot an id!\n\
             CVE-2026-1003 exp:someday\n",
            ".trivyignore",
        );
        let ids: Vec<_> = f.rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            ["CVE-2026-1001", "CVE-2026-1002", "GHSA-abcd-efgh-ijkl"]
        );
        assert_eq!(f.rules[0].reason, "Accept the risk for now");
        assert_eq!(f.rules[1].reason, "Listed in .trivyignore");
        assert_eq!(f.rules[1].expires, 1767225600);
        assert_eq!(f.rules[2].reason, "vendored, unused");
        assert!(f
            .rules
            .iter()
            .all(|r| r.from_file && r.scope == IgnoreScope::Everywhere));
        assert_eq!(f.skipped, [9, 10]);
    }

    #[test]
    fn every_ignore_needs_a_reason_and_a_target() {
        let mut r = rule(IgnoreScope::Image);
        r.image = "nginx:1.27".into();
        assert!(r.clone().checked().is_ok());
        r.reason = "  ".into();
        assert!(r.clone().checked().unwrap_err().contains("needs a reason"));
        let mut w = rule(IgnoreScope::Workload);
        w.namespace = "shop".into();
        assert!(w
            .clone()
            .checked()
            .unwrap_err()
            .contains("needs a workload"));
        let mut bad = rule(IgnoreScope::Everywhere);
        bad.id = "CVE 1; rm".into();
        assert!(bad.checked().is_err());
        // A later ignore of the same target replaces the earlier one.
        let mut a = rule(IgnoreScope::Namespace);
        a.namespace = "shop".into();
        let mut b = a.clone();
        b.reason = "newer".into();
        let mut img = rule(IgnoreScope::Image);
        img.image = "nginx".into();
        let kept = normalized(vec![a, img, b, r]);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[1].reason, "newer");
    }

    #[test]
    fn scopes_and_expiry() {
        let web = row("nginx:1.27", &[("shop", "Deployment", "web")]);
        let both = row(
            "docker.io/library/nginx:1.28",
            &[
                ("shop", "Deployment", "web"),
                ("blog", "Deployment", "site"),
            ],
        );
        let mut img = rule(IgnoreScope::Image);
        img.image = "nginx:1.26".into();
        assert!(img.covers(&web, "kind"));
        assert!(img.covers(&both, "kind"), "any tag of the repository");
        assert!(!img.covers(&row("redis:7", &[]), "kind"));

        let mut ns = rule(IgnoreScope::Namespace);
        ns.namespace = "shop".into();
        ns.context = "kind".into();
        assert!(ns.covers(&web, "kind"));
        assert!(!ns.covers(&web, "prod"), "another cluster");
        assert!(!ns.covers(&both, "kind"), "also used in blog");

        let mut wl = rule(IgnoreScope::Workload);
        (wl.namespace, wl.kind, wl.name) = ("shop".into(), "Deployment".into(), "web".into());
        assert!(wl.covers(&web, "any"));
        assert!(!wl.covers(&both, "any"));

        wl.expires = 100;
        assert!(wl.active(99));
        assert!(!wl.active(100), "an expired ignore no longer applies");
        assert!(rule(IgnoreScope::Everywhere).active(i64::MAX));
    }

    #[test]
    fn repositories() {
        assert_eq!(repository_of("nginx:1.27"), "docker.io/library/nginx");
        assert_eq!(repository_of("ghcr.io/a/b@sha256:1111"), "ghcr.io/a/b");
        assert_eq!(
            repository_of("registry.local:5000/app:v1"),
            "registry.local:5000/app"
        );
    }
}
