import { describe, expect, it } from "vitest";
import type { LogEvent } from "./bindings";
import { decodeLines, dispatchLogMessage, isRawLines } from "./logChannel";

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
    const h = { lines: (l: string[]) => lines.push(l), event: (e: LogEvent) => events.push(e) };
    dispatchLogMessage(raw("one\ntwo"), h);
    dispatchLogMessage({ type: "error", message: "gone" }, h);
    dispatchLogMessage({ type: "done" }, h);
    expect(lines).toEqual([["one", "two"]]);
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
  });
});
