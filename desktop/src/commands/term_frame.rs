//! What a terminal session sends to its tab (#115): one Tauri channel per
//! session (exec, attach, debug and node shells, local shells), so output
//! arrives in order and only at the tab that started it. Output, notes and
//! errors go as raw bytes (an `ArrayBuffer` in the UI, written into xterm as
//! is), the end of the session as JSON.

use serde::Serialize;
use specta::datatype::DataType;
use specta::{Type, Types};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;

/// A message about a terminal session, other than its output.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TermEvent {
    /// The shell exited, or the session was closed or detached.
    Closed,
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

/// How long a batch waits for more output after the last piece.
const BATCH_GAP: Duration = Duration::from_millis(1);
/// How long a batch waits in all after its first piece.
const BATCH_WAIT: Duration = Duration::from_millis(8);
/// The most a batch holds.
const BATCH_MAX: usize = 256 * 1024;

/// Where a terminal session writes: batches its output before it goes to
/// the tab's channel. A pod's output arrives in pieces of at most 1 KiB
/// (kube's pipe) and a PTY's in a few KiB, and each channel message costs
/// an IPC round trip in the webview, so under a flood pieces that follow
/// each other within `BATCH_GAP` go out together (up to `BATCH_WAIT` and
/// `BATCH_MAX`). A lone echo waits at most `BATCH_GAP`. Order is kept:
/// events go out after the output before them.
#[derive(Clone)]
pub(crate) struct TermOut(UnboundedSender<TermFrame>);

impl TermOut {
    pub(crate) fn new(ch: TermChannel) -> Self {
        let (tx, rx) = unbounded_channel();
        tauri::async_runtime::spawn(batch(rx, move |f| {
            // A closed tab has nobody left to read it (its session is
            // closed by the tab or with its window).
            let _ = ch.send(f);
        }));
        TermOut(tx)
    }

    /// One that goes nowhere (tests).
    #[cfg(test)]
    pub(crate) fn detached() -> Self {
        TermOut(unbounded_channel().0)
    }
}

/// Send `bytes` to the screen (nothing for none).
pub(crate) fn send_data(out: &TermOut, bytes: Vec<u8>) {
    if !bytes.is_empty() {
        let _ = out.0.send(TermFrame::Data(bytes));
    }
}

/// Tell the tab its session ended (after the output sent before).
pub(crate) fn send_closed(out: &TermOut) {
    let _ = out.0.send(TermFrame::Event(TermEvent::Closed));
}

/// Join the output pieces of `rx` into batches for `sink` (see [`TermOut`]).
async fn batch(mut rx: UnboundedReceiver<TermFrame>, sink: impl Fn(TermFrame)) {
    while let Some(frame) = rx.recv().await {
        let mut buf = match frame {
            TermFrame::Data(b) => b,
            event => {
                sink(event);
                continue;
            }
        };
        let deadline = Instant::now() + BATCH_WAIT;
        let mut after = None;
        while buf.len() < BATCH_MAX {
            let until = deadline.min(Instant::now() + BATCH_GAP);
            match tokio::time::timeout_at(until, rx.recv()).await {
                Ok(Some(TermFrame::Data(more))) => buf.extend_from_slice(&more),
                Ok(Some(event)) => {
                    after = Some(event);
                    break;
                }
                Ok(None) | Err(_) => break,
            }
        }
        sink(TermFrame::Data(buf));
        if let Some(event) = after {
            sink(event);
        }
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// What `batch` hands on: data as text, events as "<closed>".
    async fn batched(frames: Vec<TermFrame>, gap: Option<Duration>) -> Vec<String> {
        let (tx, rx) = unbounded_channel();
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_got = got.clone();
        let task = tokio::spawn(batch(rx, move |f| {
            sink_got.lock().unwrap().push(match f {
                TermFrame::Data(b) => String::from_utf8(b).unwrap(),
                TermFrame::Event(_) => "<closed>".into(),
            });
        }));
        for f in frames {
            tx.send(f).unwrap();
            if let Some(gap) = gap {
                tokio::time::sleep(gap).await;
            }
        }
        drop(tx);
        task.await.unwrap();
        let out = got.lock().unwrap().clone();
        out
    }

    fn data(s: &str) -> TermFrame {
        TermFrame::Data(s.as_bytes().to_vec())
    }

    #[tokio::test(start_paused = true)]
    async fn pieces_in_a_row_go_out_together_and_events_after_them() {
        let frames = vec![
            data("a"),
            data("b"),
            data("c"),
            TermFrame::Event(TermEvent::Closed),
        ];
        assert_eq!(batched(frames, None).await, ["abc", "<closed>"]);
    }

    #[tokio::test(start_paused = true)]
    async fn pieces_further_apart_than_the_gap_go_out_alone() {
        let frames = vec![data("a"), data("b")];
        assert_eq!(batched(frames, Some(BATCH_GAP * 3)).await, ["a", "b"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_batch_ends_at_its_size_and_time_limits() {
        let big = "x".repeat(BATCH_MAX);
        let frames = vec![data(&big), data("y")];
        assert_eq!(batched(frames, None).await, [big, "y".into()]);
        // A steady trickle, each piece within the gap: cut after BATCH_WAIT.
        let frames: Vec<_> = (0..20).map(|_| data("z")).collect();
        let out = batched(frames, Some(BATCH_GAP / 2)).await;
        assert!(out.len() > 1, "{out:?}");
        assert_eq!(out.concat(), "z".repeat(20));
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
