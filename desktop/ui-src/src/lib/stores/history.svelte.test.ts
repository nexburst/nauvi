import { describe, expect, it } from "vitest";
import { History, HISTORY_LIMIT, MERGE_MS } from "./history.svelte";
import type { Place } from "./history.svelte";

const pods = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true };
const place = (view: string, namespaces: string[] = [], name = ""): Place => ({
  view,
  namespaces,
  target: name ? { resource: pods, namespace: "demo", name } : null,
});

/** A history past its start-up restore, at `first`. */
function started(first = place("overview")): History {
  const h = new History();
  h.settle(first);
  return h;
}

const views = (h: History) => h.entries.map((p) => p.view + (p.target ? `:${p.target.name}` : ""));

describe("History", () => {
  it("replaces its only entry until the restore settles", () => {
    const h = new History();
    h.record(place("overview"));
    h.record(place("overview", ["demo"]));
    h.record(place("v1/pods", ["demo"]));
    expect(h.entries).toEqual([place("v1/pods", ["demo"])]);
    expect(h.canBack).toBe(false);
    expect(h.step(-1)).toBeNull();
    h.settle(place("v1/pods", ["demo"]));
    h.record(place("apps/v1/deployments", ["demo"]));
    expect(h.canBack).toBe(true);
    expect(h.entries).toHaveLength(2);
  });

  it("goes back and forward, and a new place drops what was ahead", () => {
    const h = started();
    h.record(place("v1/pods"));
    h.record(place("v1/pods", [], "web-1"));
    h.record(place("v1/pods", [], "web-2"));
    expect(h.step(-1)).toEqual(place("v1/pods", [], "web-1"));
    // Showing it records the same place again: nothing changes.
    h.record(place("v1/pods", [], "web-1"));
    expect(h.step(-1)).toEqual(place("v1/pods"));
    expect(h.canForward).toBe(true);
    expect(h.step(1)).toEqual(place("v1/pods", [], "web-1"));
    h.record(place("v1/services"));
    expect(views(h)).toEqual(["overview", "v1/pods", "v1/pods:web-1", "v1/services"]);
    expect(h.canForward).toBe(false);
    expect(h.step(1)).toBeNull();
  });

  it("stops at either end", () => {
    const h = started();
    expect(h.step(-1)).toBeNull();
    expect(h.step(1)).toBeNull();
    expect(h.index).toBe(0);
  });

  it("records the same place once", () => {
    const h = started();
    h.record(place("overview"));
    h.record({ ...place("overview"), namespaces: [] });
    expect(h.entries).toHaveLength(1);
  });

  it("keeps a copy, not the caller's objects", () => {
    const h = started();
    const p = place("v1/pods", ["demo"], "web-1");
    h.record(p);
    (p.namespaces as string[]).push("other");
    p.target!.name = "changed";
    expect(h.current()).toEqual(place("v1/pods", ["demo"], "web-1"));
  });

  it("merges namespace changes made close together", () => {
    const h = started(place("v1/pods"));
    h.record(place("v1/pods", ["a"]), 1000);
    h.record(place("v1/pods", ["a", "b"]), 1000 + MERGE_MS / 2);
    h.record(place("v1/pods", ["a", "b", "c"]), 1000 + MERGE_MS);
    expect(h.entries.map((p) => p.namespaces)).toEqual([[], ["a", "b", "c"]]);
    // Later, or after a step, a namespace change is its own entry.
    h.record(place("v1/pods", ["c"]), 1000 + 3 * MERGE_MS);
    expect(h.entries).toHaveLength(3);
    h.step(-1);
    h.record(place("v1/pods", ["d"]), 1000 + 3 * MERGE_MS + 1);
    expect(h.entries.map((p) => p.namespaces)).toEqual([[], ["a", "b", "c"], ["d"]]);
  });

  it("never merges a change of view or object", () => {
    const h = started(place("v1/pods"));
    h.record(place("v1/pods", ["a"]), 1000);
    h.record(place("v1/pods", ["a"], "web-1"), 1001);
    h.record(place("v1/services", ["a"]), 1002);
    expect(h.entries).toHaveLength(4);
  });

  it(`keeps at most ${HISTORY_LIMIT} entries, dropping the oldest`, () => {
    const h = started(place("view-0"));
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h.record(place(`view-${i}`));
    expect(h.entries).toHaveLength(HISTORY_LIMIT);
    expect(h.entries[0].view).toBe("view-21");
    expect(h.index).toBe(HISTORY_LIMIT - 1);
    let back = 0;
    while (h.step(-1)) back++;
    expect(back).toBe(HISTORY_LIMIT - 1);
  });

  it("forgets everything on reset and restores again", () => {
    const h = started();
    h.record(place("v1/pods"));
    h.reset();
    expect(h.entries).toEqual([]);
    expect(h.canBack).toBe(false);
    expect(h.canForward).toBe(false);
    h.record(place("overview"));
    h.record(place("v1/nodes"));
    expect(h.entries).toHaveLength(1);
    h.settle(place("v1/nodes"));
    h.record(place("v1/pods"));
    expect(views(h)).toEqual(["v1/nodes", "v1/pods"]);
  });

  it("settles once: later settles do not touch the history", () => {
    const h = started();
    h.record(place("v1/pods"));
    h.settle(place("v1/services"));
    expect(views(h)).toEqual(["overview", "v1/pods"]);
  });
});
