//! Output caps: every tool result is bounded in lines and bytes, so a model
//! cannot pull a whole cluster (or a whole log) into its context with one
//! call.

/// Most bytes of one tool result.
pub const MAX_BYTES: usize = 64 * 1024;
/// Most lines of one tool result.
pub const MAX_LINES: usize = 1000;
/// Log lines per call when the caller gives no `tail`.
pub const DEFAULT_TAIL: i64 = 100;
/// Most log lines a caller can ask for per pod.
pub const MAX_TAIL: i64 = 1000;
/// Most pods whose logs one `logs` call on a workload reads.
pub const MAX_LOG_PODS: usize = 10;
/// Objects per `list` call when the caller gives no `limit`.
pub const DEFAULT_LIST: u32 = 100;
/// Most objects one `list` call returns.
pub const MAX_LIST: u32 = 500;
/// Events per `events` call when the caller gives no `limit`.
pub const DEFAULT_EVENTS: usize = 50;
/// Most events one `events` call returns.
pub const MAX_EVENTS: usize = 200;
/// Most events one `events` call reads from the API server (it shows the
/// newest of them).
pub const MAX_EVENTS_READ: usize = 2000;
/// Most characters of one event message.
pub const MAX_EVENT_MESSAGE: usize = 500;
/// Largest manifest `apply` accepts.
pub const MAX_MANIFEST_BYTES: usize = 512 * 1024;

/// `requested` (or `default`) clamped to `1..=max`.
pub fn clamp<T: Ord + Copy + From<u8>>(requested: Option<T>, default: T, max: T) -> T {
    requested.unwrap_or(default).clamp(T::from(1), max)
}

/// `text` cut to at most `max_lines` lines and `max_bytes` bytes (at a
/// line, or a character, boundary), with a note that says so.
pub fn cap_text(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let total_lines = text.lines().count();
    if total_lines <= max_lines && text.len() <= max_bytes {
        return text.to_string();
    }
    let mut out = String::new();
    let mut kept = 0;
    for line in text.lines() {
        if kept == max_lines || out.len() + line.len() + 1 > max_bytes {
            break;
        }
        out.push_str(line);
        out.push('\n');
        kept += 1;
    }
    if kept == 0 && total_lines > 0 {
        // One line longer than the whole budget: keep its start.
        let mut end = max_bytes.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&text[..end]);
        out.push('\n');
        return out + "[truncated: the first line is longer than the output limit]\n";
    }
    out.push_str(&format!(
        "[truncated: showing {kept} of {total_lines} lines; the limit is {max_lines} lines and {} KiB per call]\n",
        max_bytes / 1024
    ));
    out
}

/// At most `max` characters of `s`, with `…` when cut.
pub fn shorten(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Cluster text (an event or status message, a reason) on one line,
/// shortened to `max` characters: whitespace runs become one space, and
/// C0/C1 control characters (ESC sequences start with one), bidi controls
/// and zero-width characters are dropped, so cluster text cannot reorder,
/// restyle or hide what the reader sees.
pub fn one_line(s: &str, max: usize) -> String {
    let visible: String = s
        .chars()
        .filter(|&c| c.is_whitespace() || !(c.is_control() || is_invisible_format(c)))
        .collect();
    shorten(
        &visible.split_whitespace().collect::<Vec<_>>().join(" "),
        max,
    )
}

/// Unicode bidi marks, embeddings, overrides and isolates, and the
/// zero-width space, joiners, word joiner and byte order mark.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_unchanged() {
        assert_eq!(cap_text("a\nb\n", 10, 100), "a\nb\n");
        assert_eq!(cap_text("a\nb", 10, 100), "a\nb");
        assert_eq!(cap_text("", 10, 100), "");
    }

    #[test]
    fn caps_lines() {
        let text: String = (0..20).map(|i| format!("line {i}\n")).collect();
        let out = cap_text(&text, 5, 10_000);
        assert!(out.starts_with("line 0\nline 1\n"), "{out}");
        assert!(!out.contains("line 5"), "{out}");
        assert!(out.contains("showing 5 of 20 lines"), "{out}");
    }

    #[test]
    fn caps_bytes_at_a_line_boundary() {
        let text = "x".repeat(60) + "\n" + &"y".repeat(60) + "\n";
        let out = cap_text(&text, 100, 100);
        assert!(out.starts_with(&("x".repeat(60) + "\n[truncated")), "{out}");
        assert!(!out.contains('y'));
    }

    #[test]
    fn a_single_huge_line_is_cut_at_a_char_boundary() {
        let text = "é".repeat(100);
        let out = cap_text(&text, 10, 51);
        assert!(out.starts_with(&"é".repeat(25)), "{out}");
        assert!(out.contains("[truncated: the first line"));
        assert!(out.len() < 51 + 80);
    }

    #[test]
    fn clamp_bounds_requests() {
        assert_eq!(clamp(None, 100i64, 1000), 100);
        assert_eq!(clamp(Some(5000i64), 100, 1000), 1000);
        assert_eq!(clamp(Some(-3i64), 100, 1000), 1);
        assert_eq!(clamp(Some(0u32), 100, 500), 1);
    }

    #[test]
    fn shorten_adds_an_ellipsis() {
        assert_eq!(shorten("abcdef", 3), "abc…");
        assert_eq!(shorten("abc", 3), "abc");
    }

    #[test]
    fn one_line_drops_zero_width_characters() {
        assert_eq!(
            one_line("rm\u{200B} -rf\u{200C}\u{200D} /\u{2060}x\u{FEFF}", 100),
            "rm -rf /x"
        );
        assert_eq!(one_line("a\nb\u{1b}[0m", 100), "a b[0m");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }
}
