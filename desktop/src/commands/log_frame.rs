//! What a log stream sends to its tab (#115): one Tauri channel per stream,
//! so messages arrive in order and only at the tab that started it (no
//! global event filtered by stream id in every tab). Plain lines go as raw
//! UTF-8 bytes (an `ArrayBuffer` in the UI), everything else as JSON.

use nauvi::TaggedLine;
use serde::Serialize;
use specta::datatype::DataType;
use specta::{Type, Types};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};

/// A message about a log stream, other than plain lines.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum LogEvent {
    /// Lines of a merged stream (a workload, all containers of a pod).
    Tagged { data: Vec<TaggedLine> },
    /// A change in which pods a merged stream follows.
    Notice(super::logs::WorkloadNotice),
    /// The stream failed.
    Error { message: String },
    /// The stream ended.
    Done,
}

/// One message on a log channel: a batch of plain lines, sent as raw UTF-8
/// joined by `\n` (log lines never hold one), or a [`LogEvent`] as JSON.
#[derive(Debug)]
pub(crate) enum LogFrame {
    Lines(Vec<u8>),
    Event(LogEvent),
}

impl LogFrame {
    pub(crate) fn lines(lines: &[String]) -> Self {
        let len = lines.iter().map(|l| l.len() + 1).sum::<usize>();
        let mut out = Vec::with_capacity(len);
        for (i, l) in lines.iter().enumerate() {
            if i > 0 {
                out.push(b'\n');
            }
            out.extend_from_slice(l.as_bytes());
        }
        LogFrame::Lines(out)
    }
}

impl IpcResponse for LogFrame {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        match self {
            LogFrame::Lines(bytes) => Ok(InvokeResponseBody::Raw(bytes)),
            LogFrame::Event(e) => e.body(),
        }
    }
}

/// The raw lines as the UI receives them (never serialized: only typed).
#[derive(Serialize)]
struct RawLines;

impl Type for RawLines {
    fn definition(_: &mut Types) -> DataType {
        specta_typescript::define("ArrayBuffer").into()
    }
}

/// A message on a log channel as the UI sees it: raw lines (`ArrayBuffer`)
/// or a `LogEvent`. Only for `bindings.ts`; the backend sends a `LogFrame`.
#[derive(Serialize, Type)]
#[serde(untagged)]
#[allow(dead_code)]
enum LogMessage {
    Lines(RawLines),
    Event(LogEvent),
}

impl Type for LogFrame {
    fn definition(types: &mut Types) -> DataType {
        LogMessage::definition(types)
    }
}

/// The channel of one log stream.
pub(crate) type LogChannel = Channel<LogFrame>;

/// Send `frame`; a closed tab has nobody left to read it (its stream is
/// stopped by the tab or with its window).
pub(crate) fn send(ch: &LogChannel, frame: LogFrame) {
    let _ = ch.send(frame);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_joined_by_newlines() {
        let LogFrame::Lines(b) = LogFrame::lines(&["a".into(), "ü b".into(), String::new()])
        else {
            panic!("not lines");
        };
        assert_eq!(b, "a\nü b\n".as_bytes());
        let LogFrame::Lines(b) = LogFrame::lines(&[]) else {
            panic!("not lines");
        };
        assert!(b.is_empty());
    }

    #[test]
    fn events_are_json_tagged_by_type() {
        let body = LogFrame::Event(LogEvent::Error {
            message: "gone".into(),
        })
        .body()
        .unwrap();
        let InvokeResponseBody::Json(json) = body else {
            panic!("not json");
        };
        assert_eq!(json, r#"{"type":"error","message":"gone"}"#);
        let InvokeResponseBody::Json(json) = LogFrame::Event(LogEvent::Done).body().unwrap() else {
            panic!("not json");
        };
        assert_eq!(json, r#"{"type":"done"}"#);
    }
}
