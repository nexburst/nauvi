//! Bulk text as raw bytes over IPC (#115), instead of a JSON string that
//! is escaped on one side and parsed on the other.
//!
//! - [`RawText`] is a command's reply: an `ArrayBuffer` in the UI, which
//!   decodes it with a `TextDecoder` (`lib/rawIpc.ts`).
//! - [`RawUpload`] is a command's whole argument: the UI sends a
//!   `Uint8Array` as the invoke payload (`lib/rawIpc.ts`), `<head>\n<body>`,
//!   where `head` is one line (a file name) and `body` the bytes.

use serde::Serialize;
use specta::datatype::DataType;
use specta::{Type, Types};
use tauri::ipc::{
    CommandArg, CommandItem, InvokeBody, InvokeError, InvokeResponseBody, IpcResponse,
};

/// UTF-8 text sent as raw bytes.
#[derive(Debug)]
pub(crate) struct RawText(pub String);

impl IpcResponse for RawText {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        tauri::ipc::Response::new(self.0.into_bytes()).body()
    }
}

/// The raw text as the UI receives it (never serialized: only typed).
#[derive(Serialize)]
struct RawBytes;

impl Type for RawBytes {
    fn definition(_: &mut Types) -> DataType {
        specta_typescript::define("ArrayBuffer").into()
    }
}

impl Type for RawText {
    fn definition(types: &mut Types) -> DataType {
        RawBytes::definition(types)
    }
}

/// A raw invoke payload `<head>\n<body>`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RawUpload {
    /// The first line, as text (invalid UTF-8 replaced).
    pub head: String,
    /// Everything after the first `\n`.
    pub body: Vec<u8>,
}

impl RawUpload {
    pub(crate) fn parse(payload: &InvokeBody) -> Result<Self, String> {
        let InvokeBody::Raw(bytes) = payload else {
            return Err("expected the text as raw bytes, got JSON".into());
        };
        let Some(at) = bytes.iter().position(|&b| b == b'\n') else {
            return Err("expected a first line with the file name".into());
        };
        Ok(RawUpload {
            head: String::from_utf8_lossy(&bytes[..at]).into_owned(),
            body: bytes[at + 1..].to_vec(),
        })
    }
}

impl<'a, R: tauri::Runtime> CommandArg<'a, R> for RawUpload {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        RawUpload::parse(command.message.payload()).map_err(InvokeError::from)
    }
}

/// Not in the generated call: the UI sends the payload itself
/// (`lib/rawIpc.ts`), so the binding takes no arguments.
impl specta::function::FunctionArg for RawUpload {
    fn to_datatype(_: &mut Types) -> Option<DataType> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upload_splits_at_the_first_newline() {
        let up =
            RawUpload::parse(&InvokeBody::Raw(b"a.log\nline 1\nline \xc3\xbc\n".to_vec())).unwrap();
        assert_eq!(up.head, "a.log");
        assert_eq!(up.body, b"line 1\nline \xc3\xbc\n");
        let empty = RawUpload::parse(&InvokeBody::Raw(b"a.log\n".to_vec())).unwrap();
        assert!(empty.body.is_empty());
    }

    #[test]
    fn an_upload_needs_raw_bytes_and_a_head() {
        let json = RawUpload::parse(&InvokeBody::Json(serde_json::json!({ "content": "x" })));
        assert!(json.unwrap_err().contains("raw bytes"));
        let headless = RawUpload::parse(&InvokeBody::Raw(b"no newline".to_vec()));
        assert!(headless.unwrap_err().contains("first line"));
    }

    #[test]
    fn raw_text_is_sent_as_bytes() {
        let InvokeResponseBody::Raw(b) = RawText("kind: Pod\nü".into()).body().unwrap() else {
            panic!("expected raw bytes");
        };
        assert_eq!(b, "kind: Pod\nü".as_bytes());
    }
}
