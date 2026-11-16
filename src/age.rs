//! Creation times and the short ages ("5m", "3d") shown next to objects.

use jiff::Timestamp;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

/// Age text for a creation time in unix seconds (empty if unknown).
pub(crate) fn age_of_secs(secs: i64) -> String {
    Timestamp::from_second(secs)
        .ok()
        .filter(|_| secs > 0)
        .map(format_age)
        .unwrap_or_default()
}

pub(crate) fn age_of(ts: Option<Time>) -> String {
    ts.map(|t| format_age(t.0)).unwrap_or_default()
}

pub(crate) fn format_age(t: Timestamp) -> String {
    let secs = Timestamp::now().duration_since(t).as_secs().max(0);
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

pub(crate) fn created_secs(ts: &Option<Time>) -> i64 {
    ts.as_ref().map(|t| t.0.as_second()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn age_formatting() {
        let ago = |s: i64| format_age(Timestamp::now() - jiff::SignedDuration::from_secs(s));
        assert_eq!(ago(5), "5s");
        assert_eq!(ago(120), "2m");
        assert_eq!(ago(7_300), "2h");
        assert_eq!(ago(3 * 86_400 + 10), "3d");
        // Timestamps in the future clamp to zero.
        assert_eq!(ago(-100), "0s");
        assert_eq!(age_of(None), "");
    }
}
