// The channel a log tab hands to `cmd_stream_*_logs` (#115): plain lines
// arrive as raw UTF-8 (`\n` between lines), everything else as a LogEvent.

import { Channel } from "@tauri-apps/api/core";
import type { LogEvent, LogMessage } from "./bindings";

const decoder = new TextDecoder();

/** The lines of a raw batch (the backend never sends an empty batch). */
export function decodeLines(raw: ArrayBuffer | ArrayBufferView): string[] {
  return decoder.decode(raw).split("\n");
}

/** Whether a channel message is a batch of raw lines (else a LogEvent). */
export function isRawLines(m: LogMessage | ArrayBufferView): m is ArrayBuffer | ArrayBufferView {
  return m instanceof ArrayBuffer || ArrayBuffer.isView(m);
}

export interface LogHandlers {
  lines(lines: string[]): void;
  event(event: LogEvent): void;
  /**
   * The tab got a raw batch of `bytes`: a pod stream sends at most a window
   * ahead of these (`cmd_log_ack`, #397).
   */
  ack?(bytes: number): void;
}

/** Dispatch one channel message. */
export function dispatchLogMessage(m: LogMessage, h: LogHandlers) {
  if (isRawLines(m)) {
    h.lines(decodeLines(m));
    h.ack?.(m.byteLength);
  } else h.event(m);
}

/** A new channel for one log stream. */
export function logChannel(h: LogHandlers): Channel<LogMessage> {
  return new Channel<LogMessage>((m) => dispatchLogMessage(m, h));
}
