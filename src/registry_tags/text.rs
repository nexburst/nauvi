//! `nauvi tags` as text.

use super::{shown_registry, TagGroup, TagReport, TagState};
use std::fmt::Write as _;

/// The digest shortened for reading (`sha256:1a2b3c4d5e6f`).
pub fn short_digest(d: &str) -> String {
    match d.strip_prefix("sha256:") {
        Some(h) => format!("sha256:{}", &h[..h.len().min(12)]),
        None => d.to_string(),
    }
}

/// What the running tag's state says, as a sentence (`""` for unknown).
pub fn state_text(r: &TagReport) -> String {
    match r.state {
        TagState::Updated => format!(
            "This tag was updated in the registry: {} now points to {}, the container runs {}.",
            r.tag,
            short_digest(&r.registry_digest),
            short_digest(&r.running_digest)
        ),
        TagState::Unchanged => format!("{} still points to what the container runs.", r.tag),
        TagState::Gone => format!("The registry no longer has the tag {}.", r.tag),
        TagState::Unknown => String::new(),
    }
}

/// The report as `nauvi tags` prints it.
pub fn report_text(r: &TagReport) -> String {
    let mut out = String::new();
    let name = if r.tag.is_empty() {
        r.image.clone()
    } else {
        format!(
            "{}:{}",
            r.image
                .rsplit_once(':')
                .map_or(r.image.as_str(), |(n, _)| n),
            r.tag
        )
    };
    let _ = writeln!(
        out,
        "{name} on {}: {} tags{}",
        shown_registry(&r.registry),
        r.tag_count,
        if r.truncated {
            " read (the list is longer)"
        } else {
            ""
        }
    );
    let state = state_text(r);
    if !state.is_empty() {
        let _ = writeln!(out, "{state}");
    }
    if r.version.is_empty() {
        let _ = writeln!(
            out,
            "The tag {} is not a version, so there is nothing to compare it with.",
            if r.tag.is_empty() { "(none)" } else { &r.tag }
        );
    } else if r.patch.tags.is_empty() && r.minor.tags.is_empty() && r.major.tags.is_empty() {
        let _ = writeln!(out, "No newer versions{}.", variant_text(r));
    }
    let groups = [
        ("Newer patch (safe to update)", &r.patch),
        ("Newer minor", &r.minor),
        ("Newer major (may break things)", &r.major),
        ("Not versions", &r.other),
    ];
    for (title, g) in groups {
        write_group(&mut out, title, g);
    }
    out
}

fn variant_text(r: &TagReport) -> String {
    if r.variant.is_empty() {
        String::new()
    } else {
        format!(" with the variant {}", r.variant)
    }
}

fn write_group(out: &mut String, title: &str, g: &TagGroup) {
    if g.tags.is_empty() {
        return;
    }
    let _ = writeln!(out, "\n{title}:");
    let width = g.tags.iter().map(|t| t.tag.len()).max().unwrap_or(0);
    for t in &g.tags {
        let date = t.updated.get(..10).unwrap_or("");
        let _ = writeln!(out, "  {:width$}  {date}", t.tag).map(|_| ());
    }
    if g.more > 0 {
        let _ = writeln!(out, "  … and {} more", g.more);
    }
    // Trailing spaces of rows without a date.
    let trimmed: String = out
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    *out = trimmed;
}

#[cfg(test)]
mod tests {
    use super::super::{TagInfo, TagReport};
    use super::*;

    fn info(t: &str, d: &str) -> TagInfo {
        TagInfo {
            tag: t.into(),
            updated: d.into(),
        }
    }

    #[test]
    fn prints_groups_dates_and_a_repushed_tag() {
        let r = TagReport {
            image: "mongo:7.0.1-jammy".into(),
            registry: "docker.io".into(),
            repository: "library/mongo".into(),
            tag: "7.0.1-jammy".into(),
            version: "7.0.1".into(),
            variant: "-jammy".into(),
            patch: TagGroup {
                tags: vec![info("7.0.2-jammy", "2026-10-01T10:00:00Z")],
                more: 0,
            },
            major: TagGroup {
                tags: vec![info("8.0.0-jammy", "")],
                more: 3,
            },
            tag_count: 9,
            state: TagState::Updated,
            registry_digest: format!("sha256:{}", "a".repeat(64)),
            running_digest: format!("sha256:{}", "b".repeat(64)),
            ..Default::default()
        };
        let text = report_text(&r);
        assert!(
            text.starts_with("mongo:7.0.1-jammy on Docker Hub: 9 tags\n"),
            "{text}"
        );
        assert!(text.contains("This tag was updated in the registry: 7.0.1-jammy now points to sha256:aaaaaaaaaaaa, the container runs sha256:bbbbbbbbbbbb."));
        assert!(
            text.contains("Newer patch (safe to update):\n  7.0.2-jammy  2026-10-01\n"),
            "{text}"
        );
        assert!(
            text.contains("Newer major (may break things):\n  8.0.0-jammy\n  … and 3 more\n"),
            "{text}"
        );
        assert!(!text.contains("Newer minor"));
        assert!(!text.lines().any(|l| l.ends_with(' ')));
    }

    #[test]
    fn says_when_there_is_nothing_to_compare() {
        let r = TagReport {
            image: "nginx".into(),
            registry: "docker.io".into(),
            tag: "latest".into(),
            ..Default::default()
        };
        assert!(report_text(&r).contains("The tag latest is not a version"));
        let r = TagReport {
            tag: "1.0-alpine".into(),
            version: "1.0".into(),
            variant: "-alpine".into(),
            ..Default::default()
        };
        assert!(report_text(&r).contains("No newer versions with the variant -alpine."));
    }
}
