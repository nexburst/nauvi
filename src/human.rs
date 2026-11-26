//! Values in the words a person reads: "8d 14h" rather than "12382m".
//!
//! The UI has the same formatter (`formatDuration` in
//! `desktop/ui-src/src/lib/format.ts`); a test on each side pins the same
//! examples, so the overview, the tables and the CLI agree. Ages in tables
//! keep kubectl's form (`crate::age`), since `nauvi get` prints them as
//! `kubectl get` does.

const MINUTE: i64 = 60;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
const YEAR: i64 = 365 * DAY;

/// A duration in seconds, in its two largest units: "45s", "3m 5s",
/// "3h 5m", "8d 14h", "1y 20d". The second unit is left out when it is
/// zero ("2h"). Never minutes over an hour. Negative durations (clock skew)
/// read "0s".
pub fn duration(secs: i64) -> String {
    let secs = secs.max(0);
    let units = [
        (YEAR, "y"),
        (DAY, "d"),
        (HOUR, "h"),
        (MINUTE, "m"),
        (1, "s"),
    ];
    let Some(i) = units.iter().position(|(size, _)| secs >= *size) else {
        return "0s".to_string();
    };
    let (size, unit) = units[i];
    let first = format!("{}{unit}", secs / size);
    match units.get(i + 1) {
        Some((next, next_unit)) if (secs % size) / next > 0 => {
            format!("{first} {}{next_unit}", (secs % size) / next)
        }
        _ => first,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_use_two_units_and_never_minutes_over_an_hour() {
        let cases = [
            (-5, "0s"),
            (0, "0s"),
            (45, "45s"),
            (60, "1m"),
            (185, "3m 5s"),
            (3600, "1h"),
            (3 * HOUR + 5 * MINUTE + 59, "3h 5m"),
            (12_382 * MINUTE, "8d 14h"),
            (2 * DAY, "2d"),
            (YEAR + 20 * DAY + 3 * HOUR, "1y 20d"),
        ];
        for (secs, want) in cases {
            assert_eq!(duration(secs), want, "{secs}s");
        }
    }
}
