//! Cluster text made safe to show: event and status messages, reasons and
//! other strings a cluster (or whoever can write to it) controls are
//! printed by the CLI and passed to an AI assistant by `nauvi mcp`.
//!
//! C0/C1 control characters (ESC sequences start with one), bidi controls
//! and zero-width characters are dropped, so such text cannot reorder,
//! restyle or hide what the reader sees.

/// `s` on one line: control, bidi and zero-width characters dropped,
/// whitespace runs (line breaks included) turned into one space.
pub fn single_line(s: &str) -> String {
    visible(s).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `s` with its lines kept: every line break (`\r\n`, `\r`, U+0085,
/// U+2028, U+2029) becomes `\n`, tabs become a space, and the other
/// control, bidi and zero-width characters are dropped.
pub fn multi_line(s: &str) -> String {
    s.replace("\r\n", "\n")
        .split(['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}'])
        .map(|line| visible(&line.replace('\t', " ")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// At most `max` characters of `s`, with `…` when cut.
pub fn shorten(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Cluster text (an event or status message, a reason) on one line
/// ([`single_line`]: no control, bidi or zero-width
/// characters), shortened to `max` characters.
pub fn one_line(s: &str, max: usize) -> String {
    shorten(&single_line(s), max)
}

/// `s` without control characters (whitespace kept), bidi controls and
/// zero-width characters.
fn visible(s: &str) -> String {
    s.chars()
        .filter(|&c| c.is_whitespace() || !(c.is_control() || is_invisible_format(c)))
        .collect()
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
    fn shorten_adds_an_ellipsis() {
        assert_eq!(shorten("abcdef", 3), "abc…");
        assert_eq!(shorten("abc", 3), "abc");
    }

    #[test]
    fn single_line_drops_controls_and_joins_lines() {
        assert_eq!(
            single_line("  a\u{1b}[31m\u{202E}b\u{200B}\r\n\tc\u{FEFF}\u{2060} "),
            "a[31mb c"
        );
        assert_eq!(single_line("café 日本"), "café 日本");
    }

    #[test]
    fn multi_line_keeps_line_breaks_only() {
        assert_eq!(
            multi_line("one\u{1b}[2J\r\ntwo\u{2066}\u{200D}\rthree\u{85}four\tfive\u{7}"),
            "one[2J\ntwo\nthree\nfour five"
        );
    }
}
