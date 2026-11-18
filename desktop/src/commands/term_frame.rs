//! What a terminal session sends to its tab (#115): one Tauri channel per
//! session (exec, attach, debug and node shells, local shells), so output
//! arrives in order and only at the tab that started it. Output, notes and
//! errors go as raw bytes (an `ArrayBuffer` in the UI, written into xterm as
//! is), the end of the session as JSON.

use serde::Serialize;
use specta::datatype::DataType;
use specta::{Type, Types};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};

/// A message about a terminal session, other than its output.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TermEvent {
    /// The shell exited, or the session was closed or detached.
    Closed,
    /// After Ctrl-C: the output still waiting was dropped; output sent
    /// before this message is stale and the tab drops it too.
    Cleared,
}

/// One message on a terminal channel: bytes for the screen (UTF-8, cut at
/// character boundaries, see [`Utf8Cut`]), or a [`TermEvent`] as JSON.
#[derive(Debug)]
pub(crate) enum TermFrame {
    Data(Vec<u8>),
    Event(TermEvent),
}

impl IpcResponse for TermFrame {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        match self {
            TermFrame::Data(bytes) => Ok(InvokeResponseBody::Raw(bytes)),
            TermFrame::Event(e) => e.body(),
        }
    }
}

/// The raw bytes as the UI receives them (never serialized: only typed).
#[derive(Serialize)]
struct RawBytes;

impl Type for RawBytes {
    fn definition(_: &mut Types) -> DataType {
        specta_typescript::define("ArrayBuffer").into()
    }
}

/// A message on a terminal channel as the UI sees it: output
/// (`ArrayBuffer`) or a `TermEvent`. Only for `bindings.ts`; the backend
/// sends a `TermFrame`.
#[derive(Serialize, Type)]
#[serde(untagged)]
#[allow(dead_code)]
enum TermMessage {
    Data(RawBytes),
    Event(TermEvent),
}

impl Type for TermFrame {
    fn definition(types: &mut Types) -> DataType {
        TermMessage::definition(types)
    }
}

/// The channel of one terminal session.
pub(crate) type TermChannel = Channel<TermFrame>;

/// Cuts a byte stream at UTF-8 character boundaries: a character split
/// between two reads goes out whole with the second, so notes written
/// between two reads never land inside one. Invalid bytes pass through
/// (xterm shows them as U+FFFD).
#[derive(Default)]
pub(crate) struct Utf8Cut {
    pending: Vec<u8>,
}

impl Utf8Cut {
    /// The bytes of `chunk` (after what was held back) up to the last
    /// complete character; an incomplete one at the end is held back.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut out = std::mem::take(&mut self.pending);
        out.extend_from_slice(chunk);
        let keep = incomplete_tail(&out);
        self.pending = out.split_off(out.len() - keep);
        out
    }
}

/// How many bytes at the end of `b` start a character that is not complete
/// yet (0 to 3).
fn incomplete_tail(b: &[u8]) -> usize {
    // A lead byte is at most 3 bytes before the end of an incomplete one.
    for back in 1..=b.len().min(3) {
        let byte = b[b.len() - back];
        if byte & 0xC0 == 0x80 {
            continue; // a continuation byte: look further back
        }
        let need = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return 0, // ASCII or invalid: nothing to wait for
        };
        return if need > back { back } else { 0 };
    }
    0
}

/// Where a terminal's escape-sequence parser is, roughly: enough to tell
/// whether output cut at some point starts inside a sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Vt {
    #[default]
    Ground,
    /// After ESC (and any intermediate bytes).
    Esc,
    /// In a CSI sequence: ends at a final byte 0x40-0x7E.
    Csi,
    /// In a string (OSC, DCS, APC, PM, SOS): ends at BEL or ESC \.
    Str,
    /// ESC inside a string.
    StrEsc,
}

const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
const ESC: u8 = 0x1b;

impl Vt {
    /// The state after `b`.
    pub(crate) fn advance(self, b: &[u8]) -> Vt {
        b.iter().fold(self, |s, &c| s.step(c))
    }

    fn step(self, c: u8) -> Vt {
        match (self, c) {
            (_, CAN | SUB) => Vt::Ground,
            (Vt::Str, 0x07) => Vt::Ground,
            (Vt::Str, ESC) => Vt::StrEsc,
            (Vt::Str, _) => Vt::Str,
            (Vt::StrEsc, b'\\') => Vt::Ground,
            (Vt::StrEsc, c) => Vt::Esc.step(c),
            (_, ESC) => Vt::Esc,
            (Vt::Ground, _) => Vt::Ground,
            (Vt::Esc, b'[') => Vt::Csi,
            (Vt::Esc, b']' | b'P' | b'_' | b'^' | b'X') => Vt::Str,
            (Vt::Esc, 0x20..=0x2f) => Vt::Esc,
            (Vt::Esc, _) => Vt::Ground,
            (Vt::Csi, 0x40..=0x7e) => Vt::Ground,
            (Vt::Csi, _) => Vt::Csi,
        }
    }
}

/// How many leading bytes of `b` to skip when what came before it (which
/// left the parser in `start`) was dropped: the rest of a cut escape
/// sequence, then the continuation bytes of a cut UTF-8 character.
pub(crate) fn resync_len(start: Vt, b: &[u8]) -> usize {
    let mut s = start;
    let mut i = 0;
    while s != Vt::Ground && i < b.len() {
        s = s.step(b[i]);
        i += 1;
    }
    while i < b.len() && b[i] & 0xc0 == 0x80 {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_escape_sequence_or_character_is_skipped_whole() {
        let seq = b"ab\x1b[12;1Hcd";
        // Cut after each byte of `ESC[12;1H`: what follows skips to "cd".
        for at in 3..9 {
            let start = Vt::Ground.advance(&seq[..at]);
            let rest = &seq[at..];
            assert_eq!(&rest[resync_len(start, rest)..], b"cd", "cut at {at}");
        }
        // Cut before ESC or after the final byte: nothing to skip.
        assert_eq!(resync_len(Vt::Ground.advance(b"ab"), b"\x1b[1mx"), 0);
        assert_eq!(resync_len(Vt::Ground.advance(b"\x1b[1m"), b"x"), 0);
        // An OSC title ends at BEL or ESC \.
        let osc = Vt::Ground.advance(b"\x1b]0;tit");
        assert_eq!(resync_len(osc, b"le\x07$ "), 3);
        assert_eq!(resync_len(osc, b"le\x1b\\$ "), 4);
        // A 3-byte character cut after its first byte.
        let euro = "€x".as_bytes();
        assert_eq!(resync_len(Vt::Ground, &euro[1..]), 2);
        // ESC ( B (charset): ends at its final byte.
        assert_eq!(resync_len(Vt::Ground.advance(b"\x1b("), b"Bok"), 1);
    }

    #[test]
    fn characters_split_between_reads_go_out_whole() {
        let mut cut = Utf8Cut::default();
        let text = "aü€😀b".as_bytes();
        // Every split point gives back the same bytes, never half a character.
        for at in 0..=text.len() {
            let mut out = cut.push(&text[..at]);
            assert!(std::str::from_utf8(&out).is_ok(), "split at {at}");
            out.extend(cut.push(&text[at..]));
            assert_eq!(out, text, "split at {at}");
        }
        // One byte at a time.
        let mut all = Vec::new();
        for b in text {
            let part = cut.push(std::slice::from_ref(b));
            assert!(std::str::from_utf8(&part).is_ok());
            all.extend(part);
        }
        assert_eq!(all, text);
    }

    #[test]
    fn invalid_bytes_pass_through() {
        let mut cut = Utf8Cut::default();
        assert_eq!(cut.push(b"a\xffb"), b"a\xffb");
        assert_eq!(cut.push(b"\x80\x80\x80\x80"), b"\x80\x80\x80\x80");
    }

    #[test]
    fn data_is_raw_and_events_are_json() {
        let InvokeResponseBody::Raw(b) = TermFrame::Data(b"x\r\n".to_vec()).body().unwrap() else {
            panic!("not raw");
        };
        assert_eq!(b, b"x\r\n");
        let InvokeResponseBody::Json(json) = TermFrame::Event(TermEvent::Closed).body().unwrap()
        else {
            panic!("not json");
        };
        assert_eq!(json, r#"{"type":"closed"}"#);
    }
}
