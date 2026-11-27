//! Tags as versions, and the newer ones grouped against the running tag.
//!
//! A version tag is an optional `v`, one to four dot-separated numbers,
//! then a variant: whatever follows (`-jammy`, `-alpine3.20`, `rc1`). Only
//! tags with the same `v`, the same count of numbers and the same variant
//! as the running tag are compared, so `7.0.1-jammy` is offered
//! `7.0.2-jammy`, never `7.0.2-alpine`, `7.1` or `7.0.2-rc0-jammy`.

use std::cmp::Ordering;

/// A tag read as a version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// `v`, `V` or `""`.
    pub prefix: String,
    /// The numbers, 1 to 4 of them.
    pub numbers: Vec<u64>,
    /// What follows the numbers (`-jammy`), or `""`.
    pub variant: String,
}

impl Version {
    /// `tag` as a version, or `None` if it does not start with one.
    pub fn parse(tag: &str) -> Option<Self> {
        let (prefix, rest) = match tag.as_bytes().first() {
            Some(b'v' | b'V') => tag.split_at(1),
            _ => ("", tag),
        };
        let mut numbers = Vec::new();
        let mut i = 0;
        let b = rest.as_bytes();
        loop {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == start || i - start > 18 {
                return None;
            }
            numbers.push(rest[start..i].parse().ok()?);
            if numbers.len() < 4 && i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
                i += 1;
            } else {
                break;
            }
        }
        let variant = &rest[i..];
        // `1.2.3.4.5` or `1.2.`: not a version this reads.
        if variant.starts_with('.') {
            return None;
        }
        Some(Self {
            prefix: prefix.to_string(),
            numbers,
            variant: variant.to_string(),
        })
    }

    /// Same `v`, count of numbers and variant: the two can be compared.
    fn same_shape(&self, other: &Self) -> bool {
        self.prefix == other.prefix
            && self.numbers.len() == other.numbers.len()
            && self.variant == other.variant
    }

    /// The numbers without the prefix and variant (`7.0.1`).
    pub fn number_text(&self) -> String {
        let n: Vec<String> = self.numbers.iter().map(u64::to_string).collect();
        n.join(".")
    }
}

/// How far a newer tag is from the running one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Same major and minor: a patch.
    Patch,
    /// Same major.
    Minor,
    Major,
}

/// The tags newer than `current`, by step, each newest first; and the tags
/// that are not versions, sorted (`latest` first).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grouped {
    pub patch: Vec<String>,
    pub minor: Vec<String>,
    pub major: Vec<String>,
    pub other: Vec<String>,
}

/// Group `tags` against the running tag `current` (which need not be a
/// version: then only `other` is filled).
pub fn group<'a>(current: &str, tags: impl IntoIterator<Item = &'a str>) -> Grouped {
    let now = Version::parse(current);
    let mut newer: Vec<(Version, Step, &str)> = Vec::new();
    let mut other: Vec<&str> = Vec::new();
    for tag in tags {
        let Some(v) = Version::parse(tag) else {
            other.push(tag);
            continue;
        };
        let Some(now) = now.as_ref().filter(|n| n.same_shape(&v)) else {
            continue;
        };
        if v.numbers.cmp(&now.numbers) != Ordering::Greater {
            continue;
        }
        let first_diff = v
            .numbers
            .iter()
            .zip(&now.numbers)
            .position(|(a, b)| a != b)
            .unwrap_or(0);
        let step = match first_diff {
            0 => Step::Major,
            1 => Step::Minor,
            _ => Step::Patch,
        };
        newer.push((v, step, tag));
    }
    // Newest first; the same numbers written twice (`07` and `7`) keep
    // their order.
    newer.sort_by(|a, b| b.0.numbers.cmp(&a.0.numbers));
    let mut g = Grouped::default();
    for (_, step, tag) in newer {
        let list = match step {
            Step::Patch => &mut g.patch,
            Step::Minor => &mut g.minor,
            Step::Major => &mut g.major,
        };
        list.push(tag.to_string());
    }
    other.sort_by(|a, b| (*b == "latest").cmp(&(*a == "latest")).then(a.cmp(b)));
    other.dedup();
    g.other = other.into_iter().map(str::to_string).collect();
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Option<(String, Vec<u64>, String)> {
        Version::parse(s).map(|v| (v.prefix, v.numbers, v.variant))
    }

    #[test]
    fn reads_versions_with_prefixes_and_variants() {
        assert_eq!(v("7.0.1"), Some(("".into(), vec![7, 0, 1], "".into())));
        assert_eq!(v("v1.25.3"), Some(("v".into(), vec![1, 25, 3], "".into())));
        assert_eq!(
            v("7.0.1-jammy"),
            Some(("".into(), vec![7, 0, 1], "-jammy".into()))
        );
        assert_eq!(
            v("1.25-alpine3.20"),
            Some(("".into(), vec![1, 25], "-alpine3.20".into()))
        );
        assert_eq!(
            v("3.13.0rc1"),
            Some(("".into(), vec![3, 13, 0], "rc1".into()))
        );
        assert_eq!(v("8"), Some(("".into(), vec![8], "".into())));
        assert_eq!(v("1.2.3.4"), Some(("".into(), vec![1, 2, 3, 4], "".into())));
        for not in [
            "latest",
            "jammy",
            "sha-1a2b3c",
            "v",
            "vx1",
            "1.2.3.4.5",
            "1.",
            "",
            "1234567890123456789",
        ] {
            assert_eq!(v(not), None, "{not}");
        }
    }

    fn g(current: &str, tags: &[&str]) -> Grouped {
        group(current, tags.iter().copied())
    }

    #[test]
    fn groups_newer_patch_minor_and_major() {
        let tags = [
            "7.0.0", "7.0.1", "7.0.2", "7.0.10", "7.1.0", "7.2.3", "8.0.0", "6.9.9", "latest",
            "7.0", "7",
        ];
        let r = g("7.0.1", &tags);
        assert_eq!(r.patch, ["7.0.10", "7.0.2"]);
        assert_eq!(r.minor, ["7.2.3", "7.1.0"]);
        assert_eq!(r.major, ["8.0.0"]);
        assert_eq!(r.other, ["latest"]);
    }

    #[test]
    fn keeps_the_variant_and_the_prefix() {
        let tags = [
            "7.0.2-jammy",
            "7.0.2-alpine",
            "7.0.2",
            "7.0.3-rc0-jammy",
            "8.0.0-jammy",
            "v7.0.5-jammy",
            "7.0.2-Jammy",
        ];
        let r = g("7.0.1-jammy", &tags);
        assert_eq!(r.patch, ["7.0.2-jammy"]);
        assert_eq!(r.major, ["8.0.0-jammy"]);
        assert!(r.minor.is_empty());
        let r = g("v1.2.3", &["v1.2.4", "1.2.5", "v2.0.0", "V1.3.0"]);
        assert_eq!(r.patch, ["v1.2.4"]);
        assert_eq!(r.major, ["v2.0.0"]);
        assert!(r.minor.is_empty());
    }

    #[test]
    fn floating_tags_compare_at_their_own_precision() {
        let r = g(
            "1.36",
            &["1.36", "1.36.1", "1.37", "1.38", "2.0", "1.37-musl", "musl"],
        );
        assert!(r.patch.is_empty());
        assert_eq!(r.minor, ["1.38", "1.37"]);
        assert_eq!(r.major, ["2.0"]);
        assert_eq!(r.other, ["musl"]);
        let r = g("8", &["9", "10", "8.1"]);
        assert_eq!(r.major, ["10", "9"]);
        let r = g("1.2.3.4", &["1.2.3.5", "1.2.4.0"]);
        assert_eq!(r.patch, ["1.2.4.0", "1.2.3.5"]);
    }

    #[test]
    fn a_tag_that_is_not_a_version_only_lists_the_others() {
        let r = g("latest", &["1.0", "stable", "latest", "edge", "2.0"]);
        assert!(r.patch.is_empty() && r.minor.is_empty() && r.major.is_empty());
        assert_eq!(r.other, ["latest", "edge", "stable"]);
    }
}
