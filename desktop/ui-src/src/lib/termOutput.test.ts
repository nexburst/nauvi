import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOutput, TermWriter } from "./termOutput";

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
});

describe("isOutput", () => {
  it("tells raw output from events", () => {
    expect(isOutput(new ArrayBuffer(1))).toBe(true);
    expect(isOutput(new Uint8Array(1))).toBe(true);
    expect(isOutput({ type: "closed" })).toBe(false);
  });
});
