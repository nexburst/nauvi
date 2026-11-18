import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advance, isOutput, resyncLen, skippedNotice, TermWriter, Vt } from "./termOutput";

/** A fake xterm: records writes; `finish()` calls back the one in flight
 *  after `ms` of fake time. */
function setup(opts: ConstructorParameters<typeof TermWriter>[1] = {}) {
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let clock = 0;
  const writes: Uint8Array[] = [];
  let done: (() => void) | null = null;
  const w = new TermWriter(
    (data, cb) => {
      writes.push(data);
      done = cb;
    },
    {
      raf: (cb) => {
        frames.set(++nextFrame, cb);
        return nextFrame;
      },
      cancelRaf: (id) => frames.delete(id),
      now: () => clock,
      ...opts,
    },
  );
  return {
    w,
    writes,
    /** Run the frames queued so far. */
    frame() {
      const fs = [...frames.values()];
      frames.clear();
      fs.forEach((f) => f());
    },
    finish(ms = 1) {
      clock += ms;
      const d = done;
      done = null;
      d?.();
    },
    get inFlight() {
      return done !== null;
    },
  };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("TermWriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes everything that arrived before a frame in one write", () => {
    const t = setup();
    t.w.push("a");
    t.w.push(new TextEncoder().encode("ü"));
    t.w.push("b");
    expect(t.writes).toHaveLength(0);
    t.frame();
    expect(t.writes.map(text)).toEqual(["aüb"]);
  });

  it("keeps one write in flight and caps its size", () => {
    const t = setup({ startBytes: 4, minBytes: 4, maxBytes: 4 });
    t.w.push("0123456789");
    t.frame();
    expect(t.writes.map(text)).toEqual(["0123"]);
    // No new write until xterm has parsed the last one.
    t.w.push("ab");
    t.frame();
    expect(t.writes).toHaveLength(1);
    t.finish();
    t.frame();
    t.finish();
    t.frame();
    t.finish();
    t.frame();
    expect(t.writes.map(text)).toEqual(["0123", "4567", "89ab"]);
    expect(t.w.pending).toBe(0);
  });

  it("grows the budget while writes are fast and shrinks it when slow", () => {
    const t = setup({ startBytes: 1000, minBytes: 100, maxBytes: 8000, targetMs: 8 });
    t.w.push(new Uint8Array(100_000));
    t.frame();
    t.finish(1);
    expect(t.w.budget).toBe(2000);
    t.frame();
    t.finish(1);
    expect(t.w.budget).toBe(4000);
    t.frame();
    t.finish(1);
    t.frame();
    t.finish(1);
    expect(t.w.budget).toBe(8000);
    t.frame();
    t.finish(32);
    expect(t.w.budget).toBe(2000);
    t.frame();
    t.finish(1000);
    expect(t.w.budget).toBe(500);
  });

  it("only queues while paused, in order", () => {
    const t = setup();
    t.w.pause();
    t.w.push("prompt$ ");
    t.frame();
    expect(t.writes).toHaveLength(0);
    // The note written before the queue on resume comes first.
    t.w.resume();
    t.frame();
    expect(t.writes.map(text)).toEqual(["prompt$ "]);
  });

  it("writes without frames, on a timer, when the window draws none", () => {
    const t = setup();
    t.w.push("x");
    vi.advanceTimersByTime(100);
    expect(t.writes.map(text)).toEqual(["x"]);
    // The frame that comes later finds nothing to do.
    t.finish();
    t.frame();
    expect(t.writes).toHaveLength(1);
  });

  it("drops everything once disposed", () => {
    const t = setup();
    t.w.push("x");
    t.w.dispose();
    t.frame();
    vi.advanceTimersByTime(200);
    t.w.push("y");
    expect(t.writes).toHaveLength(0);
    expect(t.w.pending).toBe(0);
  });

  it("acknowledges the session's bytes once written, not its own notes", () => {
    const acked: number[] = [];
    const t = setup({ onConsumed: (n) => acked.push(n) });
    t.w.push("note ");
    t.w.push("abc", true);
    t.frame();
    expect(acked).toEqual([]);
    t.finish();
    expect(acked).toEqual([3]);
  });

  it("past its bound drops the oldest output, acknowledges it and notes it", () => {
    const acked: number[] = [];
    const t = setup({ maxPending: 10, onConsumed: (n) => acked.push(n) });
    t.w.push("aaaaaa", true);
    t.w.push("bbbbbb", true);
    expect(acked).toEqual([6]);
    expect(t.w.pending).toBe(6);
    t.frame();
    expect(text(t.writes[0])).toBe(skippedNotice(6) + "bbbbbb");
  });

  it("never drops the rest of a chunk it started writing", () => {
    const t = setup({ startBytes: 4, minBytes: 4, maxBytes: 4, maxPending: 8 });
    // "€" is 3 bytes: the first write ends inside it.
    t.w.push("ab€\x1b[1mcd", true);
    t.frame();
    expect(t.writes.map((b) => b.length)).toEqual([4]);
    t.w.clear();
    // Overflow drops the newer whole chunk "xyz…", not the started one.
    t.w.push("x".repeat(8), true);
    t.w.push("END", true);
    for (let i = 0; i < 6; i++) {
      t.finish();
      t.frame();
    }
    const all = new TextDecoder().decode(new Uint8Array(t.writes.flatMap((b) => [...b])));
    expect(all.startsWith("ab€\x1b[1mcd")).toBe(true);
    expect(all).toContain("[… 1 KB of output skipped]");
    expect(all.endsWith("END")).toBe(true);
    expect(all).not.toContain("x");
  });

  it("Ctrl-C's clear drops what waits, with one notice, and acknowledges it", () => {
    const acked: number[] = [];
    const t = setup({ startBytes: 4, minBytes: 4, maxBytes: 4, onConsumed: (n) => acked.push(n) });
    t.w.push("0123", true);
    t.w.push("456789", true);
    t.frame();
    t.w.clear();
    expect(acked).toEqual([6]);
    t.w.push("^C\r\n$ ", true);
    t.finish();
    t.frame();
    expect(text(t.writes[1])).toBe(skippedNotice(6, true) + "^C\r\n");
    expect(skippedNotice(6, true)).toContain("[… 1 KB of output skipped at Ctrl-C]");
    expect(skippedNotice(6)).toContain("[… 1 KB of output skipped]");
    expect(skippedNotice(3 * 1024 * 1024)).toContain("[… 3.0 MB of output skipped]");
  });
});

describe("TermWriter.discard", () => {
  it("acknowledges stale output at once and notes it with the next write", () => {
    const acked: number[] = [];
    const writes: string[] = [];
    const frames: (() => void)[] = [];
    const w = new TermWriter((d, done) => (writes.push(new TextDecoder().decode(d)), done()), {
      raf: (cb) => frames.push(cb),
      cancelRaf: () => {},
      onConsumed: (n) => acked.push(n),
    });
    w.discard(new Uint8Array(2048));
    expect(acked).toEqual([2048]);
    w.push("$ ", true);
    frames.splice(0).forEach((f) => f());
    expect(writes).toEqual([skippedNotice(2048, true) + "$ "]);
  });
});

describe("cut sequences", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("skips the rest of a cut escape sequence or character", () => {
    const seq = enc("ab\x1b[12;1Hcd");
    for (let at = 3; at < 9; at++) {
      const rest = seq.subarray(at);
      const n = resyncLen(advance(Vt.Ground, seq.subarray(0, at)), rest);
      expect(new TextDecoder().decode(rest.subarray(n)), `cut at ${at}`).toBe("cd");
    }
    expect(resyncLen(advance(Vt.Ground, enc("\x1b]0;tit")), enc("le\x07$ "))).toBe(3);
    expect(resyncLen(Vt.Ground, enc("€x").subarray(1))).toBe(2);
    expect(resyncLen(Vt.Ground, enc("plain"))).toBe(0);
  });

  it("drops no tail of `ESC[12;1H` or of a 3-byte character into the screen", () => {
    const writes: string[] = [];
    const frames: (() => void)[] = [];
    const w = new TermWriter((d, done) => (writes.push(new TextDecoder().decode(d)), done()), {
      raf: (cb) => frames.push(cb),
      cancelRaf: () => {},
      maxPending: 8,
    });
    const run = () => {
      while (frames.length) frames.splice(0).forEach((f) => f());
    };
    // The older chunk ends inside the sequence; overflow drops it whole.
    w.push(enc("xxxx\x1b[12;"), true);
    w.push(enc("1Hok"), true);
    run();
    expect(writes.join("")).toBe(skippedNotice(10) + "ok");
    // Stale output after Ctrl-C ends inside "€": the next starts with its tail.
    writes.length = 0;
    const euro = enc("€");
    w.discard(new Uint8Array([0x61, euro[0]]));
    w.push(new Uint8Array([euro[1], euro[2], 0x24]), true);
    run();
    expect(writes.join("")).toBe(skippedNotice(4, true) + "$");
  });
});

describe("isOutput", () => {
  it("tells raw output from events", () => {
    expect(isOutput(new ArrayBuffer(1))).toBe(true);
    expect(isOutput(new Uint8Array(1))).toBe(true);
    expect(isOutput({ type: "closed" })).toBe(false);
  });
});
