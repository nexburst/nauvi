// Terminal output (#115): each session sends to its tab's own channel, raw
// bytes for the screen and JSON for the rest; `TermWriter` hands the bytes
// to xterm at most once per animation frame, a bounded amount at a time, so
// a flood of output never keeps the page from drawing or reacting to keys.
// The tab acknowledges what it wrote, so the backend sends at most a window
// ahead; what waits is bounded on both sides, and Ctrl-C drops it.

import { Channel } from "@tauri-apps/api/core";
import type { TermEvent, TermMessage } from "./bindings";

/** Whether a channel message is output (else a TermEvent). */
export function isOutput(m: TermMessage | ArrayBufferView): m is ArrayBuffer | ArrayBufferView {
  return m instanceof ArrayBuffer || ArrayBuffer.isView(m);
}

function bytesOf(m: ArrayBuffer | ArrayBufferView): Uint8Array {
  return m instanceof ArrayBuffer ? new Uint8Array(m) : new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
}

export interface TermHandlers {
  output(bytes: Uint8Array): void;
  event(event: TermEvent): void;
}

/** A new channel for one terminal session. */
export function termChannel(h: TermHandlers): Channel<TermMessage> {
  return new Channel<TermMessage>((m) => {
    if (isOutput(m)) h.output(bytesOf(m));
    else h.event(m);
  });
}

/** Ctrl-C as xterm sends it: typing it drops the output still waiting. */
export const INTERRUPT = "\x03";

/** "[… 12.3 MB of output skipped]" (`atInterrupt`: "… skipped at Ctrl-C") on
 *  a line of its own, like the backend's. CAN first: xterm drops an escape
 *  sequence the skipped output may have cut in half. */
export function skippedNotice(bytes: number, atInterrupt = false): string {
  const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  const why = atInterrupt ? " at Ctrl-C" : "";
  return `\x18\r\n\x1b[0m\x1b[90m[… ${size} of output skipped${why}]\x1b[0m\r\n`;
}

/** Where `TermWriter` writes: xterm's `write`, which calls `done` once it
 *  has parsed the data. */
export type TermSink = (data: Uint8Array, done: () => void) => void;

export interface WriterOptions {
  /** Bytes the first frame writes; then adapted to `targetMs` per write. */
  startBytes?: number;
  minBytes?: number;
  maxBytes?: number;
  /** How long a write may take (until xterm's callback) to leave the frame room. */
  targetMs?: number;
  /** A timer that runs the next write when no frame comes (hidden window). */
  fallbackMs?: number;
  /** The most bytes kept waiting; past it the oldest are dropped, with a notice. */
  maxPending?: number;
  /** Bytes from the session (`push(…, true)`) written or dropped: the ack. */
  onConsumed?: (bytes: number) => void;
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
  now?: () => number;
}

const encoder = new TextEncoder();

interface Chunk {
  data: Uint8Array;
  /** From the session (acknowledged), not written by the tab itself. */
  remote: boolean;
  /** Its start was written already: the rest is never dropped, so no
   *  character or escape sequence is cut. */
  started?: boolean;
}

/**
 * Queues output and writes it into xterm in frame-sized pieces: one write in
 * flight at a time, at most one per animation frame, of a size adapted so a
 * write takes about `targetMs`. While paused it only queues.
 */
export class TermWriter {
  private queue: Chunk[] = [];
  private queued = 0;
  /** Bytes dropped and not noted on the screen yet. */
  private skipped = 0;
  /** Some of them by Ctrl-C. */
  private interrupted = false;
  private paused = false;
  private inFlight = false;
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Bytes the next write takes at most. */
  budget: number;
  private readonly o: Required<WriterOptions>;

  constructor(
    private readonly sink: TermSink,
    opts: WriterOptions = {},
  ) {
    this.o = {
      startBytes: 64 * 1024,
      minBytes: 16 * 1024,
      maxBytes: 512 * 1024,
      targetMs: 8,
      fallbackMs: 100,
      maxPending: 16 * 1024 * 1024,
      onConsumed: () => {},
      raf: (cb) => requestAnimationFrame(cb),
      cancelRaf: (id) => cancelAnimationFrame(id),
      now: () => performance.now(),
      ...opts,
    };
    this.budget = this.o.startBytes;
  }

  /** Bytes waiting to be written. */
  get pending(): number {
    return this.queued;
  }

  /** Queue `data`; `remote`: it came from the session and is acknowledged. */
  push(data: Uint8Array | string, remote = false) {
    if (this.disposed) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.length === 0) return;
    this.queue.push({ data: bytes, remote });
    this.queued += bytes.length;
    // The oldest whole chunks go, never a started one nor the newest.
    let dropped = 0;
    const first = this.queue[0].started ? 1 : 0;
    while (this.queued > this.o.maxPending && this.queue.length > first + 1) {
      dropped += this.drop(this.queue.splice(first, 1)[0]);
    }
    if (dropped) this.o.onConsumed(dropped);
    this.schedule();
  }

  /** Drop what waits (Ctrl-C), but the rest of a started chunk, noting how
   *  much on the screen. */
  clear() {
    if (this.disposed) return;
    const keep = this.queue[0]?.started ? 1 : 0;
    let dropped = 0;
    for (const c of this.queue.splice(keep)) dropped += this.drop(c);
    if (dropped) {
      this.interrupted = true;
      this.o.onConsumed(dropped);
    }
    this.schedule();
  }

  /** Drop `bytes` of the session's output unseen (stale after Ctrl-C):
   *  acknowledged and counted in the notice. */
  discard(bytes: number) {
    if (this.disposed || bytes === 0) return;
    this.skipped += bytes;
    this.interrupted = true;
    this.o.onConsumed(bytes);
    this.schedule();
  }

  /** Count a dropped chunk; returns its acknowledged bytes. */
  private drop(c: Chunk): number {
    this.queued -= c.data.length;
    this.skipped += c.data.length;
    return c.remote ? c.data.length : 0;
  }

  /** Queue without writing (until `resume`). */
  pause() {
    this.paused = true;
    this.cancel();
  }

  resume() {
    this.paused = false;
    this.schedule();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.queue = [];
    this.queued = 0;
    this.skipped = 0;
  }

  private schedule() {
    if (this.disposed || this.paused || this.inFlight || this.frame !== null) return;
    if (this.queued === 0 && this.skipped === 0) return;
    const run = () => {
      this.cancel();
      this.flush();
    };
    this.frame = this.o.raf(run);
    this.timer = setTimeout(run, this.o.fallbackMs);
  }

  private cancel() {
    if (this.frame !== null) this.o.cancelRaf(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.frame = null;
    this.timer = null;
  }

  /** Take up to `budget` bytes off the queue, after a notice of what was
   *  skipped; with the acknowledged bytes among them. The rest of a started
   *  chunk goes alone first: the notice never lands inside a chunk. */
  private take(): { piece: Uint8Array; remote: number } {
    const finishing = this.queue[0]?.started === true;
    const withNotice = this.skipped > 0 && !finishing;
    const notice = withNotice ? encoder.encode(skippedNotice(this.skipped, this.interrupted)) : new Uint8Array(0);
    if (withNotice) {
      this.skipped = 0;
      this.interrupted = false;
    }
    // With a notice due, stop at the end of the started chunk.
    const upTo = finishing && this.skipped > 0 ? this.queue[0].data.length : this.queued;
    const want = Math.min(this.budget, upTo);
    const out = new Uint8Array(notice.length + want);
    out.set(notice, 0);
    let n = 0;
    let remote = 0;
    while (n < want) {
      const head = this.queue[0];
      const k = Math.min(head.data.length, want - n);
      out.set(k === head.data.length ? head.data : head.data.subarray(0, k), notice.length + n);
      n += k;
      if (head.remote) remote += k;
      if (k === head.data.length) this.queue.shift();
      else this.queue[0] = { data: head.data.subarray(k), remote: head.remote, started: true };
    }
    this.queued -= want;
    return { piece: out, remote };
  }

  private flush() {
    if (this.disposed || this.paused || this.inFlight) return;
    if (this.queued === 0 && this.skipped === 0) return;
    const { piece, remote } = this.take();
    const full = piece.length >= this.budget;
    this.inFlight = true;
    const t0 = this.o.now();
    this.sink(piece, () => {
      this.inFlight = false;
      if (this.disposed) return;
      if (remote) this.o.onConsumed(remote);
      // Only a full write says how much fits in a frame.
      if (full) this.adapt(this.o.now() - t0);
      this.schedule();
    });
  }

  private adapt(ms: number) {
    const { targetMs, minBytes, maxBytes } = this.o;
    let next = this.budget;
    if (ms < targetMs / 2) next = this.budget * 2;
    else if (ms > targetMs) next = this.budget * Math.max(0.25, targetMs / ms);
    this.budget = Math.round(Math.min(maxBytes, Math.max(minBytes, next)));
  }
}
