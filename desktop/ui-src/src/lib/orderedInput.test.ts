import { describe, expect, it } from "vitest";
import { orderedInput } from "./orderedInput";

/** A send whose calls finish when the test says so, in any order. */
function manualSend() {
  const calls: { data: string; done: () => void; fail: () => void }[] = [];
  const send = (data: string) =>
    new Promise<void>((resolve, reject) => calls.push({ data, done: resolve, fail: () => reject(new Error("gone")) }));
  return { calls, send };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("orderedInput", () => {
  it("keeps one call in flight and sends what was typed meanwhile in order", async () => {
    const { calls, send } = manualSend();
    const input = orderedInput(send);
    input("e");
    input("2");
    input("e");
    expect(calls.map((c) => c.data)).toEqual(["e"]);
    calls[0].done();
    await tick();
    expect(calls.map((c) => c.data)).toEqual(["e", "2e"]);
    input("-");
    calls[1].done();
    await tick();
    expect(calls.map((c) => c.data)).toEqual(["e", "2e", "-"]);
  });

  it("goes on after a failed call", async () => {
    const { calls, send } = manualSend();
    const input = orderedInput(send);
    input("a");
    input("b");
    calls[0].fail();
    await tick();
    expect(calls.map((c) => c.data)).toEqual(["a", "b"]);
    calls[1].done();
    await tick();
    input("c");
    expect(calls.map((c) => c.data)).toEqual(["a", "b", "c"]);
  });
});
