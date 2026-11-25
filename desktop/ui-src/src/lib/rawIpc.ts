// Bulk text as raw bytes over IPC (#115, `desktop/src/commands/raw_body.rs`):
// no JSON string escaped on one side and parsed on the other.

import { invoke } from "@tauri-apps/api/core";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The text of a raw reply (an `ArrayBuffer` of UTF-8). Tolerates a string,
 *  in case a reply ever comes as JSON. */
export function rawText(reply: ArrayBuffer | ArrayBufferView | string): string {
  return typeof reply === "string" ? reply : decoder.decode(reply);
}

/** The raw payload `<head>\n<body>` that `RawUpload` reads. `head` is one
 *  line: a newline in it would end it early, so it becomes `_`. */
export function rawUpload(head: string, body: string): Uint8Array {
  return encoder.encode(head.replace(/[\r\n]/g, "_") + "\n" + body);
}

/** Split a raw upload back into `head` and `body` (the fake backend). */
export function parseRawUpload(bytes: Uint8Array): { head: string; body: string } {
  const at = bytes.indexOf(10);
  if (at < 0) throw new Error("expected a first line with the file name");
  return { head: decoder.decode(bytes.subarray(0, at)), body: decoder.decode(bytes.subarray(at + 1)) };
}

/** `cmd_save_logs`: write `content` to Downloads as `filename`; returns the path. */
export function saveLogs(filename: string, content: string): Promise<string> {
  return invoke<string>("cmd_save_logs", rawUpload(filename, content));
}
