//! Creation times and the short ages ("5m", "7d20h") shown next to objects.

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

/// The age of `t`, as `kubectl get` prints it.
pub(crate) fn format_age(t: Timestamp) -> String {
    let ms = Timestamp::now().duration_since(t).as_millis();
    human_duration(i64::try_from(ms).unwrap_or(i64::MAX))
}

/// kubectl's `HumanDuration` (k8s.io/apimachinery/pkg/util/duration) for a
/// duration in milliseconds: two units while the second one still matters
/// (`3m10s`, `3h12m`, `7d20h`, `2y30d`), one unit otherwise. The UI's
/// `formatAge` (`desktop/ui-src/src/lib/format.ts`) is the same function.
///
/// One difference: kubectl prints `<invalid>` for a time more than a second
/// in the future; nauvi prints `0s`, since that is clock skew between this
/// machine and the API server, not a broken object.
pub(crate) fn human_duration(ms: i64) -> String {
    // Truncate towards zero, like Go's int(d.Seconds()).
    let seconds = ms / 1000;
    if seconds < 0 {
        return "0s".into();
    }
    if seconds < 60 * 2 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 10 {
        let s = seconds % 60;
        return if s == 0 {
            format!("{minutes}m")
        } else {
            format!("{minutes}m{s}s")
        };
    }
    if minutes < 60 * 3 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 8 {
        let m = minutes % 60;
        return if m == 0 {
            format!("{hours}h")
        } else {
            format!("{hours}h{m}m")
        };
    }
    if hours < 48 {
        return format!("{hours}h");
    }
    let days = hours / 24;
    if hours < 24 * 8 {
        let h = hours % 24;
        return if h == 0 {
            format!("{days}d")
        } else {
            format!("{days}d{h}h")
        };
    }
    if hours < 24 * 365 * 2 {
        return format!("{days}d");
    }
    let years = days / 365;
    if hours < 24 * 365 * 8 {
        let d = days % 365;
        return if d == 0 {
            format!("{years}y")
        } else {
            format!("{years}y{d}d")
        };
    }
    format!("{years}y")
}

pub(crate) fn created_secs(ts: &Option<Time>) -> i64 {
    ts.as_ref().map(|t| t.0.as_second()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: i64 = 1;
    const SEC: i64 = 1000;
    const MIN: i64 = 60 * SEC;
    const HOUR: i64 = 60 * MIN;
    const DAY: i64 = 24 * HOUR;
    const YEAR: i64 = 365 * DAY;

    /// kubectl's TestHumanDuration and TestHumanDurationBoundaries
    /// (k8s.io/apimachinery/pkg/util/duration/duration_test.go), row for row.
    /// The UI's format.test.ts has the same table.
    const KUBECTL_TABLE: &[(i64, &str)] = &[
        (SEC, "1s"),
        (70 * SEC, "70s"),
        (190 * SEC, "3m10s"),
        (70 * MIN, "70m"),
        (47 * HOUR, "47h"),
        (49 * HOUR, "2d1h"),
        ((8 * 24 + 2) * HOUR, "8d"),
        (367 * DAY, "367d"),
        (2 * YEAR + 25 * HOUR, "2y1d"),
        (8 * YEAR + 2 * HOUR, "8y"),
        // Boundaries.
        (-2 * SEC + MS, "0s"),
        (0, "0s"),
        (SEC - MS, "0s"),
        (2 * MIN - MS, "119s"),
        (2 * MIN, "2m"),
        (2 * MIN + SEC, "2m1s"),
        (10 * MIN - MS, "9m59s"),
        (10 * MIN, "10m"),
        (3 * HOUR - MS, "179m"),
        (3 * HOUR, "3h"),
        (3 * HOUR + MIN, "3h1m"),
        (8 * HOUR - MS, "7h59m"),
        (8 * HOUR, "8h"),
        (48 * HOUR - MS, "47h"),
        (48 * HOUR, "2d"),
        (48 * HOUR + HOUR, "2d1h"),
        (8 * DAY - MS, "7d23h"),
        (8 * DAY, "8d"),
        (2 * YEAR - MS, "729d"),
        (2 * YEAR, "2y"),
        (2 * YEAR + 23 * HOUR, "2y"),
        (2 * YEAR + 23 * HOUR + 59 * MIN, "2y"),
        (2 * YEAR + DAY - MS, "2y"),
        (2 * YEAR + DAY, "2y1d"),
        (3 * YEAR, "3y"),
        (4 * YEAR, "4y"),
        (5 * YEAR, "5y"),
        (6 * YEAR, "6y"),
        (7 * YEAR, "7y"),
        (8 * YEAR - MS, "7y364d"),
        (8 * YEAR, "8y"),
        (8 * YEAR + 364 * DAY, "8y"),
        (9 * YEAR, "9y"),
    ];

    #[test]
    fn matches_kubectl_human_duration() {
        for &(ms, want) in KUBECTL_TABLE {
            assert_eq!(human_duration(ms), want, "{ms} ms");
        }
        // The examples of #380.
        assert_eq!(human_duration(7 * DAY + 20 * HOUR + 5 * MIN), "7d20h");
        assert_eq!(human_duration(3 * HOUR + 12 * MIN + 40 * SEC), "3h12m");
        assert_eq!(human_duration(2 * YEAR + 30 * DAY), "2y30d");
    }

    #[test]
    fn clock_skew_is_zero_not_invalid() {
        // kubectl: "<invalid>". See human_duration.
        assert_eq!(human_duration(-2 * SEC), "0s");
        assert_eq!(human_duration(-100 * SEC), "0s");
    }

    #[test]
    fn age_formatting() {
        let ago = |s: i64| format_age(Timestamp::now() - jiff::SignedDuration::from_secs(s));
        assert_eq!(ago(5), "5s");
        assert_eq!(ago(190), "3m10s");
        assert_eq!(ago(7_300), "121m");
        assert_eq!(ago(3 * 3600 + 12 * 60 + 40), "3h12m");
        assert_eq!(ago(3 * 86_400 + 10), "3d");
        assert_eq!(ago(7 * 86_400 + 20 * 3600 + 30), "7d20h");
        assert_eq!(ago(-100), "0s");
        assert_eq!(age_of(None), "");
    }
}
