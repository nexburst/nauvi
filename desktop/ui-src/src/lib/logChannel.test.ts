import { describe, expect, it, vi } from "vitest";
import type { LogEvent } from "./bindings";
import { decodeLines, dispatchLogMessage, isRawLines, sendAck } from "./logChannel";

const raw = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("log channel messages", () => {
  it("splits a raw batch on newlines, keeping empty lines and UTF-8", () => {
    expect(decodeLines(raw("a\n\nü b"))).toEqual(["a", "", "ü b"]);
    expect(decodeLines(raw(""))).toEqual([""]);
    expect(decodeLines(new TextEncoder().encode("x\ny"))).toEqual(["x", "y"]);
  });

  it("tells raw lines from events", () => {
    expect(isRawLines(raw("x"))).toBe(true);
    expect(isRawLines({ type: "done" })).toBe(false);
  });

  it("dispatches lines and events to their handlers", () => {
    const lines: string[][] = [];
    const events: LogEvent[] = [];
    const h = {
      lines: (l: string[]) => lines.push(l),
      event: (e: LogEvent) => events.push(e),
    };
    dispatchLogMessage(raw("one\ntwo"), h);
    dispatchLogMessage({ type: "error", message: "gone" }, h);
    dispatchLogMessage({ type: "done" }, h);
    expect(lines).toEqual([["one", "two"]]);
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
  });

  it("acknowledges the bytes of each raw batch, not of events", () => {
    const acks: number[] = [];
    const h = {
      lines: () => {},
      event: () => {},
      ack: (n: number) => acks.push(n),
    };
    dispatchLogMessage(raw("one\ntwo"), h);
    dispatchLogMessage(raw("ü"), h);
    dispatchLogMessage({ type: "done" }, h);
    expect(acks).toEqual([7, 2]);
  });

  it("acknowledges a batch even when handling it throws", () => {
    const acks: number[] = [];
    const h = {
      lines: () => {
        throw new Error("render failed");
      },
      event: () => {},
      ack: (n: number) => acks.push(n),
    };
    expect(() => dispatchLogMessage(raw("abc"), h)).toThrow("render failed");
    expect(acks).toEqual([3]);
  });

  it("retries a failed ack once, then warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    await sendAck(() => (++calls === 1 ? Promise.reject(new Error("lost")) : Promise.resolve()));
    expect(calls).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    calls = 0;
    await sendAck(() => {
      calls++;
      return Promise.reject(new Error("lost"));
    });
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
