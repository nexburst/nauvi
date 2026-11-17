// Terminal output (#115): each session sends to its tab's own channel, raw
// bytes for the screen and JSON for the rest; `TermWriter` hands the bytes
// to xterm at most once per animation frame, a bounded amount at a time, so
// a flood of output never keeps the page from drawing or reacting to keys.

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
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
  now?: () => number;
}

const encoder = new TextEncoder();

/**
 * Queues output and writes it into xterm in frame-sized pieces: one write in
 * flight at a time, at most one per animation frame, of a size adapted so a
 * write takes about `targetMs`. While paused it only queues.
 */
export class TermWriter {
  private queue: Uint8Array[] = [];
  private queued = 0;
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
      maxBytes: 1024 * 1024,
      targetMs: 8,
      fallbackMs: 100,
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

  push(data: Uint8Array | string) {
    if (this.disposed) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.length === 0) return;
    this.queue.push(bytes);
    this.queued += bytes.length;
    this.schedule();
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
  }

  private schedule() {
    if (this.disposed || this.paused || this.inFlight || this.frame !== null || this.queued === 0) return;
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

  /** Take up to `budget` bytes off the queue, as one array. */
  private take(): Uint8Array {
    const want = Math.min(this.budget, this.queued);
    if (this.queue[0].length >= want) {
      const head = this.queue[0];
      const piece = head.length === want ? head : head.subarray(0, want);
      if (head.length === want) this.queue.shift();
      else this.queue[0] = head.subarray(want);
      this.queued -= want;
      return piece;
    }
    const out = new Uint8Array(want);
    let n = 0;
    while (n < want) {
      const head = this.queue[0];
      const k = Math.min(head.length, want - n);
      out.set(k === head.length ? head : head.subarray(0, k), n);
      n += k;
      if (k === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(k);
    }
    this.queued -= want;
    return out;
  }

  private flush() {
    if (this.disposed || this.paused || this.inFlight || this.queued === 0) return;
    const piece = this.take();
    const full = piece.length === this.budget;
    this.inFlight = true;
    const t0 = this.o.now();
    this.sink(piece, () => {
      this.inFlight = false;
      if (this.disposed) return;
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
