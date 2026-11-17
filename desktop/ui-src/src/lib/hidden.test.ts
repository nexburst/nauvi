import { describe, expect, it } from "vitest";
import { needsClusterLabels, runningByCluster, runningShort, runningText, setHidden, shownContexts } from "./hidden";

const ctx = (...names: string[]) => names.map((name) => ({ name }));

describe("hidden contexts", () => {
  it("leaves hidden contexts out, except the ones to keep", () => {
    const all = ctx("a", "b", "c");
    expect(shownContexts(all, []).map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(shownContexts(all, ["b", "c"]).map((c) => c.name)).toEqual(["a"]);
    expect(shownContexts(all, ["b", "c"], ["c"]).map((c) => c.name)).toEqual(["a", "c"]);
    expect(shownContexts(all, ["gone"]).map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("hides at the end and shows again", () => {
    expect(setHidden([], "a", true)).toEqual(["a"]);
    expect(setHidden(["a", "b"], "a", true)).toEqual(["b", "a"]);
    expect(setHidden(["a", "b"], "a", false)).toEqual(["b"]);
    expect(setHidden(["b"], "a", false)).toEqual(["b"]);
  });
});

describe("running per cluster", () => {
  it("counts forwards and tabs, local shells left out", () => {
    const got = runningByCluster(
      [{ cluster: "b" }, { cluster: "a" }, { cluster: "b" }],
      [
        { cluster: "a", type: "podLogs" },
        { cluster: "c", type: "terminal" },
        { cluster: "a", type: "localShell" },
      ],
    );
    expect([...got.entries()]).toEqual([
      ["a", { forwards: 1, tabs: 1 }],
      ["b", { forwards: 2, tabs: 0 }],
      ["c", { forwards: 0, tabs: 1 }],
    ]);
  });

  it("says what runs", () => {
    expect(runningText({ forwards: 0, tabs: 0 })).toBe("");
    expect(runningText({ forwards: 1, tabs: 0 })).toBe("1 port-forward");
    expect(runningText({ forwards: 2, tabs: 1 })).toBe("2 port-forwards and 1 dock tab");
    expect(runningText({ forwards: 0, tabs: 3 })).toBe("3 dock tabs");
    expect(runningShort({ forwards: 2, tabs: 1 })).toBe("2 forwards · 1 tab");
    expect(runningShort({ forwards: 1, tabs: 0 })).toBe("1 forward");
  });

  it("labels items once they span clusters or are not of the one shown", () => {
    expect(needsClusterLabels([], "a")).toBe(false);
    expect(needsClusterLabels(["a", "a"], "a")).toBe(false);
    expect(needsClusterLabels(["a", "b"], "a")).toBe(true);
    expect(needsClusterLabels(["b"], "a")).toBe(true);
  });
});
